import { createRequire } from "node:module";
import path from "node:path";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import type * as PdfMake from "pdfmake";
import type {
  ExecutionProtocol,
  ExecutionProtocolField,
  ExecutionProtocolLayout,
  ExecutionProtocolRun,
  ExecutionProtocolSection
} from "./execution_protocol_types.js";

const require = createRequire(import.meta.url);
const pdfmake = require("pdfmake") as typeof PdfMake;
const roboto = require("pdfmake/fonts/Roboto") as Parameters<typeof pdfmake.addFonts>[0];
const robotoDirectory = `${path.resolve(path.dirname(require.resolve("pdfmake/fonts/Roboto")), "Roboto")}${path.sep}`;
pdfmake.addFonts(roboto);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((filename) => path.resolve(filename).startsWith(robotoDirectory));

export async function renderExecutionProtocolPdf(
  protocol: ExecutionProtocol,
  layout: ExecutionProtocolLayout
): Promise<Buffer> {
  const content: Content[] = [
    titleBlock(protocol),
    metadataBlock(protocol),
    ...(protocol.warnings.length ? [warningBlock(protocol.warnings)] : []),
    ...(layout === "run-sheets" ? runSheets(protocol) : matrixTables(protocol)),
    ...referenceAppendix(protocol),
    ...recipeAppendix(protocol)
  ];
  const definition: TDocumentDefinitions = {
    pageSize: "A4",
    pageOrientation: layout === "matrix" ? "landscape" : "portrait",
    pageMargins: [28, 42, 28, 38],
    content,
    defaultStyle: { font: "Roboto", fontSize: 8.5, color: "#111827" },
    styles: {
      title: { fontSize: 18, bold: true, color: "#111827" },
      section: { fontSize: 12, bold: true, color: "#111827", margin: [0, 12, 0, 6] },
      muted: { color: "#4B5563", fontSize: 8 },
      tableHeader: { bold: true, color: "#111827", fillColor: "#E5E7EB", fontSize: 7.5 },
      label: { bold: true, color: "#374151", fontSize: 8 }
    },
    watermark: protocol.isDraft
      ? { text: "DRAFT", color: "#DC2626", opacity: 0.08, bold: true }
      : undefined,
    footer: (currentPage, pageCount) => ({
      margin: [28, 8, 28, 0],
      columns: [
        { text: `Plan revision ${protocol.revisionFingerprint}`, style: "muted" },
        { text: `Page ${currentPage} of ${pageCount}`, alignment: "right", style: "muted" }
      ]
    }),
    info: {
      title: `${protocol.experimentName} — ${protocol.entityName} execution protocol`,
      subject: protocol.protocolTitle,
      keywords: "experiment, qualification, DOE, execution protocol",
      creator: "IM Planner"
    }
  };
  return pdfmake.createPdf(definition).getBuffer();
}

export const renderDoeExecutionProtocolPdf = renderExecutionProtocolPdf;

function titleBlock(protocol: ExecutionProtocol): Content {
  return {
    columns: [
      {
        stack: [
          { text: protocol.protocolTitle, style: "title" },
          { text: protocol.experimentName, fontSize: 12, bold: true, margin: [0, 3, 0, 0] },
          { text: protocol.entityName, fontSize: 10, color: "#374151", margin: [0, 2, 0, 0] }
        ]
      },
      protocol.isDraft
        ? { text: "DRAFT — INCOMPLETE PLAN", alignment: "right", bold: true, color: "#B91C1C", fontSize: 10 }
        : { text: "READY FOR EXECUTION", alignment: "right", bold: true, color: "#047857", fontSize: 9 }
    ],
    margin: [0, 0, 0, 10]
  };
}

function metadataBlock(protocol: ExecutionProtocol): Content {
  const generated = new Date(protocol.generatedAt);
  const generatedText = Number.isNaN(generated.getTime())
    ? protocol.generatedAt
    : generated.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return {
    table: {
      widths: [72, "*", 72, "*"],
      body: [
        [labelCell(protocol.descriptorLabel), valueCell(protocol.descriptorValue), labelCell("Plan revision"), valueCell(protocol.revisionFingerprint)],
        [labelCell("Process"), valueCell(protocol.processName || "—"), labelCell("Machine"), valueCell(protocol.machineName || "—")],
        [labelCell("Runs"), valueCell(String(protocol.runs.length)), labelCell("Generated"), valueCell(generatedText)]
      ]
    },
    layout: "lightHorizontalLines",
    margin: [0, 0, 0, 8]
  };
}

