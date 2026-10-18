(() => {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  const tsvCell = (value) => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const cellText = (cell) => {
    const source = cell.dataset.copyFrom ? document.querySelector(cell.dataset.copyFrom) : cell;
    if (!source) return "";
    const control = source instanceof HTMLInputElement || source instanceof HTMLSelectElement || source instanceof HTMLTextAreaElement
      ? source
      : source.querySelector("input, select, textarea");
    if (control instanceof HTMLInputElement) {
      if (control.type === "checkbox") return control.checked ? "Yes" : "No";
      return control.value.trim();
    }
    if (control instanceof HTMLSelectElement) return control.selectedOptions[0]?.textContent?.trim() || "";
    if (control instanceof HTMLTextAreaElement) return control.value.trim();
    return (source.innerText || source.textContent || "").replace(/\s+/g, " ").trim();
  };

  const excludedColumnIndexes = (table, rawExcluded) => {
    const excluded = new Set(String(rawExcluded || "").split(",").map(normalize).filter(Boolean));
    const header = table.tHead?.rows[0] || table.rows[0];
    if (!header) return new Set();
    return new Set([...header.cells].flatMap((cell, index) => {
      const heading = normalize(cell.textContent);
      return !heading || cell.dataset.copyExclude === "true" || excluded.has(heading) ? [index] : [];
    }));
  };

  const tableToTsv = (table, rawExcluded) => {
    const excluded = excludedColumnIndexes(table, rawExcluded);
    return [...table.rows]
      .filter((row) => row.dataset.copyExclude !== "true")
      .map((row) => [...row.cells]
        .filter((cell, index) => !excluded.has(index) && cell.dataset.copyExclude !== "true")
        .map((cell) => tsvCell(cellText(cell)))
        .join("\t"))
      .filter(Boolean)
      .join("\n");
  };

  const copyText = async (text) => {
    if (!text) throw new Error("The table is empty.");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.cssText = "position:fixed;left:-10000px;top:0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("Clipboard access was denied.");
  };

  const copyFromButton = async (button) => {
    const selector = button.dataset.copyTable;
    const scope = button.closest("dialog, main, section, article, body") || document;
    const table = selector ? scope.querySelector(selector) || document.querySelector(selector) : null;
    if (!(table instanceof HTMLTableElement)) throw new Error("The table is unavailable.");
    await copyText(tableToTsv(table, button.dataset.copyExcludeColumns || table.dataset.copyExcludeColumns));
  };

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-copy-table]");
    if (!(button instanceof HTMLButtonElement)) return;
    const icon = button.querySelector(".material-symbols-rounded");
    const originalLabel = button.dataset.copyLabel ?? button.textContent.trim();
    const originalAria = button.dataset.copyAria ?? button.getAttribute("aria-label") ?? "";
    button.dataset.copyLabel = originalLabel;
    button.dataset.copyAria = originalAria;
    try {
      await copyFromButton(button);
      if (button.dataset.copyIcon && icon) icon.textContent = "check";
      else button.textContent = "Copied";
      button.setAttribute("aria-label", "Table copied as TSV");
    } catch {
      if (button.dataset.copyIcon && icon) icon.textContent = "error";
      else button.textContent = "Copy failed";
      button.setAttribute("aria-label", "Table could not be copied");
    }
    window.setTimeout(() => {
      if (button.dataset.copyIcon && icon) icon.textContent = "content_copy";
      else button.textContent = originalLabel;
      if (originalAria) button.setAttribute("aria-label", originalAria);
      else button.removeAttribute("aria-label");
    }, 1800);
  });

  window.PolymerPlannerTableCopy = { copyText, tableToTsv };
})();
