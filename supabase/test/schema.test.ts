import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Runs schema.sql on a real PostgreSQL (PGlite = Postgres compiled to WASM), with stand-ins for
// the Supabase pieces the schema relies on: the roles and auth.uid().

const STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const GYM_A = "00000000-0000-0000-0000-00000000000a";
const GYM_B = "00000000-0000-0000-0000-00000000000b";
const STAFF_A = "00000000-0000-0000-0000-0000000000a1";
const STAFF_B = "00000000-0000-0000-0000-0000000000b1";

let db: PGlite;

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asStaff(uid: string, fn: () => Promise<void>): Promise<void> {
  await db.exec(`select set_config('app.uid', '${uid}', false); set role authenticated;`);
  try {
    await fn();
  } finally {
    await db.exec("reset role; select set_config('app.uid', '', false);");
  }
}

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await db.exec(`
    insert into gyms (id, name) values ('${GYM_A}', 'Gym A'), ('${GYM_B}', 'Gym B');
    insert into staff (user_id, gym_id, role) values ('${STAFF_A}', '${GYM_A}', 'employee'), ('${STAFF_B}', '${GYM_B}', 'employee');
  `);
});

after(async () => {
  await db.close();
});

test("members get the next employee number per gym", async () => {
  await db.exec(`
    insert into members (id, gym_id, full_name, phone) values
      ('10000000-0000-0000-0000-000000000001', '${GYM_A}', 'Elie', '71123456'),
      ('10000000-0000-0000-0000-000000000002', '${GYM_A}', 'Maya', '03123456'),
      ('20000000-0000-0000-0000-000000000001', '${GYM_B}', 'Karim', '70123456');
  `);
  const a = await rows<{ full_name: string; employee_no: number }>("select full_name, employee_no from members where gym_id = $1 order by employee_no", [GYM_A]);
  assert.deepEqual(a.map((r) => r.employee_no), [1, 2]);
  const b = await rows<{ employee_no: number }>("select employee_no from members where gym_id = $1", [GYM_B]);
  assert.deepEqual(b.map((r) => r.employee_no), [1]); // numbering restarts per gym
});

test("a payment queues a door sync with first-start and last-end", async () => {
  const member = "10000000-0000-0000-0000-000000000001";
  await db.exec(`
    insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
      values ('${GYM_A}', '${member}', 30, '2026-11-07', '2026-11-07', '2026-12-06');
    insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
      values ('${GYM_A}', '${member}', 30, '2026-12-01', '2026-12-07', '2027-01-06');
  `);
  const jobs = await rows<{ action: string; payload: Record<string, string> }>(
    "select action, payload from device_jobs where member_id = $1 order by seq", [member]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[1].payload, { employeeNo: "1", name: "Elie", beginDate: "2026-11-07", endDate: "2027-01-06" });
});

test("claim_device_jobs hands out each job once, oldest first, and counts the attempt", async () => {
  const first = await rows<{ id: string; attempts: number; status: string; payload: Record<string, string> }>(
    "select * from claim_device_jobs($1, 10)", [GYM_A]);
  // Elie has two queued updates (employee 1). Only the OLDER one is handed out; the newer one waits behind it.
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);
  assert.equal(first[0].status, "running");
  assert.equal(first[0].payload.endDate, "2026-12-06");

  assert.equal((await rows("select * from claim_device_jobs($1, 10)", [GYM_A])).length, 0); // still blocked
  await db.query("update device_jobs set status = 'done' where id = $1", [first[0].id]);

  const second = await rows<{ attempts: number; payload: Record<string, string> }>("select * from claim_device_jobs($1, 10)", [GYM_A]);
  assert.equal(second.length, 1);
  assert.equal(second[0].payload.endDate, "2027-01-06");
  assert.equal(second[0].attempts, 1);

  assert.equal((await rows("select * from claim_device_jobs($1, 10)", [GYM_A])).length, 0);
  assert.equal((await rows("select * from claim_device_jobs($1, 10)", [GYM_B])).length, 0); // other gym's queue untouched
});

test("a job stuck in 'running' (agent crashed) is handed out again after 5 minutes", async () => {
  await db.exec("update device_jobs set locked_at = now() - interval '6 minutes' where status = 'running'");
  const again = await rows<{ attempts: number }>("select * from claim_device_jobs($1, 10)", [GYM_A]);
  assert.equal(again.length, 1);
  assert.equal(again[0].attempts, 2);
  await db.exec("update device_jobs set status = 'done'");
});

