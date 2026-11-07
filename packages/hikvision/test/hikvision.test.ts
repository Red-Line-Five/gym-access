import assert from "node:assert/strict";
import { test } from "node:test";
import { HikvisionClient, HikvisionError, dayEnd, dayStart, truncateUtf8 } from "../src/index.ts";
import { MockDevice } from "./mock-device.ts";
import type { MockDeviceOptions } from "./mock-device.ts";

async function withDevice(
  options: MockDeviceOptions,
  fn: (device: MockDevice, client: HikvisionClient) => Promise<void>,
): Promise<void> {
  const device = await MockDevice.start(options);
  try {
    await fn(device, new HikvisionClient({ baseUrl: device.url, username: "admin", password: "secret123" }));
  } finally {
    await device.close();
  }
}

const fakeJpeg = (size = 2000): Buffer => {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
};

test("signs requests with Digest auth and reads device info", async () => {
  await withDevice({}, async (_device, client) => {
    const info = await client.deviceInfo();
    assert.equal(info.model, "DS-K1T343MFWX");
    assert.match(info.serialNumber, /^DS-K1T343MFWX/);
  });
});

test("wrong password gives a clear 401 error and stops after one attempt", async () => {
  const device = await MockDevice.start();
  try {
    const client = new HikvisionClient({ baseUrl: device.url, username: "admin", password: "nope" });
    await assert.rejects(client.deviceInfo(), (e: unknown) => {
      assert.ok(e instanceof HikvisionError);
      assert.equal(e.status, 401);
      assert.match(e.message, /password/i);
      return true;
    });
    // 1st request: no credentials yet -> challenge. 2nd: wrong credentials -> challenge. Then we stop.
    assert.equal(device.challenges, 2);
  } finally {
    await device.close();
  }
});

test("recovers when the device expires the nonce (stale=true)", async () => {
  await withDevice({ rotateNonceAfter: 1 }, async (device, client) => {
    await client.deviceInfo();
    await client.deviceInfo();
    await client.deviceInfo();
    assert.ok(device.challenges >= 3, `expected several challenges, got ${device.challenges}`);
  });
});

test("creates a member, then a renewal updates the same member's end time", async () => {
  await withDevice({}, async (device, client) => {
    const first = await client.upsertUser({
      employeeNo: "1001",
      name: "Elie Hotlmati",
      beginTime: dayStart("2026-11-07"),
      endTime: dayEnd("2026-12-06"),
    });
    assert.deepEqual(first, { created: true });
    assert.equal(device.users.get("1001")?.Valid.endTime, "2026-12-06T23:59:59");

    const second = await client.upsertUser({
      employeeNo: "1001",
      name: "Elie Hotlmati",
      beginTime: dayStart("2026-11-07"),
      endTime: dayEnd("2027-01-06"),
    });
    assert.deepEqual(second, { created: false });
    assert.equal(device.users.size, 1);
    assert.equal(device.users.get("1001")?.Valid.endTime, "2027-01-06T23:59:59");
    assert.equal(device.users.get("1001")?.Valid.enable, true);
  });
});

test("long Arabic names are cut on a character boundary within 32 bytes", async () => {
  const name = "محمد عبد الرحمن الخطيب الحسيني الكبير";
  const cut = truncateUtf8(name, 32);
  assert.ok(Buffer.byteLength(cut) <= 32);
  assert.ok(name.startsWith(cut));
  assert.ok(!cut.includes("�"));

  await withDevice({}, async (device, client) => {
    await client.upsertUser({ employeeNo: "7", name, beginTime: dayStart("2026-11-07"), endTime: dayEnd("2026-12-06") });
    assert.equal(device.users.get("7")?.name, cut);
  });
});

test("rejects bad input before talking to the device", async () => {
  await withDevice({}, async (device, client) => {
    const ok = { name: "A", beginTime: dayStart("2026-11-07"), endTime: dayEnd("2026-12-06") };
    await assert.rejects(client.upsertUser({ ...ok, employeeNo: "abc" }), RangeError);
    await assert.rejects(client.upsertUser({ ...ok, employeeNo: "1", endTime: "2026-12-06" }), RangeError);
    await assert.rejects(client.upsertUser({ ...ok, employeeNo: "1", beginTime: dayStart("2027-01-01") }), RangeError);
    assert.throws(() => dayStart("07/11/2026"), RangeError);
    assert.equal(device.paths.length, 0);
  });
});

test("deletes a member and their face", async () => {
  await withDevice({}, async (device, client) => {
    await client.upsertUser({ employeeNo: "5", name: "X", beginTime: dayStart("2026-11-07"), endTime: dayEnd("2026-12-06") });
    await client.uploadFace("5", fakeJpeg());
    await client.deleteUser("5");
    assert.equal(device.users.has("5"), false);
    assert.equal(device.faces.has("5"), false);
  });
});

test("uploads the face photo as multipart and the bytes arrive intact", async () => {
  await withDevice({}, async (device, client) => {
    await client.upsertUser({ employeeNo: "1001", name: "A", beginTime: dayStart("2026-11-07"), endTime: dayEnd("2026-12-06") });
    const jpeg = fakeJpeg(5000);
    await client.uploadFace("1001", jpeg);
    assert.ok(device.faces.get("1001")?.equals(jpeg));
  });
});

test("uploading a face for a member the device does not know is an error with the device's reason", async () => {
  await withDevice({}, async (_device, client) => {
    await assert.rejects(client.uploadFace("404", fakeJpeg()), (e: unknown) => {
      assert.ok(e instanceof HikvisionError);
      assert.equal(e.subStatus, "employeeNoNotExist");
      return true;
    });
  });
});

test("refuses non-JPEG and oversized photos locally", async () => {
  await withDevice({}, async (device, client) => {
    await assert.rejects(client.uploadFace("1", Buffer.from("not a jpeg at all")), /JPEG/);
    await assert.rejects(client.uploadFace("1", fakeJpeg(300 * 1024)), /at most/);
    assert.equal(device.paths.length, 0);
  });
});

test("reads door events across several pages", async () => {
  const events = Array.from({ length: 7 }, (_, i) => ({
    employeeNo: String(1000 + i),
    name: `Member ${i}`,
    time: `2026-11-07T10:0${i}:00+02:00`,
  }));
  await withDevice({ events, eventPageSize: 3 }, async (device, client) => {
    const got = await client.getAccessEvents({
      startTime: "2026-11-07T00:00:00+02:00",
      endTime: "2026-11-07T23:59:59+02:00",
    });
    assert.equal(got.length, 7);
    assert.equal(got[6].employeeNo, "1006");
    assert.equal(got[0].major, 5);
    assert.equal(device.paths.filter((p) => p.includes("AcsEvent")).length, 3);
  });
});

test("an unreachable device gives status 0, not a hang", async () => {
  const client = new HikvisionClient({
    baseUrl: "http://127.0.0.1:1",
    username: "admin",
    password: "x",
    timeoutMs: 1000,
  });
  await assert.rejects(client.deviceInfo(), (e: unknown) => {
    assert.ok(e instanceof HikvisionError);
    assert.equal(e.status, 0);
    assert.match(e.message, /Cannot reach/);
    return true;
  });
});
