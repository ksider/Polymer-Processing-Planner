import Papa from "papaparse";

export type ImportedRecipe = {
  name: string;
  components: Array<{ name: string; phr: number }>;
};

function normalizeCell(cell: unknown): string {
  if (cell == null) return "";
  return String(cell).trim();
}

export function parseRecipeMatrix(text: string): ImportedRecipe[] {
  const delimiter = text.includes("\t") ? "\t" : text.includes(";") ? ";" : ",";
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: true
  });
  const rows = parsed.data.map((row: string[]) => row.map((cell: string) => normalizeCell(cell)));
  if (rows.length === 0) return [];

  const headerRow = rows[0];
  const secondRow = rows.length > 1 ? rows[1] : [];
  const phrColumns: number[] = [];
  const recipeNames: string[] = [];

  const hasPhrRow = secondRow.some((cell) => cell.toLowerCase() === "phr");
  if (hasPhrRow) {
    secondRow.forEach((cell: string, idx: number) => {
      if (cell.toLowerCase() === "phr") {
        const name = normalizeCell(headerRow[idx]);
        if (name) {
          phrColumns.push(idx);
          recipeNames.push(name);
        }
      }
    });
    return buildRecipes(rows.slice(2), phrColumns, recipeNames);
  }

  const componentHeader = normalizeCell(headerRow[0]).toLowerCase();
  if (componentHeader.includes("component")) {
    headerRow.slice(1).forEach((cell: string, idx: number) => {
      const name = normalizeCell(cell);
      if (name) {
        phrColumns.push(idx + 1);
        recipeNames.push(name);
      }
    });
    return buildRecipes(rows.slice(1), phrColumns, recipeNames);
  }

  return [];
}

export function parseRecipePlainText(text: string): ImportedRecipe[] {
  const lines = text.split(/\r?\n/);
  const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (trimmed.length === 0) return [];

  const name = trimmed[0];
  const components: Array<{ name: string; phr: number }> = [];

  for (const line of trimmed.slice(1)) {
    const match = line.match(/^(.*?) {2,}(.+)$/);
    if (!match) continue;
    const component = normalizeCell(match[1]);
    const raw = normalizeCell(match[2]);
    if (!component || !raw) continue;
    const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
    const value = parseFloat(normalized);
    if (!Number.isFinite(value) || value === 0) continue;
    components.push({ name: component, phr: value });
  }

  if (components.length === 0) return [];
  return [{ name, components }];
}

function buildRecipes(rows: string[][], phrColumns: number[], recipeNames: string[]): ImportedRecipe[] {
  const recipes = recipeNames.map((name) => ({ name, components: [] as Array<{ name: string; phr: number }> }));
  for (const row of rows) {
    const component = normalizeCell(row[0]);
    if (!component) continue;
    phrColumns.forEach((col, idx) => {
      const raw = normalizeCell(row[col] ?? "");
      const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
      const value = parseFloat(normalized);
      if (!Number.isFinite(value) || value === 0) return;
      recipes[idx].components.push({ name: component, phr: value });
    });
  }
  return recipes.filter((recipe) => recipe.components.length > 0);
}
