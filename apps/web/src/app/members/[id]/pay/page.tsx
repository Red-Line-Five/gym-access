import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, withGym } from "@/lib/session.ts";
import { savePayment } from "@/app/actions.ts";
import { dmy, usd } from "@/lib/format.ts";
import { todayIn } from "@gym/core";
import PayForm from "./PayForm.tsx";

export default async function Pay({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const s = await requireSession();
  const data = await withGym(s, async (q, gym) => {
    const [m] = await q<{ full_name: string; phone: string | null; employee_no: number; end_date: string | null; credit_usd: string }>(
      "select full_name, phone, employee_no, end_date::text, credit_usd from member_status where id = $1", [id]);
    return { m, gym };
  });
  if (!data.m) notFound();
  const { m, gym } = data;
  const credit = Number(m.credit_usd);
  return (
    <div className="stack" style={{ maxWidth: 620 }}>
      <div><Link href="/members">&larr; Members</Link></div>
      <h1>Record payment</h1>
      <p className="muted" style={{ margin: 0 }}>{usd(gym.price_usd)} a month · $1 = {gym.lbp_rate.toLocaleString("en-US")} LL</p>
      {sp.error && <div className="flash err">{sp.error}</div>}
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{m.full_name}</div>
          <div className="muted">{m.phone} · door {m.employee_no}</div>
          {credit > 0 && <div style={{ marginTop: 8 }}><span className="pill ok">Credit on account: {usd(credit)}</span></div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted">Subscription ends</div>
          <div style={{ fontWeight: 600 }}>{m.end_date ? dmy(m.end_date) : "Never paid"}</div>
        </div>
      </div>
      <div className="card">
        <PayForm action={savePayment.bind(null, id)} name={m.full_name} priceUsd={gym.price_usd} rate={gym.lbp_rate} credit={credit} endDate={m.end_date} today={todayIn("Asia/Beirut")} />
      </div>
      {credit > 0 && <Link className="btn" href={`/members/${id}/transfer`}>Move {m.full_name}'s credit to another member</Link>}
    </div>
  );
}
