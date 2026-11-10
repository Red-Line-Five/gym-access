"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { USERS, demoMarkSent } from "@/lib/db.ts";
import { requireSession, withGym } from "@/lib/session.ts";
import { usd } from "@/lib/format.ts";

export async function login(formData: FormData): Promise<void> {
  const who = formData.get("who") === "owner" ? USERS.owner : USERS.employee;
  (await cookies()).set("uid", who.id, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/members");
}

export async function logout(): Promise<void> {
  (await cookies()).delete("uid");
  redirect("/login");
}

const num = (v: FormDataEntryValue | null): number => Number(String(v ?? "").replace(/,/g, "").trim());

function back(path: string, kind: "done" | "error", message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

export async function savePayment(memberId: string, formData: FormData): Promise<void> {
  const s = await requireSession();
  const mode = formData.get("mode");
  const currency = formData.get("currency") === "LBP" ? "LBP" : "USD";
  const received = num(formData.get("received"));
  const months = num(formData.get("months")) || 1;
  const useCredit = formData.get("useCredit") === "on";
  let message = "";
  try {
    message = await withGym(s, async (q) => {
      const [m] = await q<{ full_name: string }>("select full_name from members where id = $1", [memberId]);
      if (!m) throw new Error("Member not found");
      if (mode === "credit") {
        await q("select * from keep_credit($1, $2, $3, $4)", [memberId, received, currency, "kept as credit"]);
        return `Saved as credit for ${m.full_name}`;
      }
      const [p] = await q<{ period_end: string; discount_usd: string }>(
        "select period_end::text, discount_usd from record_payment($1, $2, $3, $4, $5)", [memberId, months, received, currency, useCredit]);
      const d = Number(p.discount_usd);
      return `Payment saved for ${m.full_name}. Door access until ${p.period_end.slice(8, 10)}/${p.period_end.slice(5, 7)}/${p.period_end.slice(0, 4)}${d > 0 ? ` (discount ${usd(d)})` : ""}`;
    });
  } catch (e) {
    back(`/members/${memberId}/pay`, "error", e instanceof Error ? e.message : "Could not save");
  }
  revalidatePath("/members");
  back("/members", "done", message);
}

export async function moveCredit(fromId: string, formData: FormData): Promise<void> {
  const s = await requireSession();
  const to = String(formData.get("to") ?? "");
  const amount = num(formData.get("amount"));
  const note = String(formData.get("note") ?? "").trim() || null;
  let message = "";
  try {
    message = await withGym(s, async (q) => {
      await q("select transfer_credit($1, $2, $3, $4)", [fromId, to, amount, note]);
      const [t] = await q<{ full_name: string }>("select full_name from members where id = $1", [to]);
      return `Moved ${usd(amount)} to ${t.full_name}`;
    });
  } catch (e) {
    back(`/members/${fromId}/transfer`, "error", e instanceof Error ? e.message : "Could not move credit");
  }
  revalidatePath("/members");
  back("/members", "done", message);
}

export async function saveSettings(formData: FormData): Promise<void> {
  const s = await requireSession();
  const price = num(formData.get("price"));
  const rate = Math.round(num(formData.get("rate")));
  try {
    if (!(price > 0) || !(rate > 0)) throw new Error("Price and rate must be above zero");
    await withGym(s, (q, gym) => q("select * from set_gym_pricing($1, $2, $3)", [gym.id, price, rate]));
  } catch (e) {
    back("/settings", "error", e instanceof Error ? e.message : "Could not save");
  }
  revalidatePath("/", "layout");
  back("/settings", "done", "Settings saved");
}

export async function closeGym(formData: FormData): Promise<void> {
  const s = await requireSession();
  const day = String(formData.get("day") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const extend = Number(formData.get("extend") ?? 0);
  let message = "";
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose the closed day");
    message = await withGym(s, async (q, gym) => {
      const [r] = await q<{ r: { notified: number; extended: number } }>("select close_gym($1, $2::date, $3, $4) as r", [gym.id, day, reason, extend]);
      return `Closed day saved. ${r.r.notified} members will get a WhatsApp message${r.r.extended ? `, ${r.r.extended} subscriptions extended by ${extend} ${extend === 1 ? "day" : "days"}` : ""}.`;
    });
  } catch (e) {
    back("/closed", "error", e instanceof Error ? e.message : "Could not save");
  }
  revalidatePath("/", "layout");
  back("/closed", "done", message);
}

export async function runReminders(): Promise<void> {
  const s = await requireSession();
  const n = await withGym(s, async (q, gym) => Number((await q<{ n: number }>("select queue_expiry_reminders($1, 2) as n", [gym.id]))[0].n));
  revalidatePath("/messages");
  back("/messages", "done", n ? `${n} reminders queued` : "No new reminders: nobody is ending in the next 2 days, or they were already reminded");
}

export async function demoSendPending(): Promise<void> {
  const s = await requireSession();
  const ids = await withGym(s, async (q) => (await q<{ id: string }>("select id from notifications where status = 'pending'")).map((r) => r.id));
  await demoMarkSent(ids);
  revalidatePath("/messages");
  back("/messages", "done", `${ids.length} messages marked as sent (demo: nothing was really sent)`);
}
