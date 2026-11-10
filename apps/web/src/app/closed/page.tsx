import { requireSession, withGym } from "@/lib/session.ts";
import { closeGym } from "../actions.ts";
import { dmy } from "@/lib/format.ts";
import { addDays, todayIn } from "@gym/core";

export default async function Closed({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams;
  const s = await requireSession();
  const { past, phones, covered } = await withGym(s, async (q) => ({
    past: await q<{ closed_on: string; reason: string | null; extend_days: number }>("select closed_on::text, reason, extend_days from closures order by closed_on desc limit 10"),
    phones: Number((await q<{ n: string }>("select count(*) n from members where coalesce(btrim(phone), '') <> ''"))[0].n),
    covered: Number((await q<{ n: string }>("select count(*) n from member_status where end_date >= now()::date"))[0].n),
  }));
  const today = todayIn("Asia/Beirut");
  return (
    <div className="stack" style={{ maxWidth: 700 }}>
      <h1>Gym closed on a day</h1>
      <p className="muted" style={{ margin: 0 }}>One button: every member gets the WhatsApp message, and (if you choose) active subscriptions get extra days so a closed day does not cost anyone a paid day.</p>
      {sp.done && <div className="flash">{sp.done}</div>}
      {sp.error && <div className="flash err">{sp.error}</div>}
      <form action={closeGym} className="card stack">
        <div className="row" style={{ gap: 24 }}>
          <div><label htmlFor="day">Closed day</label><div><input id="day" name="day" type="date" defaultValue={addDays(today, 1)} min={today} required style={{ marginTop: 6 }} /></div></div>
          <div><label htmlFor="extend">Extend active subscriptions by</label>
            <div><select id="extend" name="extend" defaultValue="1" style={{ marginTop: 6 }}>
              <option value="0">No extension</option>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{d} {d === 1 ? "day" : "days"}</option>)}
            </select></div></div>
        </div>
        <div><label htmlFor="reason">Reason <span className="muted" style={{ fontWeight: 400 }}>(for your records)</span></label>
          <div><input id="reason" name="reason" placeholder="For example: holiday, maintenance" style={{ width: "100%", marginTop: 6 }} /></div></div>
        <div className="note ok">{phones} members with a phone number will get the message. {covered} members are active today and would be extended.</div>
        <button className="primary" style={{ minHeight: 52 }}>Mark as closed and message everyone</button>
      </form>
      {past.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: 20 }}><strong>Earlier closed days</strong></div>
          <table><thead><tr><th>Day</th><th>Reason</th><th>Extended</th></tr></thead>
            <tbody>{past.map((c) => <tr key={c.closed_on}><td className="num">{dmy(c.closed_on)}</td><td>{c.reason}</td><td>{c.extend_days ? `${c.extend_days} d` : "no"}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
