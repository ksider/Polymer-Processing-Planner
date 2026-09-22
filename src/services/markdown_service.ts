import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-"
});

turndown.addRule("preserveSubSup", {
  filter: ["sub", "sup"],
  replacement(content, node) {
    const name = node.nodeName.toLowerCase();
    return `<${name}>${content}</${name}>`;
  }
});

turndown.addRule("tableToMarkdown", {
  filter: "table",
  replacement(_content, node) {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";

    const toCellText = (cell: Element) =>
      (cell.textContent || "")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n+/g, " ")
        .trim();

    const matrix = rows
      .map((row) => Array.from(row.querySelectorAll("th,td")).map(toCellText))
      .filter((cells) => cells.length > 0);

    if (!matrix.length) return "";

    const header = matrix[0];
    const body = matrix.slice(1);
    const cols = Math.max(1, header.length);
    const norm = (cells: string[]) => {
      const next = cells.slice(0, cols);
      while (next.length < cols) next.push("");
      return next;
    };

    const headerRow = `| ${norm(header).join(" | ")} |`;
    const separator = `| ${new Array(cols).fill("---").join(" | ")} |`;
    const bodyRows = body.map((cells) => `| ${norm(cells).join(" | ")} |`);
    return `\n\n${[headerRow, separator, ...bodyRows].join("\n")}\n\n`;
  }
});

export function htmlToMarkdown(html: string): string {
  const source = String(html || "").trim();
  if (!source) return "";
  try {
    return turndown.turndown(source).trim();
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "#";
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(value)) return value;
  return "#";
}

function sanitizeImageUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("/")) return value;
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  return "";
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/&lt;(\/?)(sub|sup|b|strong|i|em|u|s|strike|small|mark|code)&gt;/gi, "<$1$2>");
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const safe = sanitizeImageUrl(src);
    return safe ? `<img src="${escapeHtml(safe)}" alt="${alt}">` : "";
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
    const safe = escapeHtml(sanitizeUrl(href));
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

export function markdownToSafeHtml(markdown: string): string {
  const source = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!source) return "";
  const lines = source.split("\n");
  const chunks: string[] = [];
  let inList = false;
  let listClass = "";

  const closeList = () => {
    if (inList) {
      chunks.push("</ul>");
      inList = false;
      listClass = "";
    }
  };

  const isTableRow = (line: string) => /^\s*\|.+\|\s*$/.test(line);
  const isTableSeparator = (line: string) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const splitTableRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((part) => part.trim());

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = line.trim();
    if (!text) {
      closeList();
      continue;
    }

    const next = lines[i + 1]?.trim() || "";
    if (isTableRow(text) && isTableSeparator(next)) {
      closeList();
      const headerCells = splitTableRow(text);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!isTableRow(rowLine)) {
          i -= 1;
          break;
        }
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      const maxCols = Math.max(
        headerCells.length,
        ...rows.map((row) => row.length),
        1
      );
      const normalize = (cells: string[]) => {
        const nextCells = cells.slice(0, maxCols);
        while (nextCells.length < maxCols) nextCells.push("");
        return nextCells;
      };
      const thead = `<tr>${normalize(headerCells)
        .map((cell) => `<th>${renderInline(cell)}</th>`)
        .join("")}</tr>`;
      const tbody = rows
        .map((row) => `<tr>${normalize(row).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("");
      chunks.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    const heading = text.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      chunks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const checkItem = text.match(/^-\s\[( |x|X)\]\s+(.+)$/);
    if (checkItem) {
      if (!inList || listClass !== "md-checklist") {
        closeList();
        chunks.push('<ul class="md-checklist">');
        inList = true;
        listClass = "md-checklist";
      }
      const checked = checkItem[1].toLowerCase() === "x" ? " checked" : "";
      chunks.push(
        `<li><label><input type="checkbox"${checked}> <span>${renderInline(checkItem[2])}</span></label></li>`
      );
      continue;
    }

    const bullet = text.match(/^-\s+(.+)$/);
    if (bullet) {
      if (!inList || listClass !== "md-list") {
        closeList();
        chunks.push('<ul class="md-list">');
        inList = true;
        listClass = "md-list";
      }
      chunks.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    closeList();
    chunks.push(`<p>${renderInline(text)}</p>`);
  }

  closeList();
  return chunks.join("");
}
