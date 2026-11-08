import { redirect } from "next/navigation";
import { requireSession, withGym } from "@/lib/session.ts";
import { saveSettings } from "../actions.ts";
import { ll, usd } from "@/lib/format.ts";

export default async function Settings({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams;
  const s = await requireSession();
  if (s.role !== "owner") redirect("/members");
  const gym = await withGym(s, async (_q, g) => g);
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>Prices and exchange rate</h1>
      <p className="muted" style={{ margin: 0 }}>Only the owner can change these. Reception can still change the amount on a single payment.</p>
      {sp.done && <div className="flash">{sp.done}</div>}
      {sp.error && <div className="flash err">{sp.error}</div>}
      <form action={saveSettings} className="card stack">
        <div className="row" style={{ gap: 24 }}>
          <div><label htmlFor="price">Price per month (USD)</label><div><input id="price" name="price" inputMode="decimal" defaultValue={gym.price_usd} style={{ marginTop: 6 }} /></div></div>
          <div><label htmlFor="rate">LL for $1</label><div><input id="rate" name="rate" inputMode="numeric" defaultValue={gym.lbp_rate} style={{ marginTop: 6 }} /></div></div>
        </div>
        <div className="muted">The rate is saved with every payment, so changing it never changes old payments.</div>
        <div><button className="primary">Save settings</button></div>
      </form>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 20 }}><strong>What reception sees now</strong></div>
        <table>
          <thead><tr><th>Length</th><th>In dollars</th><th>In LL</th></tr></thead>
          <tbody>
            {[1, 3, 6, 12].map((k) => (
              <tr key={k} className="num"><td><strong>{k} {k === 1 ? "month" : "months"}</strong></td><td>{usd(gym.price_usd * k)}</td><td>{ll(gym.price_usd * k * gym.lbp_rate)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
