import { requireSession, withGym } from "@/lib/session.ts";
import { demoSendPending, runReminders } from "../actions.ts";

const KIND: Record<string, string> = { payment_received: "Payment receipt", subscription_expiring: "Ending soon", gym_closed: "Gym closed" };
const TONE: Record<string, string> = { pending: "warn", sent: "ok", delivered: "ok", read: "ok", failed: "bad" };

export default async function Messages({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const sp = await searchParams;
  const s = await requireSession();
  const rows = await withGym(s, (q) =>
    q<{ id: string; full_name: string; phone: string; kind: string; status: string; params: string[]; created_at: string }>(
      `select n.id, m.full_name, n.phone, n.kind, n.status, n.params, to_char(n.created_at, 'DD/MM HH24:MI') as created_at
         from notifications n join members m on m.id = n.member_id order by n.created_at desc, n.id limit 100`));
  const pending = rows.filter((r) => r.status === "pending").length;
  return (
    <div className="stack">
      <h1>WhatsApp messages</h1>
      <p className="muted" style={{ margin: 0 }}>Receipts are queued when you save a payment. Reminders go 2 days before a subscription ends. A closed day messages everyone.</p>
      {sp.done && <div className="flash">{sp.done}</div>}
      <div className="row">
        <form action={runReminders}><button>Queue reminders now</button></form>
        <form action={demoSendPending}><button disabled={pending === 0}>Demo: mark {pending} pending as sent</button></form>
        <span className="muted">In the live version a worker sends the queue through WhatsApp Business every minute. In this demo nothing leaves your PC.</span>
      </div>
      <div className="card scroll" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>When</th><th>Member</th><th>Phone</th><th>Message</th><th>Date in message</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}><td className="num">{r.created_at}</td><td><strong>{r.full_name}</strong></td><td className="num">{r.phone}</td>
                <td>{KIND[r.kind]}</td><td className="num">{r.params[2]}</td><td><span className={`pill ${TONE[r.status]}`}>{r.status}</span></td></tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No messages yet. Record a payment to see one appear.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
