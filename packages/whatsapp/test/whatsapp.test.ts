import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WhatsAppClient, WhatsAppError, cleanParam, normalizePhone, parseStatuses, verifySignature } from "../src/index.ts";

interface Captured {
  url: string;
  auth: string | undefined;
  body: any;
}

/** Fake Graph API. `script` decides each response; defaults to success. */
async function startGraph(
  script: (n: number, body: any) => { status: number; json: unknown } = (n) => ({
    status: 200,
    json: { messaging_product: "whatsapp", messages: [{ id: `wamid.${n}` }] },
  }),
): Promise<{ baseUrl: string; calls: Captured[]; close: () => Promise<void> }> {
  const calls: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const r = script(calls.length, body);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const client = (baseUrl: string): WhatsAppClient =>
  new WhatsAppClient({ phoneNumberId: "123456789", accessToken: "TOKEN", baseUrl, retryDelayMs: 1 });

test("normalizePhone handles the ways Lebanese numbers get typed", () => {
  assert.equal(normalizePhone("03 123 456"), "9613123456");
  assert.equal(normalizePhone("71 123 456"), "96171123456");
  assert.equal(normalizePhone("+961 71 123 456"), "96171123456");
  assert.equal(normalizePhone("00961 71-123-456"), "96171123456");
  assert.equal(normalizePhone("961 3 123456"), "9613123456");
  assert.equal(normalizePhone("+44 7700 900123"), "447700900123");
  assert.throws(() => normalizePhone("12"), RangeError);
  assert.throws(() => normalizePhone("abc"), RangeError);
});

test("cleanParam removes newlines and runs of spaces, and refuses empty values", () => {
  assert.equal(cleanParam("  Elie \n  Hotlmati\t"), "Elie Hotlmati");
  assert.throws(() => cleanParam("   "), RangeError);
});

test("sends the template with the right URL, token, language and Arabic text", async () => {
  const graph = await startGraph();
  try {
    const result = await client(graph.baseUrl).sendTemplate("03 123 456", "payment_received", ["إيلي", "جيم الأرز", "06/12/2026"]);
    assert.equal(result.messageId, "wamid.1");
    const call = graph.calls[0];
    assert.equal(call.url, "/v21.0/123456789/messages");
    assert.equal(call.auth, "Bearer TOKEN");
    assert.equal(call.body.to, "9613123456");
    assert.equal(call.body.type, "template");
    assert.equal(call.body.template.name, "payment_received");
    assert.equal(call.body.template.language.code, "ar");
    assert.deepEqual(
      call.body.template.components[0].parameters.map((p: { text: string }) => p.text),
      ["إيلي", "جيم الأرز", "06/12/2026"],
    );
  } finally {
    await graph.close();
  }
});

test("wrong number of parameters is caught before any network call", async () => {
  const graph = await startGraph();
  try {
    await assert.rejects(client(graph.baseUrl).sendTemplate("71123456", "gym_closed", ["only one"]), /needs 3 parameters/);
    assert.equal(graph.calls.length, 0);
  } finally {
    await graph.close();
  }
});

test("retries a 500 and then succeeds", async () => {
  const graph = await startGraph((n) =>
    n === 1
      ? { status: 500, json: { error: { message: "Temporary", code: 2 } } }
      : { status: 200, json: { messages: [{ id: "wamid.ok" }] } },
  );
  try {
    const r = await client(graph.baseUrl).sendTemplate("71123456", "subscription_expiring", ["A", "B", "C"]);
    assert.equal(r.messageId, "wamid.ok");
    assert.equal(graph.calls.length, 2);
  } finally {
    await graph.close();
  }
});

test("does not retry a 400 and exposes Meta's error code", async () => {
  const graph = await startGraph(() => ({
    status: 400,
    json: { error: { message: "Template name does not exist in the translation", code: 132001 } },
  }));
  try {
    await assert.rejects(client(graph.baseUrl).sendTemplate("71123456", "payment_received", ["A", "B", "C"]), (e: unknown) => {
      assert.ok(e instanceof WhatsAppError);
      assert.equal(e.code, 132001);
      assert.equal(e.status, 400);
      assert.equal(e.retryable, false);
      return true;
    });
    assert.equal(graph.calls.length, 1);
  } finally {
    await graph.close();
  }
});

test("gives up after the retries are used and says so", async () => {
  const graph = await startGraph(() => ({ status: 503, json: { error: { message: "Down", code: 1 } } }));
  try {
    await assert.rejects(client(graph.baseUrl).sendTemplate("71123456", "payment_received", ["A", "B", "C"]), /Down/);
    assert.equal(graph.calls.length, 3); // 1 try + 2 retries
  } finally {
    await graph.close();
  }
});

test("broadcast: one bad number never stops the others, and shared phones get one message", async () => {
  const graph = await startGraph((_n, body) =>
    body.to === "96171000002"
      ? { status: 400, json: { error: { message: "Number not on WhatsApp", code: 131026 } } }
      : { status: 200, json: { messages: [{ id: `wamid.${body.to}` }] } },
  );
  try {
    const params = (name: string): string[] => [name, "Gym", "07/11/2026"];
    const results = await client(graph.baseUrl).broadcast("gym_closed", [
      { phone: "71 000 001", params: params("A") },
      { phone: "71 000 002", params: params("B") },
      { phone: "+961 71 000 001", params: params("A's brother") }, // same phone as the first
      { phone: "not a phone", params: params("C") },
      { phone: "03 000 003", params: params("D") },
    ]);
    const byPhone = Object.fromEntries(results.map((r) => [r.phone, r]));
    assert.equal(results.length, 4);
    assert.equal(byPhone["71 000 001"].ok, true);
    assert.equal(byPhone["71 000 002"].ok, false);
    assert.equal((byPhone["71 000 002"] as { code?: number }).code, 131026);
    assert.equal(byPhone["not a phone"].ok, false);
    assert.equal(byPhone["03 000 003"].ok, true);
    assert.equal(graph.calls.length, 3); // 71000001, 71000002, 03000003
  } finally {
    await graph.close();
  }
});

test("webhook signature: accepts the real HMAC, rejects anything else", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const secret = "app-secret";
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifySignature(body, good, secret), true);
  assert.equal(verifySignature(body + " ", good, secret), false);
  assert.equal(verifySignature(body, good, "other-secret"), false);
  assert.equal(verifySignature(body, "sha256=abcd", secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, good.replace("sha256=", "md5="), secret), false);
});

test("parseStatuses reads delivery receipts and failures", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                { id: "wamid.A", status: "delivered", recipient_id: "96171123456" },
                { id: "wamid.B", status: "failed", recipient_id: "9613123456", errors: [{ code: 131026, title: "Message undeliverable" }] },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseStatuses(payload), [
    { messageId: "wamid.A", status: "delivered", recipient: "96171123456" },
    { messageId: "wamid.B", status: "failed", recipient: "9613123456", errorCode: 131026, errorTitle: "Message undeliverable" },
  ]);
  assert.deepEqual(parseStatuses(null), []);
  assert.deepEqual(parseStatuses({ entry: [{ changes: [{ value: { messages: [] } }] }] }), []);
});
