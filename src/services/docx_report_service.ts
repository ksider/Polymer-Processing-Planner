import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType
} from "docx";

type TipTapMark = {
  type?: string;
  attrs?: Record<string, unknown>;
};

type TipTapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: TipTapMark[];
  content?: TipTapNode[];
};

type DocxReportInput = {
  reportId: number;
  reportNumber: string | null;
  reportType: string;
  reportName: string;
  experimentName: string;
  description: string | null;
  executors: string | null;
  signedAt: string | null;
  signerName: string | null;
  submittedForSignatureAt: string | null;
  signatureDueAt: string | null;
  generatedAt: Date;
  document: TipTapNode;
  baseUrl: string;
};

const PAGE_WIDTH_PX = 640;
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D8D2C5" };

const nonEmpty = (value: unknown) => String(value ?? "").trim();

const headingByLevel = (level: unknown) => {
  const value = Number(level);
  if (value === 1) return HeadingLevel.HEADING_1;
  if (value === 2) return HeadingLevel.HEADING_2;
  if (value === 3) return HeadingLevel.HEADING_3;
  return HeadingLevel.HEADING_4;
};

const alignmentFrom = (value: unknown) => {
  if (value === "left") return AlignmentType.LEFT;
  if (value === "right") return AlignmentType.RIGHT;
  if (value === "center") return AlignmentType.CENTER;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  return undefined;
};

const imageAlignmentFrom = (value: unknown) => {
  if (value === "left") return AlignmentType.LEFT;
  if (value === "right") return AlignmentType.RIGHT;
  return AlignmentType.CENTER;
};

