"use server";
import { revalidatePath } from "next/cache";
import { requireSession, withGym } from "@/lib/session.ts";
import { digits, readMembers, type ImportRow } from "@/lib/excel.ts";

export interface Preview {
  problem?: string;
  fresh: ImportRow[];
  duplicates: ImportRow[];
  noPhone: ImportRow[];
  done?: string;
}

export async function previewImport(_prev: Preview | null, fd: FormData): Promise<Preview> {
  const s = await requireSession();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { problem: "Choose an Excel file first.", fresh: [], duplicates: [], noPhone: [] };
  const { rows, problem } = await readMembers(await file.arrayBuffer());
  if (problem) return { problem, fresh: [], duplicates: [], noPhone: [] };
  const existing = await withGym(s, (q) => q<{ phone: string | null }>("select phone from members"));
  const known = new Set(existing.map((e) => digits(e.phone ?? "")).filter(Boolean));
  const fresh: ImportRow[] = [], duplicates: ImportRow[] = [], noPhone: ImportRow[] = [];
  for (const r of rows) {
    const d = digits(r.phone);
    if (!d) noPhone.push(r);
    else if (known.has(d)) duplicates.push(r);
    else { known.add(d); fresh.push(r); }
  }
  return { fresh, duplicates, noPhone };
}

export async function confirmImport(_prev: Preview | null, fd: FormData): Promise<Preview> {
  const s = await requireSession();
  const rows = JSON.parse(String(fd.get("rows") ?? "[]")) as ImportRow[];
  await withGym(s, async (q, gym) => {
    for (const r of rows) await q("insert into members (gym_id, full_name, phone) values ($1, $2, $3)", [gym.id, r.name, r.phone]);
  });
  revalidatePath("/members");
  return { fresh: [], duplicates: [], noPhone: [], done: `${rows.length} members added. They have no subscription yet: record a payment for each one to open the door.` };
}
