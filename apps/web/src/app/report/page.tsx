import Link from "next/link";
import { requireSession, withGym } from "@/lib/session.ts";
import { buildReport, type CellState } from "@/lib/report.ts";
import { monthLabel } from "@/lib/format.ts";

const LABEL: Record<CellState, [string, string]> = { paid: ["Paid", "ok"], prepaid: ["Prepaid", "warn"], unpaid: ["Not paid", "bad"], none: ["-", "gray"] };

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ months?: string; only?: string }> }) {
  const sp = await searchParams;
  const n = [2, 3, 4, 5].includes(Number(sp.months)) ? Number(sp.months) : 3;
  const s = await requireSession();
  const rep = await withGym(s, (q) => buildReport(q, n));
  const onlyUnpaid = sp.only === "unpaid";
  const rows = onlyUnpaid ? rep.rows.filter((r) => r.unpaidMonths > 0) : rep.rows;
  const cur = rep.rows.map((r) => r.cells[n - 1]);
  const count = (st: CellState) => cur.filter((c) => c === st).length;

  return (
    <div className="stack">
      <h1>Payments report</h1>
      <p className="muted" style={{ margin: 0 }}>Paid = a payment was recorded in that month. Prepaid = no payment that month, but an earlier one still covers it.</p>
      <div className="cards">
        <div className="card"><div className="muted">Paid this month</div><div className="big">{count("paid")}</div></div>
        <div className="card"><div className="muted">Prepaid this month</div><div className="big">{count("prepaid")}</div></div>
        <div className="card"><div className="muted">Not paid this month</div><div className="big">{count("unpaid")}</div></div>
      </div>
      <div className="row">
        <div className="seg">
          {[2, 3, 4, 5].map((k) => (
            <Link key={k} className="btn" href={`/report?months=${k}${onlyUnpaid ? "&only=unpaid" : ""}`}
              style={k === n ? { background: "var(--tint)", borderColor: "var(--teal)" } : undefined}>Last {k} months</Link>
          ))}
        </div>
        <Link className="btn" href={`/report?months=${n}${onlyUnpaid ? "" : "&only=unpaid"}`} style={onlyUnpaid ? { background: "var(--tint)", borderColor: "var(--teal)" } : undefined}>
          {onlyUnpaid ? "Showing: missed a month" : "Only who missed a month"}
        </Link>
        <span className="grow" />
        <a className="btn" href={`/report/csv?months=${n}`}>Download for Excel</a>
      </div>
      <div className="card scroll" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Member</th><th>Phone</th>{rep.months.map((m) => <th key={m}>{monthLabel(m)}</th>)}<th>Missed</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td><td className="num">{r.phone}</td>
                {r.cells.map((c, i) => <td key={i}><span className={`cell ${LABEL[c][1]}`}>{LABEL[c][0]}</span></td>)}
                <td className="num">{r.unpaidMonths || ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={n + 3} className="muted">Nobody missed a month.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