function warningBlock(warnings: string[]): Content {
  return {
    stack: [
      { text: "Plan check", bold: true, color: "#92400E", margin: [0, 0, 0, 3] },
      ...warnings.map((warning) => ({ text: `• ${warning}`, color: "#78350F" }))
    ],
    fillColor: "#FEF3C7",
    margin: [0, 4, 0, 8]
  };
}

type MatrixField = { kind: "planned" | "recorded" | "calculated"; field: ExecutionProtocolField };

function matrixTables(protocol: ExecutionProtocol): Content[] {
  let tableIndex = 0;
  return effectiveSections(protocol).flatMap((section): Content[] => {
    const fields = matrixFields(section);
    const showReference = Boolean(section.runReferenceLabel);
    const chunks = splitMatrixFieldsByWidth(fields, section.runs, showReference);
    return chunks.flatMap((fieldChunk, chunkIndex): Content[] => {
      const header: TableCell[] = [headerCell("Run")];
      if (showReference) header.push(headerCell(section.runReferenceLabel));
      for (const item of fieldChunk) {
        header.push(headerCell(
          wrapLongText(fieldLabel(item.field)),
          item.kind === "recorded" ? "#DBEAFE" : item.kind === "calculated" ? "#F3E8FF" : "#E5E7EB"
        ));
      }
      header.push(headerCell("Deviation / comments"));
      const body: TableCell[][] = [header];
      for (const run of section.runs) {
        const row: TableCell[] = [{ text: wrapLongText(run.runCode), bold: true, margin: [2, 5, 2, 5] }];
        if (showReference) row.push({ text: wrapLongText(run.referenceValue || "—"), margin: [2, 5, 2, 5] });
        row.push(...fieldChunk.map(({ kind, field }): TableCell => ({
          text: wrapLongText(kind === "planned"
            ? run.plannedValues[field.key] || "—"
            : kind === "recorded"
              ? run.recordedValues[field.key] || " "
              : run.calculatedValues[field.key] || "Planner"),
          margin: [2, 5, 2, 5],
          fontSize: field.fieldType === "text" || field.fieldType === "tag" ? 7 : 8,
          color: kind === "planned" && !run.plannedValues[field.key] ? "#B91C1C" : "#111827"
        })));
        row.push({ text: " ", margin: [2, 5, 2, 5] });
        body.push(row);
      }
      const fieldWidths = fieldChunk.map((item) => matrixFieldWidth(item, section.runs));
      const heading = chunks.length > 1
        ? `${section.title} — table ${chunkIndex + 1} of ${chunks.length}`
        : section.title;
      const headingBlock: Content[] = [{
        text: heading,
        style: "section",
        pageBreak: tableIndex++ > 0 ? "before" : undefined
      }];
      if (section.description) {
        headingBlock.push({ text: section.description, color: "#4B5563", margin: [0, -2, 0, 6] });
      }
      return [
        ...headingBlock,
        {
          table: {
            headerRows: 1,
            widths: [50, ...(showReference ? [72] : []), ...fieldWidths, 106],
            body,
            dontBreakRows: true
          },
          layout: matrixBorderLayout()
        }
      ];
    });
  });
}

