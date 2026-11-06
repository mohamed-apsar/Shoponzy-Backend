/* CSV for spreadsheets. Cells that Excel/Sheets would run as formulas are prefixed with ' (CSV injection). */
export function csvCell(value) {
  const s = value instanceof Date ? value.toISOString() : String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const toCsv = (rows) => rows.map((row) => row.map(csvCell).join(",")).join("\n");

export function sendCsv(res, filename, rows) {
  res.type("text/csv").attachment(filename).send(toCsv(rows));
}

export const csvDate = (d) => (d ? new Date(d).toISOString() : "");
// Exports are capped so one request can't pull an unbounded collection into memory.
export const MAX_EXPORT_ROWS = 50_000;
