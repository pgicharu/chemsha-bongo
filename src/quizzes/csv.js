// CSV export of results.

// Formula injection: text cells starting with = + - @ tab or CR get a leading
// quote so spreadsheets do not evaluate them. Numbers are left as-is.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);

  let cell = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(cell)) {
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

// Starts with a BOM so Excel reads the file as UTF-8.
export function toCsv(columns, rows) {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// Only [a-z0-9-] survive, so the name is safe in Content-Disposition.
export function csvFilename(title, date = new Date()) {
  const slug =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // strip combining accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'quiz';
  const day = date.toISOString().slice(0, 10);
  return `${slug}-results-${day}.csv`;
}
