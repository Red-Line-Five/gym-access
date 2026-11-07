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