function runSheets(protocol: ExecutionProtocol): Content[] {
  let sheetIndex = 0;
  return effectiveSections(protocol).flatMap((section): Content[] => section.runs.flatMap((run): Content[] => {
    const plannedBody: TableCell[][] = [[headerCell("Planned condition"), headerCell("Value")]];
    for (const field of section.plannedFields) {
      plannedBody.push([
        { text: wrapLongText(fieldLabel(field)), margin: [3, 4, 3, 4] },
        { text: wrapLongText(run.plannedValues[field.key] || "—"), margin: [3, 4, 3, 4] }
      ]);
    }
    const recordedBody: TableCell[][] = [[headerCell("Measured response", "#DBEAFE"), headerCell("Recorded value", "#DBEAFE")]];
    for (const field of section.recordedFields) {
      recordedBody.push([
        { text: wrapLongText(fieldLabel(field)), margin: [3, 5, 3, 5] },
        { text: wrapLongText(run.recordedValues[field.key] || " "), margin: [3, 5, 3, 5] }
      ]);
    }
    const calculatedBody: TableCell[][] = [[headerCell("Calculated field", "#F3E8FF"), headerCell("Planner value", "#F3E8FF")]];
    for (const field of section.calculatedFields) {
      calculatedBody.push([
        { text: wrapLongText(fieldLabel(field)), margin: [3, 5, 3, 5] },
        { text: wrapLongText(run.calculatedValues[field.key] || "Planner"), margin: [3, 5, 3, 5] }
      ]);
    }
    return [
      {
        text: `${section.title} — run ${run.runCode}`,
        style: "section",
        pageBreak: sheetIndex++ > 0 ? "before" : undefined
      },
      ...(section.description ? [{ text: section.description, color: "#4B5563", margin: [0, -2, 0, 6] } as Content] : []),
      {
        columns: section.runReferenceLabel
          ? [
              { text: [{ text: "Run order: ", bold: true }, String(run.runOrder)] },
              { text: [{ text: `${section.runReferenceLabel}: `, bold: true }, wrapLongText(run.referenceValue || "—")], alignment: "right" }
            ]
          : [{ text: [{ text: "Run order: ", bold: true }, String(run.runOrder)] }],
        margin: [0, 0, 0, 8]
      },
      ...(section.plannedFields.length ? [tableContent(plannedBody)] : []),
      { text: "Measurements", style: "section" },
      section.recordedFields.length
        ? tableContent(recordedBody)
        : { text: "No active measured responses are configured.", italics: true, color: "#6B7280" },
      ...(section.calculatedFields.length
        ? [{ text: "Calculated in Planner", style: "section" } as Content, tableContent(calculatedBody)]
        : []),
      { text: "Deviation / comments", style: "section" },
      {
        table: { widths: ["*"], heights: [58], body: [[{ text: " " }]] },
        layout: simpleBorderLayout()
      },
      { text: "Execution sign-off", style: "section" },
      {
        table: {
          widths: ["*", "*", "*"],
          heights: [30],
          body: [[
            { text: "Performed by:\n", margin: [3, 3, 3, 3] },
            { text: "Date / time:\n", margin: [3, 3, 3, 3] },
            { text: "Signature:\n", margin: [3, 3, 3, 3] }
          ]]
        },
        layout: simpleBorderLayout()
      }
    ];
  }));
}

function referenceAppendix(protocol: ExecutionProtocol): Content[] {
  if (!protocol.referenceSections.length) return [];
  const content: Content[] = [{ text: "Execution instructions", style: "section", pageBreak: "before" }];
  for (const section of protocol.referenceSections) {
    content.push({ text: section.title, bold: true, fontSize: 10, margin: [0, 8, 0, 3] });
    for (const paragraph of section.paragraphs ?? []) {
      content.push({ text: paragraph, color: "#374151", margin: [0, 0, 0, 4] });
    }
    if (section.items?.length) {
      content.push({ ul: section.items, margin: [12, 0, 0, 6] });
    }
  }
  return content;
}

function recipeAppendix(protocol: ExecutionProtocol): Content[] {
  if (!protocol.recipes.length) return [];
  const content: Content[] = [{ text: "Recipe appendix", style: "section", pageBreak: "before" }];
  for (const recipe of protocol.recipes) {
    content.push({ text: recipe.name, bold: true, fontSize: 10, margin: [0, 8, 0, 3] });
    if (recipe.description) content.push({ text: recipe.description, color: "#4B5563", margin: [0, 0, 0, 4] });
    if (recipe.components.length) {
      content.push({
        table: {
          headerRows: 1,
          widths: ["*", 72],
          body: [
            [headerCell("Component"), headerCell("phr")],
            ...recipe.components.map((component): TableCell[] => [
              { text: component.name },
              { text: Number(component.phr.toFixed(4)).toString(), alignment: "right" }
            ])
          ]
        },
        layout: "lightHorizontalLines"
      });
    } else {
      content.push({ text: "No components recorded.", italics: true, color: "#6B7280" });
    }
  }
  return content;
}

