import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, withGym } from "@/lib/session.ts";
import { moveCredit } from "@/app/actions.ts";
import { usd } from "@/lib/format.ts";

export default async function Transfer({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const s = await requireSession();
  const { from, others } = await withGym(s, async (q) => {
    const [from] = await q<{ full_name: string; credit_usd: string }>("select full_name, credit_usd from member_status where id = $1", [id]);
    const others = await q<{ id: string; full_name: string; phone: string | null; credit_usd: string }>(
      "select id, full_name, phone, credit_usd from member_status where id <> $1 order by full_name", [id]);
    return { from, others };
  });
  if (!from) notFound();
  const max = Number(from.credit_usd);
  return (
    <div className="stack" style={{ maxWidth: 620 }}>
      <div><Link href={`/members/${id}/pay`}>&larr; Back to {from.full_name}'s payment</Link></div>
      <h1>Move credit to another member</h1>
      <p className="muted" style={{ margin: 0 }}>For example when someone pays in advance as a gift for a friend or family member.</p>
      {sp.error && <div className="flash err">{sp.error}</div>}
      <form className="card stack" action={moveCredit.bind(null, id)}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><div className="muted">From</div><strong>{from.full_name}</strong></div>
          <div style={{ textAlign: "right" }}><div className="muted">Credit available</div><strong className="num">{usd(max)}</strong></div>
        </div>
        <div>
          <label htmlFor="to">Move it to</label>
          <div><select id="to" name="to" required defaultValue="" style={{ width: "100%", marginTop: 6 }}>
            <option value="" disabled>Choose a member</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.full_name} · {o.phone}{Number(o.credit_usd) > 0 ? ` · credit ${usd(Number(o.credit_usd))}` : ""}</option>)}
          </select></div>
        </div>
        <div>
          <label htmlFor="amount">Amount to move (USD)</label>
          <div><input id="amount" name="amount" inputMode="decimal" defaultValue={max} required style={{ width: 200, marginTop: 6 }} /></div>
          <div className="muted" style={{ marginTop: 6 }}>Up to {usd(max)}.</div>
        </div>
        <div>
          <label htmlFor="note">Note <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <div><input id="note" name="note" placeholder="For example: gift for his brother" style={{ width: "100%", marginTop: 6 }} /></div>
        </div>
        <button className="primary" style={{ minHeight: 52 }} disabled={max <= 0}>Move credit</button>
        {max <= 0 && <div className="muted">{from.full_name} has no credit to move.</div>}
      </form>
    </div>
  );
}
