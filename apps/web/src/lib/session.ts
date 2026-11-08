import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GYM_ID, USERS, asUser, type Q } from "./db.ts";

export interface Session { uid: string; role: "owner" | "employee"; label: string }

export async function getSession(): Promise<Session | null> {
  const uid = (await cookies()).get("uid")?.value;
  const u = Object.values(USERS).find((x) => x.id === uid);
  if (!u) return null;
  return { uid: u.id, role: u.id === USERS.owner.id ? "owner" : "employee", label: u.label };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export interface Gym { id: string; name: string; price_usd: number; lbp_rate: number }

/** Run a query function as the signed-in user, with the gym loaded. */
export async function withGym<T>(s: Session, fn: (q: Q, gym: Gym) => Promise<T>): Promise<T> {
  return asUser(s.uid, async (q) => {
    const rows = await q<{ id: string; name: string; price_usd: string; lbp_rate: number }>("select * from gyms where id = $1", [GYM_ID]);
    const r = rows[0];
    return fn(q, { id: r.id, name: r.name, price_usd: Number(r.price_usd), lbp_rate: r.lbp_rate });
  });
}
