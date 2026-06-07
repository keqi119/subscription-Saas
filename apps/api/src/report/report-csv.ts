export type CsvCell = bigint | boolean | Date | number | string | null | undefined;
export type CsvRow = CsvCell[];

const UTF8_BOM = "\uFEFF";

export function toCsv(rows: CsvRow[]) {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

export function withUtf8Bom(csv: string) {
  return `${UTF8_BOM}${csv}`;
}

export function escapeCsvCell(value: unknown) {
  const cell = safeCell(value);

  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }

  return cell;
}

export function safeCell(value: unknown) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "-";
  }

  if (typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return formatDate(value);
  }

  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : "-";
  }

  return "-";
}

export function formatMoneyYuan(amountInFen: unknown) {
  const value = numericValue(amountInFen);
  return value === null ? "-" : (value / 100).toFixed(2);
}

export function formatPercent(value: unknown) {
  const numeric = numericValue(value);
  return numeric === null ? "-" : `${(numeric * 100).toFixed(2)}%`;
}

export function formatDate(value: unknown) {
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "-";
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return "-";
}

export function compactDate(value: string) {
  return formatDate(value).replace(/-/g, "");
}

function numericValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return null;
}