test("a failing older job keeps newer jobs for the same member waiting, so a stale end date can never win", async () => {
  await db.exec("begin");
  try {
    await db.exec(`
      insert into members (id, gym_id, full_name) values ('40000000-0000-0000-0000-000000000001', '${GYM_A}', 'Order test');
      insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
        values ('${GYM_A}', '40000000-0000-0000-0000-000000000001', 30, '2026-11-07', '2026-11-07', '2026-12-06');
      insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
        values ('${GYM_A}', '40000000-0000-0000-0000-000000000001', 30, '2026-12-01', '2026-12-07', '2027-01-06');
    `);
    const [old] = await rows<{ id: string; payload: Record<string, string> }>("select * from claim_device_jobs($1, 10)", [GYM_A]);
    assert.equal(old.payload.endDate, "2026-12-06");
    // The agent could not reach the door: the older job goes back to pending, retry in a minute.
    await db.query("update device_jobs set status = 'pending', run_after = now() + interval '1 minute' where id = $1", [old.id]);
    assert.equal((await rows("select * from claim_device_jobs($1, 10)", [GYM_A])).length, 0); // the newer job must NOT jump the queue
    // Once the retry is due and succeeds, the newer one follows.
    await db.query("update device_jobs set run_after = now() where id = $1", [old.id]);
    const [retry] = await rows<{ id: string; payload: Record<string, string> }>("select * from claim_device_jobs($1, 10)", [GYM_A]);
    assert.equal(retry.id, old.id);
    await db.query("update device_jobs set status = 'done' where id = $1", [old.id]);
    const [newer] = await rows<{ payload: Record<string, string> }>("select * from claim_device_jobs($1, 10)", [GYM_A]);
    assert.equal(newer.payload.endDate, "2027-01-06");
  } finally {
    await db.exec("rollback");
  }
});

test("member_status computes the end date, and active follows the real clock (inside a rolled-back transaction)", async () => {
  const [maya] = await rows<{ end_date: string | null; active: boolean }>(
    "select end_date::text, active from member_status where id = '10000000-0000-0000-0000-000000000002'");
  assert.equal(maya.end_date, null); // never paid
  assert.equal(maya.active, false);

  await db.exec("begin");
  try {
    await db.exec(`
      insert into members (id, gym_id, full_name) values
        ('30000000-0000-0000-0000-000000000001', '${GYM_A}', 'Still active'),
        ('30000000-0000-0000-0000-000000000002', '${GYM_A}', 'Expired');
      insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end) values
        ('${GYM_A}', '30000000-0000-0000-0000-000000000001', 30, current_date - 20, current_date - 20, current_date + 5),
        ('${GYM_A}', '30000000-0000-0000-0000-000000000002', 30, current_date - 40, current_date - 40, current_date - 5);
    `);
    const status = await rows<{ full_name: string; active: boolean }>(
      "select full_name, active from member_status where id::text like '30000000%' order by full_name");
    assert.deepEqual(status, [
      { full_name: "Expired", active: false },
      { full_name: "Still active", active: true },
    ]);
  } finally {
    await db.exec("rollback");
  }
  const [{ n }] = await rows<{ n: number }>("select count(*)::int as n from members where id::text like '30000000%'");
  assert.equal(n, 0);
});

test("apply_closure extends everyone covered by the closed day, and only them", async () => {
  await db.exec(`
    insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
      values ('${GYM_A}', '10000000-0000-0000-0000-000000000002', 25, '2026-10-01', '2026-10-01', '2026-10-31');
  `);
  // Elie ends 2027-01-06, Maya ended 2026-10-31. Closing on 2026-12-24 should extend Elie only.
  const [{ apply_closure: n }] = await rows<{ apply_closure: number }>("select apply_closure($1, '2026-12-24', 1)", [GYM_A]);
  assert.equal(Number(n), 1);
  const [elie] = await rows<{ end_date: string }>("select end_date::text from member_status where id = '10000000-0000-0000-0000-000000000001'");
  assert.equal(elie.end_date, "2027-01-07");
  const [maya] = await rows<{ end_date: string }>("select end_date::text from member_status where id = '10000000-0000-0000-0000-000000000002'");
  assert.equal(maya.end_date, "2026-10-31");
  assert.equal(Number((await rows<{ apply_closure: number }>("select apply_closure($1, '2026-12-25', 0)", [GYM_A]))[0].apply_closure), 0);
  // the extension queued a door update for Elie with the new end date
  const [job] = await rows<{ payload: Record<string, string> }>(
    "select payload from device_jobs where member_id = '10000000-0000-0000-0000-000000000001' order by seq desc limit 1");
  assert.equal(job.payload.endDate, "2027-01-07");
});

