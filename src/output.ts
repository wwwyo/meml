export type OutputFormat = "json" | "csv" | "table";

export type Row = Record<string, unknown>;

// Resolve output format: explicit flag > MEML_OUTPUT env > TTY default (table) / non-TTY (json).
export function resolveFormat(flag?: OutputFormat): OutputFormat {
  if (flag) return flag;
  const env = process.env.MEML_OUTPUT?.trim().toLowerCase();
  if (env === "json" || env === "csv" || env === "table") return env;
  return process.stdout.isTTY ? "table" : "json";
}

export function formatRows(rows: Row[], format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, process.stdout.isTTY ? 2 : 0);
    case "csv":
      return toCsv(rows);
    case "table":
      return toTable(rows);
  }
}

// Emit a single command result (add/init/remove). JSON object for agents; key: value lines for humans.
export function formatResult(obj: Record<string, unknown>, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(obj, null, process.stdout.isTTY ? 2 : 0);
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const cols = columnsOf(rows);
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map(esc).join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(cell(r[c]))).join(","));
  return lines.join("\n");
}

function toTable(rows: Row[]): string {
  if (rows.length === 0) return "(0 rows)";
  const cols = columnsOf(rows);
  const widths = cols.map((c) => c.length);
  const display = rows.map((r) =>
    cols.map((c, i) => {
      const s = cell(r[c]);
      if (s.length > widths[i]!) widths[i] = s.length;
      return s;
    }),
  );
  const sep = (l: string, m: string, rgt: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + rgt;
  const fmtRow = (cells: string[]) => "│ " + cells.map((s, i) => s.padEnd(widths[i]!)).join(" │ ") + " │";
  const out = [sep("┌", "┬", "┐"), fmtRow(cols), sep("├", "┼", "┤")];
  for (const d of display) out.push(fmtRow(d));
  out.push(sep("└", "┴", "┘"));
  out.push(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
  return out.join("\n");
}

function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return cols;
}
