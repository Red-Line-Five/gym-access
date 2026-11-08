import { addDays, addMonths, todayIn } from "@gym/core";
import type { Q } from "./db.ts";

export type CellState = "paid" | "prepaid" | "unpaid" | "none";
export interface ReportRow { id: string; name: string; phone: string | null; cells: CellState[]; unpaidMonths: number }
export interface Report { months: string[]; rows: ReportRow[] }

/**
 * For each member and each of the last N months (current month last):
 *  paid     = a payment was recorded in that month
 *  prepaid  = nothing recorded that month, but an earlier payment still covers part of it
 *  unpaid   = neither
 *  none     = they were not a member yet
 */
export async function buildReport(q: Q, nMonths: number): Promise<Report> {
  const today = todayIn("Asia/Beirut");
  const thisMonth = today.slice(0, 8) + "01";
  const months = Array.from({ length: nMonths }, (_, i) => addMonths(thisMonth, i - (nMonths - 1)));
  const members = await q<{ id: string; full_name: string; phone: string | null; joined: string }>(
    "select id, full_name, phone, created_at::date::text as joined from members order by full_name");
  const pays = await q<{ member_id: string; paid_on: string; period_start: string; period_end: string }>(
    "select member_id, paid_on::text, period_start::text, period_end::text from payments where kind = 'payment'");
  const by = new Map<string, typeof pays>();
  for (const p of pays) by.set(p.member_id, [...(by.get(p.member_id) ?? []), p]);

  const rows = members.map((m) => {
    const mine = by.get(m.id) ?? [];
    const cells = months.map((start): CellState => {
      const end = addDays(addMonths(start, 1), -1);
      if (m.joined > end && !mine.some((p) => p.paid_on <= end)) return "none";
      if (mine.some((p) => p.paid_on >= start && p.paid_on <= end)) return "paid";
      if (mine.some((p) => p.period_start <= end && p.period_end >= start)) return "prepaid";
      return "unpaid";
    });
    return { id: m.id, name: m.full_name, phone: m.phone, cells, unpaidMonths: cells.filter((c) => c === "unpaid").length };
  });
  return { months, rows };
}