test("the same notification cannot be recorded twice for a member and period", async () => {
  const insert = `insert into notifications (gym_id, member_id, kind, period_key)
                  values ('${GYM_A}', '10000000-0000-0000-0000-000000000001', 'subscription_expiring', '2027-01-07')`;
  await db.exec(insert);
  await assert.rejects(db.exec(insert), /duplicate key|unique/i);
});

test("a new face photo queues an upload; deleting a member queues a door delete", async () => {
  await db.exec("update members set face_path = 'gym-a/1.jpg' where id = '10000000-0000-0000-0000-000000000001'");
  const [face] = await rows<{ payload: Record<string, string> }>(
    "select payload from device_jobs where action = 'upload_face'");
  assert.deepEqual(face.payload, { employeeNo: "1", facePath: "gym-a/1.jpg" });

  await db.exec("delete from members where id = '10000000-0000-0000-0000-000000000002'");
  const [del] = await rows<{ payload: Record<string, string>; member_id: string | null }>(
    "select payload, member_id from device_jobs where action = 'delete_user'");
  assert.deepEqual(del.payload, { employeeNo: "2" });
  assert.equal(del.member_id, null);
});

test("RLS: staff see only their gym, can add payments there (job still queued), and cannot touch another gym", async () => {
  await asStaff(STAFF_A, async () => {
    const m = await rows<{ full_name: string }>("select full_name from members");
    assert.deepEqual(m.map((r) => r.full_name), ["Elie"]); // Maya deleted above, Karim is gym B
    assert.equal((await rows("select * from gyms")).length, 1);

    await db.exec(`insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
      values ('${GYM_A}', '10000000-0000-0000-0000-000000000001', 30, '2027-01-05', '2027-01-08', '2027-02-07')`);

    await assert.rejects(
      db.exec(`insert into payments (gym_id, member_id, amount, paid_on, period_start, period_end)
        values ('${GYM_B}', '20000000-0000-0000-0000-000000000001', 30, '2027-01-05', '2027-01-05', '2027-02-04')`),
      /row-level security/i,
    );
    // staff cannot write the queue directly, nor claim jobs
    await assert.rejects(db.exec(`insert into device_jobs (gym_id, action, payload) values ('${GYM_A}', 'delete_user', '{}')`), /row-level security/i);
    await assert.rejects(db.query("select * from claim_device_jobs($1, 1)", [GYM_A]), /permission denied/i);
  });

  const queued = await rows("select 1 from device_jobs where payload->>'endDate' = '2027-02-07'");
  assert.equal(queued.length, 1);

  await asStaff(STAFF_B, async () => {
    assert.deepEqual((await rows<{ full_name: string }>("select full_name from members")).map((r) => r.full_name), ["Karim"]);
  });
});

// ---------------------------------------------------------------- money / credit

const M1 = "30000000-0000-0000-0000-000000000001";
const M2 = "30000000-0000-0000-0000-000000000002";
const MB = "20000000-0000-0000-0000-000000000001"; // Karim, gym B

async function bal(id: string): Promise<number> {
  return Number((await rows<{ b: string }>("select coalesce(sum(amount_usd), 0) as b from credit_entries where member_id = $1", [id]))[0].b);
}

test("record_payment: default price, snapshot of price and rate, door job queued", async () => {
  await db.exec(`insert into members (id, gym_id, full_name) values ('${M1}', '${GYM_A}', 'Rita'), ('${M2}', '${GYM_A}', 'Georges');`);
  await asStaff(STAFF_A, async () => {
    const p = (await rows<Record<string, string>>("select * from record_payment($1, 1, 60, 'USD', true, '2026-11-08')", [M1]))[0];
    assert.equal(Number(p.list_price_usd), 60);
    assert.equal(Number(p.lbp_rate), 90000);
    assert.equal(Number(p.discount_usd), 0);
  });
  const r = (await rows<{ s: string; e: string }>("select period_start::text s, period_end::text e from payments where member_id = $1", [M1]))[0];
  assert.deepEqual(r, { s: "2026-11-08", e: "2026-12-07" });
});