const normalizeUrl = (rawUrl: unknown, baseUrl: string) => {
  const raw = nonEmpty(rawUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const buildTextRuns = (nodes: TipTapNode[] | undefined, baseUrl: string): Array<TextRun | ExternalHyperlink> => {
  const runs: Array<TextRun | ExternalHyperlink> = [];
  (nodes ?? []).forEach((node) => {
    if (node.type === "hardBreak") {
      runs.push(new TextRun({ break: 1 }));
      return;
    }
    if (node.type !== "text") {
      runs.push(...buildTextRuns(node.content, baseUrl));
      return;
    }
    const marks = node.marks ?? [];
    const link = marks.find((mark) => mark.type === "link");
    const style = {
      bold: marks.some((mark) => mark.type === "bold"),
      italics: marks.some((mark) => mark.type === "italic"),
      strike: marks.some((mark) => mark.type === "strike"),
      underline: marks.some((mark) => mark.type === "underline") ? { type: UnderlineType.SINGLE } : undefined,
      superScript: marks.some((mark) => mark.type === "superscript"),
      subScript: marks.some((mark) => mark.type === "subscript")
    };
    const run = new TextRun({ text: node.text ?? "", ...style });
    const href = normalizeUrl(link?.attrs?.href, baseUrl);
    runs.push(href ? new ExternalHyperlink({ link: href, children: [run] }) : run);
  });
  return runs;
};

const parseImage = (src: unknown) => {
  const match = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,([a-z0-9+/=\s]+)$/i.exec(nonEmpty(src));
  if (!match) return null;
  const type = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  if (!["png", "jpg", "gif", "bmp"].includes(type)) return null;
  return { type: type as "png" | "jpg" | "gif" | "bmp", data: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
};

const imageDimensions = (data: Buffer, type: "png" | "jpg" | "gif" | "bmp") => {
  if (type === "png" && data.length >= 24) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === "gif" && data.length >= 10) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (type === "bmp" && data.length >= 26) {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  if (type === "jpg") {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 640, height: 360 };
};

const imageParagraph = (node: TipTapNode) => {
  const image = parseImage(node.attrs?.src);
  if (!image) {
    return new Paragraph({
      children: [new TextRun({ text: "Image omitted from DOCX export (only embedded PNG, JPEG, GIF and BMP are supported).", italics: true, color: "666666" })]
    });
  }
  const natural = imageDimensions(image.data, image.type);
  const rawPercent = Number.parseFloat(nonEmpty(node.attrs?.width));
  const percent = Number.isFinite(rawPercent) ? Math.min(100, Math.max(20, rawPercent)) / 100 : 0.8;
  const width = Math.max(80, Math.min(PAGE_WIDTH_PX * percent, natural.width || PAGE_WIDTH_PX));
  const height = Math.max(45, Math.round(width * ((natural.height || 360) / (natural.width || 640))));
  return new Paragraph({
    alignment: imageAlignmentFrom(node.attrs?.align),
    spacing: { before: 120, after: 120 },
    children: [new ImageRun({
      data: image.data,
      type: image.type,
      transformation: { width: Math.round(width), height }
    })]
  });
};

const paragraphFromNode = (node: TipTapNode, baseUrl: string, options?: { bullet?: number; numbered?: boolean; quote?: boolean }) => {
  const paragraphOptions = {
    children: buildTextRuns(node.content, baseUrl),
    alignment: alignmentFrom(node.attrs?.textAlign),
    spacing: { after: 100 },
    ...(options?.bullet != null ? { bullet: { level: options.bullet } } : {}),
    ...(options?.numbered ? { numbering: { reference: "report-numbering", level: 0 } } : {}),
    ...(options?.quote ? { indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "B9B2A5", space: 10 } } } : {})
  };
  return new Paragraph(paragraphOptions);
};

const cellParagraphs = (cell: TipTapNode, baseUrl: string, bold = false) => {
  const paragraphs = (cell.content ?? []).flatMap((node) => {
    if (node.type === "paragraph") return [new Paragraph({ children: buildTextRuns(node.content, baseUrl), run: bold ? { bold: true } : undefined })];
    if (node.type === "heading") return [new Paragraph({ children: buildTextRuns(node.content, baseUrl), heading: headingByLevel(node.attrs?.level), run: bold ? { bold: true } : undefined })];
    return [new Paragraph({ children: buildTextRuns(node.content, baseUrl), run: bold ? { bold: true } : undefined })];
  });
  return paragraphs.length ? paragraphs : [new Paragraph("")];
};

const tableFromNode = (node: TipTapNode, baseUrl: string) => {
  const rows = (node.content ?? []).filter((child) => child.type === "tableRow");
  const maxCells = Math.max(...rows.map((row) => row.content?.length ?? 0), 1);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER, insideHorizontal: TABLE_BORDER, insideVertical: TABLE_BORDER },
    rows: rows.map((row) => new TableRow({
      children: (row.content ?? []).map((cell) => new TableCell({
        width: { size: Math.floor(100 / maxCells), type: WidthType.PERCENTAGE },
        shading: cell.type === "tableHeader" ? { fill: "EEE9E1" } : undefined,
        children: cellParagraphs(cell, baseUrl, cell.type === "tableHeader")
      }))
    }))
  });
};

