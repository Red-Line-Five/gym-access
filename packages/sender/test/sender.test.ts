import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { WhatsAppError } from "@gym/whatsapp";
import { MAX_ATTEMPTS, backoffSeconds, handleWebhook, processMessages, verifyChallenge } from "../src/index.ts";
import type { MessageStore, QueuedMessage, Sender } from "../src/index.ts";

type Outcome = { retryInSeconds: number } | { permanent: true };

function fakeStore(batch: QueuedMessage[]) {
  const sent = new Map<string, string>();
  const failed = new Map<string, { error: string; outcome: Outcome }>();
  const store: MessageStore = {
    claim: async () => batch,
    markSent: async (id, wa) => void sent.set(id, wa),
    fail: async (id, error, outcome) => void failed.set(id, { error, outcome }),
  };
  return { store, sent, failed };
}

const msg = (id: string, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id, kind: "payment_received", phone: "03123456", params: ["Maya", "Gym", "07/12/2026"], attempts: 1, ...over,
});

const okSender: Sender = { sendTemplate: async () => ({ messageId: "wamid.OK" }) };

test("a sent message is saved with Meta's message id", async () => {
  const { store, sent } = fakeStore([msg("a")]);
  const s = await processMessages(store, okSender);
  assert.deepEqual(s, { sent: 1, retry: 0, failed: 0, haltedOnBadToken: false });
  assert.equal(sent.get("a"), "wamid.OK");
});

test("the template name comes from the message kind, with the stored variables", async () => {
  const calls: unknown[][] = [];
  const wa: Sender = { sendTemplate: async (...a) => (calls.push(a), { messageId: "x" }) };
  await processMessages(fakeStore([msg("a", { kind: "gym_closed", phone: "71 000 111", params: ["Elie", "Gym", "12/11/2026"] })]).store, wa);
  assert.deepEqual(calls[0], ["71 000 111", "gym_closed", ["Elie", "Gym", "12/11/2026"]]);
});

test("errors: temporary retries with backoff, number-not-on-WhatsApp and bad template stop for good", async () => {
  const errors: Record<string, Error> = {
    net: new WhatsAppError("HTTP 503", 503, undefined, true),
    nowa: new WhatsAppError("not on whatsapp", 400, 131026, false),
    tpl: new WhatsAppError("template missing", 404, 132001, false),
    phone: new RangeError("bad phone"),
    kind: new Error("x"),
  };
  const wa: Sender = { sendTemplate: async (to) => { throw errors[to]; } };
  const { store, failed } = fakeStore(Object.keys(errors).map((k) => msg(k, { phone: k, attempts: 2 })));
  const s = await processMessages(store, wa);
  assert.equal(s.sent, 0);
  assert.deepEqual(failed.get("net")?.outcome, { retryInSeconds: backoffSeconds(2) });
  assert.deepEqual(failed.get("nowa")?.outcome, { permanent: true });
  assert.deepEqual(failed.get("tpl")?.outcome, { permanent: true });
  assert.deepEqual(failed.get("phone")?.outcome, { permanent: true });
  assert.deepEqual(failed.get("kind")?.outcome, { retryInSeconds: backoffSeconds(2) });
});

test("after MAX_ATTEMPTS a temporary error becomes permanent", async () => {
  const wa: Sender = { sendTemplate: async () => { throw new WhatsAppError("HTTP 500", 500, undefined, true); } };
  const { store, failed } = fakeStore([msg("a", { attempts: MAX_ATTEMPTS })]);
  await processMessages(store, wa);
  assert.deepEqual(failed.get("a")?.outcome, { permanent: true });
});

test("an unknown kind is rejected without calling WhatsApp", async () => {
  let called = 0;
  const wa: Sender = { sendTemplate: async () => (called++, { messageId: "x" }) };
  const { store, failed } = fakeStore([msg("a", { kind: "promo" })]);
  await processMessages(store, wa);
  assert.equal(called, 0);
  assert.deepEqual(failed.get("a")?.outcome, { permanent: true });
});

test("a rejected token stops the batch and puts every remaining message back", async () => {
  let calls = 0;
  const wa: Sender = { sendTemplate: async () => { calls++; throw new WhatsAppError("token expired", 401, 190, false); } };
  const { store, failed } = fakeStore([msg("a"), msg("b"), msg("c")]);
  const s = await processMessages(store, wa);
  assert.equal(calls, 1); // did not hammer Meta
  assert.equal(s.haltedOnBadToken, true);
  assert.equal(s.retry, 3);
  assert.deepEqual([...failed.keys()], ["a", "b", "c"]);
  assert.ok(failed.get("c")?.error.includes("token"));
});

test("if saving 'sent' keeps failing, stop loudly instead of sending a duplicate later", async () => {
  const store: MessageStore = {
    claim: async () => [msg("a")], markSent: async () => { throw new Error("db down"); }, fail: async () => {},
  };
  await assert.rejects(processMessages(store, okSender), /could not be saved/);
});

test("backoff doubles and caps at one hour", () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(backoffSeconds), [60, 120, 240, 480, 3600]);
});

// ------------------------------------------------------------------ webhook

const SECRET = "app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
const payload = (statuses: unknown[]) => JSON.stringify({ entry: [{ changes: [{ value: { statuses } }] }] });

test("webhook: a signed delivery receipt updates the message", async () => {
  const seen: unknown[][] = [];
  const store = { applyStatus: async (...a: unknown[]) => void seen.push(a) };
  const body = payload([
    { id: "wamid.1", status: "delivered", recipient_id: "96103123456" },
    { id: "wamid.2", status: "failed", recipient_id: "96171000111", errors: [{ code: 131026, title: "Message undeliverable" }] },
  ]);
  assert.equal(await handleWebhook(body, sign(body), SECRET, store), 200);
  assert.deepEqual(seen, [["wamid.1", "delivered", undefined], ["wamid.2", "failed", "131026 Message undeliverable"]]);
});

test("webhook: wrong signature is refused and nothing is saved", async () => {
  let saved = 0;
  const store = { applyStatus: async () => void saved++ };
  const body = payload([{ id: "wamid.1", status: "read", recipient_id: "1" }]);
  assert.equal(await handleWebhook(body, sign(body + "x"), SECRET, store), 401);
  assert.equal(await handleWebhook(body, null, SECRET, store), 401);
  assert.equal(saved, 0);
});

test("webhook: bad JSON is 400; a failing database answers 500 so Meta retries", async () => {
  const bad = "not json";
  assert.equal(await handleWebhook(bad, sign(bad), SECRET, { applyStatus: async () => {} }), 400);
  const body = payload([{ id: "w", status: "sent", recipient_id: "1" }]);
  assert.equal(await handleWebhook(body, sign(body), SECRET, { applyStatus: async () => { throw new Error("db"); } }), 500);
});

test("webhook: verify handshake only answers with the right token", () => {
  const q = (t: string) => new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": t, "hub.challenge": "12345" });
  assert.equal(verifyChallenge(q("secret"), "secret"), "12345");
  assert.equal(verifyChallenge(q("nope"), "secret"), null);
});