test("record_payment: paying 55 is a $5 discount and still gives the full month; early renewal starts next day", async () => {
  await asStaff(STAFF_A, async () => {
    await db.query("select * from record_payment($1, 1, 55, 'USD', true, '2026-11-20')", [M1]);
  });
  const r = (await rows<{ s: string; e: string; d: string }>(
    "select period_start::text s, period_end::text e, discount_usd d from payments where member_id = $1 order by period_start desc limit 1", [M1]))[0];
  assert.deepEqual(r, { s: "2026-12-08", e: "2027-01-07", d: "5.00" });
  assert.equal(await bal(M1), 0);
});

test("overpay and 'keep as credit' both land on the member; credit is used on the next payment", async () => {
  await asStaff(STAFF_A, async () => {
    await db.query("select * from record_payment($1, 1, 80, 'USD', true, '2026-11-08')", [M2]); // $20 extra
    await db.query("select * from keep_credit($1, 900000, 'LBP', 'gift')", [M2]); // 900,000 LL = $10
  });
  assert.equal(await bal(M2), 30);
  await asStaff(STAFF_A, async () => {
    const p = (await rows<Record<string, string>>("select * from record_payment($1, 1, 30, 'USD', true, '2026-12-08')", [M2]))[0];
    assert.equal(Number(p.credit_used_usd), 30); // $30 credit + $30 cash = $60
    assert.equal(Number(p.discount_usd), 0);
  });
  assert.equal(await bal(M2), 0);
});

test("transfer_credit moves money between members and refuses overdraft, self, and other gyms", async () => {
  await asStaff(STAFF_A, async () => {
    await db.query("select * from keep_credit($1, 40, 'USD', null)", [M2]);
    await db.query("select transfer_credit($1, $2, 25, 'gift for a friend')", [M2, M1]);
  });
  assert.equal(await bal(M2), 15);
  assert.equal(await bal(M1), 25);
  await asStaff(STAFF_A, async () => {
    await assert.rejects(db.query("select transfer_credit($1, $2, 99)", [M2, M1]), /only .* of credit/);
    await assert.rejects(db.query("select transfer_credit($1, $1, 1)", [M2]), /different member/);
    await assert.rejects(db.query("select transfer_credit($1, $2, 1)", [M2, MB]), /not allowed/);
  });
  assert.equal(await bal(M2), 15);
});

test("staff of another gym cannot take payments or read credit; direct ledger writes are blocked", async () => {
  await asStaff(STAFF_B, async () => {
    await assert.rejects(db.query("select * from record_payment($1, 1, 60)", [M1]), /not allowed/);
    assert.equal((await rows("select * from credit_entries")).length, 0);
  });
  await asStaff(STAFF_A, async () => {
    await assert.rejects(db.query("insert into credit_entries (gym_id, member_id, amount_usd, kind) values ($1, $2, 999, 'deposit')", [GYM_A, M1]));
  });
});

test("credit_balance only answers for staff of that gym", async () => {
  await asStaff(STAFF_A, async () => {
    assert.equal(Number((await rows<{ b: string }>("select credit_balance($1) as b", [M1]))[0].b), 25);
  });
  await asStaff(STAFF_B, async () => {
    assert.equal(Number((await rows<{ b: string }>("select credit_balance($1) as b", [M1]))[0].b), 0);
  });
});

test("member_status shows credit", async () => {
  const r = await rows<{ credit_usd: string }>("select credit_usd from member_status where id = $1", [M1]);
  assert.equal(Number(r[0].credit_usd), 25);
});

test("only the owner can change price and rate", async () => {
  const OWNER = "00000000-0000-0000-0000-0000000000a2";
  await db.exec(`insert into staff (user_id, gym_id, role) values ('${OWNER}', '${GYM_A}', 'owner');`);
  await asStaff(STAFF_A, async () => {
    await assert.rejects(db.query("select * from set_gym_pricing($1, 50, 100000)", [GYM_A]), /only the owner/);
  });
  await asStaff(OWNER, async () => {
    const g = (await rows<{ price_usd: string; lbp_rate: number }>("select * from set_gym_pricing($1, 50, 100000)", [GYM_A]))[0];
    assert.equal(Number(g.price_usd), 50);
    assert.equal(g.lbp_rate, 100000);
  });
  await db.exec(`update gyms set price_usd = 60, lbp_rate = 90000 where id = '${GYM_A}'`);
});