const listChildren = (node: TipTapNode, baseUrl: string, ordered: boolean, level = 0): Paragraph[] => {
  const result: Paragraph[] = [];
  (node.content ?? []).filter((item) => item.type === "listItem" || item.type === "taskItem").forEach((item) => {
    const firstParagraph = item.content?.find((child) => child.type === "paragraph") ?? { type: "paragraph", content: item.content };
    result.push(paragraphFromNode(firstParagraph, baseUrl, ordered ? { numbered: true } : { bullet: level }));
    (item.content ?? []).filter((child) => child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList")
      .forEach((child) => result.push(...listChildren(child, baseUrl, child.type === "orderedList", level + 1)));
  });
  return result;
};

const contentChildren = (nodes: TipTapNode[] | undefined, baseUrl: string): Array<Paragraph | Table> => {
  const children: Array<Paragraph | Table> = [];
  (nodes ?? []).forEach((node) => {
    if (node.type === "heading") {
      children.push(new Paragraph({ children: buildTextRuns(node.content, baseUrl), heading: headingByLevel(node.attrs?.level), spacing: { before: 240, after: 120 } }));
    } else if (node.type === "paragraph") {
      children.push(paragraphFromNode(node, baseUrl));
    } else if (node.type === "table") {
      children.push(tableFromNode(node, baseUrl));
    } else if (node.type === "image") {
      children.push(imageParagraph(node));
    } else if (node.type === "blockquote") {
      children.push(new Paragraph({ children: buildTextRuns(node.content, baseUrl), indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "B9B2A5", space: 10 } } }));
    } else if (node.type === "bulletList" || node.type === "taskList") {
      children.push(...listChildren(node, baseUrl, false));
    } else if (node.type === "orderedList") {
      children.push(...listChildren(node, baseUrl, true));
    } else if (node.type === "horizontalRule") {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "B9B2A5", space: 8 } } }));
    }
  });
  return children;
};

export async function buildReportDocx(input: DocxReportInput): Promise<Buffer> {
  const titlePage: Array<Paragraph | Table> = [
    new Paragraph({ text: "EXPERIMENT REPORT", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { before: 2500, after: 360 } }),
    new Paragraph({ text: input.reportName, alignment: AlignmentType.CENTER, spacing: { after: 520 }, run: { bold: true, size: 32 } }),
    new Paragraph({ text: `Experiment: ${input.experimentName}`, alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    new Paragraph({ text: `Report number: ${input.reportNumber || `RPT-${input.reportId}`}`, alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    new Paragraph({ text: `Template: ${input.reportType}`, alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    new Paragraph({ text: `Generated: ${input.generatedAt.toLocaleString()}`, alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    new Paragraph({ text: input.executors ? `Prepared by: ${input.executors}` : "Prepared by: —", alignment: AlignmentType.CENTER }),
    ...(input.submittedForSignatureAt ? [new Paragraph({ text: `Sent for signature: ${new Date(input.submittedForSignatureAt).toLocaleString()}`, alignment: AlignmentType.CENTER, spacing: { before: 120 } })] : []),
    ...(input.signatureDueAt ? [new Paragraph({ text: `Signature due: ${input.signatureDueAt}`, alignment: AlignmentType.CENTER, spacing: { before: 60 } })] : []),
    ...(input.description ? [new Paragraph({ text: input.description, alignment: AlignmentType.CENTER, spacing: { before: 360 } })] : []),
    new Paragraph({ children: [new PageBreak()] })
  ];

  const signatureRows = [
    ["Prepared by", input.executors || "—", "", ""],
    ["Approved by", input.signerName || "", "", input.signedAt ? new Date(input.signedAt).toLocaleDateString() : ""]
  ];
  const signOff: Array<Paragraph | Table> = [
    new Paragraph({ text: "Sign-off", heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 140 } }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER, insideHorizontal: TABLE_BORDER, insideVertical: TABLE_BORDER },
      rows: [
        new TableRow({ children: ["Role", "Name", "Signature", "Date"].map((text) => new TableCell({ shading: { fill: "EEE9E1" }, children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] })) }),
        ...signatureRows.map((row) => new TableRow({ children: row.map((text) => new TableCell({ children: [new Paragraph(String(text))] })) }))
      ]
    })
  ];

  const document = new Document({
    title: input.reportName,
    creator: input.executors || "Polymer Processing Planner",
    numbering: {
      config: [{
        reference: "report-numbering",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 260 } } } }]
      }]
    },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1080, bottom: 1080, left: 1080 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `Report #${input.reportId} · Page ` }), new TextRun({ children: [PageNumber.CURRENT] })]
          })]
        })
      },
      children: [...titlePage, ...contentChildren(input.document.content, input.baseUrl), ...signOff]
    }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}
