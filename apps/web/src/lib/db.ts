// Demo database: the REAL supabase/schema.sql running on PGlite (Postgres in WASM), saved in apps/web/.data.
// Every request runs as a staff user with the same row-level security the live Supabase project will have.
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addMonths, todayIn } from "@gym/core";

export const GYM_ID = "00000000-0000-0000-0000-00000000000a";
export const USERS = {
  owner: { id: "00000000-0000-0000-0000-0000000000a2", label: "Owner" },
  employee: { id: "00000000-0000-0000-0000-0000000000a1", label: "Reception" },
} as const;

const STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const NAMES = ["Elie Khoury", "Maya Haddad", "Karim Nassar", "Rita Abou Jaoude", "Georges Saade", "Nour Hamdan", "Joe Matar",
  "Lara Sleiman", "Tony Daher", "Sarah Fakhoury", "Michel Aoun", "Dina Rahme", "Charles Boutros", "Yara Zogheib"];

async function seed(db: PGlite): Promise<void> {
  const today = todayIn("Asia/Beirut");
  const first = addMonths(today.slice(0, 8) + "01", -5);
  await db.exec(`insert into gyms (id, name) values ('${GYM_ID}', 'Cedars Fitness');
    insert into staff (user_id, gym_id, role) values ('${USERS.owner.id}', '${GYM_ID}', 'owner'), ('${USERS.employee.id}', '${GYM_ID}', 'employee');`);
  // pattern per member: which of the last 5 months (oldest first) they paid
  const patterns = ["11111", "11111", "01111", "11110", "00111", "11000", "00011", "11011", "10101", "01110", "00001", "11100", "00000", "01111"];
  for (let i = 0; i < NAMES.length; i++) {
    const phone = `03${String(100000 + i * 7919).slice(0, 6)}`;
    const id = `40000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    await db.query("insert into members (id, gym_id, full_name, phone, created_at) values ($1, $2, $3, $4, $5)", [id, GYM_ID, NAMES[i], phone, `${first}T08:00:00Z`]);
    for (let k = 0; k < 5; k++) {
      if (patterns[i][k] !== "1") continue;
      const paidOn = addMonths(first, k);
      await db.query(
        `insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end, list_price_usd, lbp_rate)
         values ($1, $2, 60, $3, $3, $4, 60, 90000)`,
        [GYM_ID, id, paidOn, addMonths(paidOn, 1)],
      );
    }
  }
  await db.exec("delete from device_jobs");
  // a little credit to play with
  await db.exec(`insert into credit_entries (gym_id, member_id, amount_usd, kind, note)
    values ('${GYM_ID}', '40000000-0000-0000-0000-000000000002', 40, 'deposit', 'gift (demo)')`);
}

const g = globalThis as { __gymDb?: Promise<PGlite> };

function open(): Promise<PGlite> {
  g.__gymDb ??= (async () => {
    const dir = path.resolve(process.cwd(), ".data/pglite");
    mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    const has = await db.query<{ n: string | null }>("select to_regclass('public.gyms') as n");
    if (!has.rows[0].n) {
      await db.exec(STUBS);
      await db.exec(readFileSync(path.resolve(process.cwd(), "../../supabase/schema.sql"), "utf8"));
      await seed(db);
    }
    return db;
  })();
  return g.__gymDb;
}

export type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Run `fn` inside a transaction as this staff user (RLS applies). */
export async function asUser<T>(uid: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const db = await open();
  return db.transaction(async (tx) => {
    await tx.query("select set_config('app.uid', $1, true)", [uid]);
    await tx.exec("set local role authenticated");
    const q: Q = async (sql, params = []) => (await tx.query(sql, params)).rows as never;
    return fn(q);
  });
}
