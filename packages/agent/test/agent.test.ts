import assert from "node:assert/strict";
import { test } from "node:test";
import { HikvisionClient } from "@gym/hikvision";
import { MAX_ATTEMPTS, SupabaseJobStore, backoffSeconds, processJobs } from "../src/index.ts";
import type { DeviceJob, DoorDevice, FaceSource, JobStore } from "../src/index.ts";
import { MockDevice } from "../../hikvision/test/mock-device.ts";

type Outcome = { retryInSeconds: number } | { permanent: true };

class MemoryStore implements JobStore {
  jobs: DeviceJob[];
  done: string[] = [];
  failed = new Map<string, { error: string; outcome: Outcome }>();
  constructor(jobs: DeviceJob[]) {
    this.jobs = jobs;
  }
  async claim(limit: number): Promise<DeviceJob[]> {
    return this.jobs.splice(0, limit);
  }
  async complete(id: string): Promise<void> {
    this.done.push(id);
  }
  async fail(id: string, error: string, outcome: Outcome): Promise<void> {
    this.failed.set(id, { error, outcome });
  }
}

const job = (id: string, action: DeviceJob["action"], payload: Record<string, unknown>, attempts = 1): DeviceJob => ({
  id,
  action,
  payload,
  attempts,
});

const noFaces: FaceSource = { download: async () => assert.fail("no face expected") };

const jpeg = Buffer.alloc(1500, 3);
jpeg[0] = 0xff;
jpeg[1] = 0xd8;

test("a payment flows through to the door: create, renew, add face, delete", async () => {
  const mock = await MockDevice.start();
  try {
    const device = new HikvisionClient({ baseUrl: mock.url, username: "admin", password: "secret123" });
    const faces: FaceSource = { download: async (p) => (p === "g1/1001.jpg" ? jpeg : assert.fail(`unexpected ${p}`)) };
    const store = new MemoryStore([
      job("j1", "upsert_user", { employeeNo: "1001", name: "Elie", beginDate: "2026-11-07", endDate: "2026-12-06" }),
      job("j2", "upload_face", { employeeNo: "1001", facePath: "g1/1001.jpg" }),
      job("j3", "upsert_user", { employeeNo: "1001", name: "Elie", beginDate: "2026-11-07", endDate: "2027-01-06" }),
    ]);

    const summary = await processJobs(store, device, faces);
    assert.deepEqual(summary, { done: 3, retry: 0, failed: 0, haltedOnBadLogin: false });
    assert.equal(mock.users.get("1001")?.Valid.endTime, "2027-01-06T23:59:59"); // the renewal won
    assert.ok(mock.faces.get("1001")?.equals(jpeg));

    store.jobs = [job("j4", "delete_user", { employeeNo: "1001" })];
    await processJobs(store, device, noFaces);
    assert.equal(mock.users.size, 0);
  } finally {
    await mock.close();
  }
});

test("device down: retried with backoff, and given up after MAX_ATTEMPTS", async () => {
  const device = new HikvisionClient({ baseUrl: "http://127.0.0.1:1", username: "a", password: "b", timeoutMs: 500 });
  const payload = { employeeNo: "1", name: "A", beginDate: "2026-11-07", endDate: "2026-12-06" };

  const first = new MemoryStore([job("a", "upsert_user", payload, 1)]);
  assert.deepEqual((await processJobs(first, device, noFaces)).retry, 1);
  assert.deepEqual(first.failed.get("a")?.outcome, { retryInSeconds: 30 });

  const last = new MemoryStore([job("b", "upsert_user", payload, MAX_ATTEMPTS)]);
  assert.deepEqual((await processJobs(last, device, noFaces)).failed, 1);
  assert.deepEqual(last.failed.get("b")?.outcome, { permanent: true });
});

test("bad payload fails for good immediately", async () => {
  const device: DoorDevice = {
    upsertUser: async () => assert.fail("must not be called"),
    deleteUser: async () => assert.fail("must not be called"),
    uploadFace: async () => assert.fail("must not be called"),
  };
  const store = new MemoryStore([
    job("x", "upsert_user", { employeeNo: "1", name: "A", beginDate: "07/11/2026", endDate: "2026-12-06" }),
    job("y", "delete_user", {}),
  ]);
  const s = await processJobs(store, device, noFaces);
  assert.equal(s.failed, 2);
  assert.deepEqual(store.failed.get("x")?.outcome, { permanent: true });
  assert.match(store.failed.get("y")?.error ?? "", /employeeNo/);
});

test("wrong device login stops the batch after ONE attempt and waits an hour", async () => {
  const mock = await MockDevice.start();
  try {
    const device = new HikvisionClient({ baseUrl: mock.url, username: "admin", password: "WRONG" });
    const payload = { employeeNo: "1", name: "A", beginDate: "2026-11-07", endDate: "2026-12-06" };
    const store = new MemoryStore([job("1", "upsert_user", payload), job("2", "upsert_user", payload), job("3", "upsert_user", payload)]);
    const s = await processJobs(store, device, noFaces);
    assert.equal(s.haltedOnBadLogin, true);
    assert.equal(s.retry, 3);
    assert.equal(mock.challenges, 2); // initial challenge + the one rejected login. Nothing more.
    for (const id of ["1", "2", "3"]) assert.deepEqual(store.failed.get(id)?.outcome, { retryInSeconds: 3600 });
  } finally {
    await mock.close();
  }
});

test("backoff doubles and is capped at an hour", () => {
  assert.deepEqual([1, 2, 3, 4, 8, 12].map(backoffSeconds), [30, 60, 120, 240, 3600, 3600]);
});

test("SupabaseJobStore calls the right REST endpoints", async () => {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    if (url.endsWith("/rpc/claim_device_jobs")) {
      return Response.json([{ id: "job-1", action: "delete_user", payload: { employeeNo: "5" }, attempts: 2, extra: "ignored" }]);
    }
    if (url.includes("/storage/v1/object/")) return new Response(new Uint8Array([0xff, 0xd8, 1, 2]));
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const store = new SupabaseJobStore({ url: "https://x.supabase.co", serviceKey: "SVC", gymId: "gym-1", fetch: fakeFetch });

  assert.deepEqual(await store.claim(10), [{ id: "job-1", action: "delete_user", payload: { employeeNo: "5" }, attempts: 2 }]);
  assert.deepEqual(calls[0].body, { p_gym: "gym-1", p_limit: 10 });
  assert.equal(calls[0].headers.apikey, "SVC");
  assert.equal(calls[0].headers.Authorization, "Bearer SVC");

  await store.complete("job-1");
  assert.equal(calls[1].url, "https://x.supabase.co/rest/v1/device_jobs?id=eq.job-1");
  assert.equal(calls[1].method, "PATCH");
  assert.deepEqual(calls[1].body, { status: "done", last_error: null });

  await store.fail("job-1", "boom", { permanent: true });
  assert.deepEqual(calls[2].body, { status: "failed", last_error: "boom" });

  await store.fail("job-1", "later", { retryInSeconds: 60 });
  const retry = calls[3].body as { status: string; run_after: string; last_error: string };
  assert.equal(retry.status, "pending");
  assert.equal(retry.last_error, "later");
  assert.ok(new Date(retry.run_after).getTime() > Date.now() + 50_000);

  assert.deepEqual([...(await store.download("g1/5.jpg"))], [0xff, 0xd8, 1, 2]);
  assert.equal(calls[4].url, "https://x.supabase.co/storage/v1/object/faces/g1/5.jpg");
});
