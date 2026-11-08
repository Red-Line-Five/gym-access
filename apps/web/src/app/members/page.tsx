import Link from "next/link";
import { requireSession, withGym } from "@/lib/session.ts";
import { dmy, usd } from "@/lib/format.ts";
import { todayIn, addDays } from "@gym/core";

interface Row { id: string; full_name: string; phone: string | null; employee_no: number; end_date: string | null; credit_usd: string }

export default async function Members({ searchParams }: { searchParams: Promise<{ q?: string; done?: string }> }) {
  const sp = await searchParams;
  const s = await requireSession();
  const rows = await withGym(s, (q) =>
    q<Row>("select id, full_name, phone, employee_no, end_date::text, credit_usd from member_status order by full_name"));
  const today = todayIn("Asia/Beirut");
  const soon = addDays(today, 2);
  const term = (sp.q ?? "").toLowerCase();
  const list = rows.filter((r) => !term || r.full_name.toLowerCase().includes(term) || (r.phone ?? "").includes(term));
  const active = rows.filter((r) => r.end_date && r.end_date >= today).length;
  const expiring = rows.filter((r) => r.end_date && r.end_date >= today && r.end_date <= soon).length;

  return (
    <div className="stack">
      {sp.done && <div className="flash">{sp.done}</div>}
      <h1>Members</h1>
      <div className="cards">
        <div className="card"><div className="muted">Active now</div><div className="big">{active}</div></div>
        <div className="card"><div className="muted">Ending in 2 days</div><div className="big">{expiring}</div></div>
        <div className="card"><div className="muted">Expired or never paid</div><div className="big">{rows.length - active}</div></div>
      </div>
      <form className="row">
        <input name="q" defaultValue={sp.q} placeholder="Search by name or phone" aria-label="Search members" style={{ width: 300 }} />
        <button>Search</button>
      </form>
      <div className="card scroll" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Ends</th><th>Credit</th><th></th></tr></thead>
          <tbody>
            {list.map((r) => {
              const credit = Number(r.credit_usd);
              const status = !r.end_date ? ["Never paid", "gray"] : r.end_date < today ? ["Expired", "bad"] : r.end_date <= soon ? ["Ends soon", "warn"] : ["Active", "ok"];
              return (
                <tr key={r.id}>
                  <td><strong>{r.full_name}</strong> <span className="muted">· door {r.employee_no}</span></td>
                  <td className="num">{r.phone}</td>
                  <td><span className={`pill ${status[1]}`}>{status[0]}</span></td>
                  <td className="num">{dmy(r.end_date)}</td>
                  <td className="num">{credit > 0 ? <span className="pill ok">{usd(credit)}</span> : <span className="muted">-</span>}</td>
                  <td style={{ textAlign: "right" }}><Link className="btn primary" href={`/members/${r.id}/pay`}>Record payment</Link></td>
                </tr>
              );
            })}
            {list.length === 0 && <tr><td colSpan={6} className="muted">No members match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
