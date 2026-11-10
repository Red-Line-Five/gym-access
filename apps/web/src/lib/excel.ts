import ExcelJS from "exceljs";

export interface ImportRow { name: string; phone: string }

const NAME_HEADERS = ["name", "full name", "fullname", "member", "client", "الاسم", "اسم"];
const PHONE_HEADERS = ["phone", "mobile", "tel", "telephone", "number", "whatsapp", "الهاتف", "رقم"];

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "text" in v) return String(v.text).trim();
  if (typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
  return String(v).trim();
};

/** Reads the first sheet. Needs a header row with a name column and a phone column. */
export async function readMembers(buffer: ArrayBuffer): Promise<{ rows: ImportRow[]; problem?: string }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { return { rows: [], problem: "This is not an Excel (.xlsx) file." }; }
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], problem: "The file has no sheets." };
  const header = ws.getRow(1);
  let nameCol = 0, phoneCol = 0;
  header.eachCell((c, i) => {
    const h = text(c.value).toLowerCase();
    if (!nameCol && NAME_HEADERS.includes(h)) nameCol = i;
    if (!phoneCol && PHONE_HEADERS.includes(h)) phoneCol = i;
  });
  if (!nameCol || !phoneCol) return { rows: [], problem: 'Row 1 must have a "Name" column and a "Phone" column.' };
  const rows: ImportRow[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const name = text(row.getCell(nameCol).value);
    const phone = text(row.getCell(phoneCol).value);
    if (name) rows.push({ name, phone });
  });
  return { rows };
}

export const digits = (p: string): string => p.replace(/\D/g, "");
