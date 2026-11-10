import { getSession, withGym } from "@/lib/session.ts";
import { buildReport } from "@/lib/report.ts";
import { monthLabel } from "@/lib/format.ts";

const NAME = { paid: "Paid", prepaid: "Prepaid", unpaid: "Not paid", none: "" } as const;
const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;

export async function GET(req: Request): Promise<Response> {
  const s = await getSession();
  if (!s) return new Response("Sign in first", { status: 401 });
  const n = Math.min(5, Math.max(2, Number(new URL(req.url).searchParams.get("months")) || 3));
  const rep = await withGym(s, (q) => buildReport(q, n));
  const lines = [["Member", "Phone", ...rep.months.map(monthLabel), "Missed"].map(cell).join(",")];
  for (const r of rep.rows) lines.push([r.name, r.phone ?? "", ...r.cells.map((c) => NAME[c]), String(r.unpaidMonths)].map(cell).join(","));
  return new Response("﻿" + lines.join("\r\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="payments-report-${n}-months.csv"` },
  });
}