function tableContent(body: TableCell[][]): Content {
  return {
    table: { headerRows: 1, widths: ["*", "*"], body },
    layout: simpleBorderLayout()
  };
}

function simpleBorderLayout() {
  return {
    hLineColor: () => "#9CA3AF",
    vLineColor: () => "#9CA3AF",
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5
  };
}

function matrixBorderLayout() {
  return {
    ...simpleBorderLayout(),
    paddingLeft: () => 2,
    paddingRight: () => 2,
    paddingTop: () => 2,
    paddingBottom: () => 2
  };
}

function headerCell(text: string, fillColor = "#E5E7EB"): TableCell {
  return { text, style: "tableHeader", fillColor, margin: [2, 4, 2, 4] };
}

function labelCell(text: string): TableCell {
  return { text, style: "label", fillColor: "#F3F4F6", margin: [3, 3, 3, 3] };
}

function valueCell(text: string): TableCell {
  return { text, margin: [3, 3, 3, 3] };
}

function fieldLabel(field: ExecutionProtocolField) {
  return field.unit ? `${field.label}\n(${field.unit})` : field.label;
}

function effectiveSections(protocol: ExecutionProtocol): ExecutionProtocolSection[] {
  return protocol.sections?.length
    ? protocol.sections
    : [{
        key: "runs",
        title: "Run matrix",
        runReferenceLabel: protocol.runReferenceLabel,
        plannedFields: protocol.plannedFields,
        recordedFields: protocol.recordedFields,
        calculatedFields: protocol.calculatedFields,
        runs: protocol.runs
      }];
}

function matrixFields(section: ExecutionProtocolSection): MatrixField[] {
  return [
    ...section.plannedFields.map((field): MatrixField => ({ kind: "planned", field })),
    ...section.recordedFields.map((field): MatrixField => ({ kind: "recorded", field })),
    ...section.calculatedFields.map((field): MatrixField => ({ kind: "calculated", field }))
  ];
}

function splitMatrixFieldsByWidth(
  fields: MatrixField[],
  runs: ExecutionProtocolRun[],
  showReference: boolean
): MatrixField[][] {
  if (!fields.length) return [[]];
  // A4 landscape content width is about 786 pt with the configured margins.
  // Run, optional reference and comments use fixed widths; field columns share
  // the remainder without being compressed below a readable wrapped width.
  const fieldBudget = 786 - 50 - 106 - (showReference ? 72 : 0);
  const chunks: MatrixField[][] = [];
  let current: MatrixField[] = [];
  let currentWidth = 0;
  for (const field of fields) {
    const width = matrixFieldWidth(field, runs);
    if (current.length && currentWidth + width > fieldBudget) {
      chunks.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(field);
    currentWidth += width;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function matrixFieldWidth(item: MatrixField, runs: ExecutionProtocolRun[]) {
  const values = runs.map((run) => item.kind === "planned"
    ? run.plannedValues[item.field.key]
    : item.kind === "recorded"
      ? run.recordedValues[item.field.key]
      : run.calculatedValues[item.field.key]);
  const longestValue = Math.max(0, ...values.map((value) => String(value || "").length));
  const longestLabelWord = Math.max(0, ...item.field.label.split(/[\s/\-–—]+/).map((word) => word.length));
  const typeMinimum = item.field.fieldType === "text" || item.field.fieldType === "tag"
    ? 104
    : item.field.fieldType === "boolean"
      ? 76
      : 68;
  return Math.min(124, Math.max(typeMinimum, longestLabelWord * 4.2 + 12, Math.min(longestValue * 3.8 + 12, 112)));
}

function wrapLongText(value: string) {
  return String(value)
    .replace(/([/_])/g, "$1\u200B")
    .replace(/([A-Za-zА-Яа-я])([\-–—])(?=[A-Za-zА-Яа-я])/g, "$1$2\u200B")
    .replace(/(\S{22})(?=\S)/g, "$1\u200B");
}
