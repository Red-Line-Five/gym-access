/**
 * Run this AT THE GYM, on a PC on the same network as the door device, to prove the real device works:
 *
 *   HIK_URL=http://192.168.1.64 HIK_USER=admin HIK_PASS=xxxx npm run smoke:hikvision
 *   (optional) HIK_FACE=./me.jpg   -> also uploads your face photo, so you can walk up and open the door
 *   (optional) HIK_KEEP=1          -> leave the test member on the device instead of deleting it
 *
 * It creates a member "GymAccess Test" valid until tomorrow, prints each step, and cleans up.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { HikvisionClient, HikvisionError, dayEnd, dayStart } from "@gym/hikvision";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} first (see README, "Test the real door").`);
    process.exit(1);
  }
  return v;
}

const client = new HikvisionClient({ baseUrl: need("HIK_URL"), username: need("HIK_USER"), password: need("HIK_PASS") });
const employeeNo = process.env.HIK_TEST_EMPLOYEE_NO ?? "99999";
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const today = iso(new Date());
const tomorrow = iso(new Date(Date.now() + 86_400_000));

const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  try {
    const out = await fn();
    console.log(`OK    ${label}`);
    return out;
  } catch (e) {
    const detail = e instanceof HikvisionError ? `${e.message}\n      device said: ${e.body.slice(0, 400)}` : String(e);
    console.error(`FAIL  ${label}\n      ${detail}`);
    process.exit(1);
  }
};

const info = await step("connect + digest login + read device info", () => client.deviceInfo());
console.log(`      model ${info.model}, serial ${info.serialNumber}`);

await step(`create member ${employeeNo} valid ${today} .. ${tomorrow}`, () =>
  client.upsertUser({ employeeNo, name: "GymAccess Test", beginTime: dayStart(today), endTime: dayEnd(tomorrow) }),
);
await step("update the same member (renewal path: ends the day after tomorrow)", () =>
  client.upsertUser({ employeeNo, name: "GymAccess Test", beginTime: dayStart(today), endTime: dayEnd(iso(new Date(Date.now() + 2 * 86_400_000))) }),
);

if (process.env.HIK_FACE) {
  await step(`upload face ${process.env.HIK_FACE}`, () => client.uploadFace(employeeNo, readFileSync(process.env.HIK_FACE as string)));
  console.log("      Now walk up to the door: it should open for you.");
}

await step("read today's door events", async () => {
  const events = await client.getAccessEvents({ startTime: `${today}T00:00:00+00:00`, endTime: `${tomorrow}T23:59:59+00:00`, maxEvents: 5 });
  console.log(`      ${events.length} recent successful opening(s)${events[0] ? `, latest: ${events[0].name} at ${events[0].time}` : ""}`);
});

if (process.env.HIK_KEEP) {
  console.log(`Left member ${employeeNo} on the device (HIK_KEEP set).`);
} else {
  if (process.env.HIK_FACE) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter when you have tried the door, to delete the test member... ");
    rl.close();
  }
  await step(`delete member ${employeeNo}`, () => client.deleteUser(employeeNo));
}
console.log("All steps passed.");
