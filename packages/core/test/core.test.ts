import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, addMonths, closureExtensions, dueForExpiryReminder, formatDMY, nextPeriod, reminderKey, todayIn } from "../src/index.ts";
import type { MemberStatus } from "../src/index.ts";

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
});

test("addMonths clamps to the end of short months", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-11-07", 1), "2026-12-07");
  assert.equal(addMonths("2026-12-15", 2), "2027-02-15");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
});

test("invalid dates are rejected", () => {
  assert.throws(() => addDays("2026-02-30", 1), RangeError);
  assert.throws(() => addDays("07/11/2026", 1), RangeError);
});

test("todayIn uses the gym's timezone, not the server's", () => {
  // 22:30 UTC on 7 Nov is already 8 Nov 00:30 in Beirut (UTC+2 in winter).
  const instant = new Date("2026-11-07T22:30:00Z");
  assert.equal(todayIn("Asia/Beirut", instant), "2026-11-08");
  assert.equal(todayIn("UTC", instant), "2026-11-07");
});

test("formatDMY", () => {
  assert.equal(formatDMY("2026-12-06"), "06/12/2026");
});

test("first payment: starts on the payment date, ends the day before the same date next month", () => {
  assert.deepEqual(nextPeriod(null, "2026-11-07"), { start: "2026-11-07", end: "2026-12-06" });
});

test("paying early keeps the unused days: new period starts after the current end", () => {
  assert.deepEqual(nextPeriod("2026-12-06", "2026-12-01"), { start: "2026-12-07", end: "2027-01-06" });
  assert.deepEqual(nextPeriod("2026-12-06", "2026-12-06"), { start: "2026-12-07", end: "2027-01-06" });
});

test("paying after expiry starts from the payment date", () => {
  assert.deepEqual(nextPeriod("2026-12-06", "2026-12-20"), { start: "2026-12-20", end: "2027-01-19" });
  assert.deepEqual(nextPeriod("2026-12-06", "2026-12-07"), { start: "2026-12-07", end: "2027-01-06" });
});

test("multi-month payment", () => {
  assert.deepEqual(nextPeriod(null, "2026-11-07", 3), { start: "2026-11-07", end: "2027-02-06" });
});

const member = (id: string, endDate: string | null, phone: string | null = "71123456"): MemberStatus => ({
  id,
  fullName: `Member ${id}`,
  phone,
  endDate,
});

test("expiry reminder: due when the subscription ends within 2 days, once per period", () => {
  const members = [
    member("a", "2026-11-09"), // ends in 2 days  -> remind
    member("b", "2026-11-08"), // ends tomorrow   -> remind (missed run catch-up)
    member("c", "2026-11-07"), // ends today      -> remind
    member("d", "2026-11-10"), // ends in 3 days  -> not yet
    member("e", "2026-11-06"), // already expired -> no
    member("f", null), //        never paid      -> no
    member("g", "2026-11-09", null), // no phone  -> no
    member("h", "2026-11-09"), // already reminded
  ];
  const sent = new Set([reminderKey(members[7])]);
  const due = dueForExpiryReminder(members, "2026-11-07", sent).map((m) => m.id);
  assert.deepEqual(due, ["a", "b", "c"]);
});

test("after renewing, the next period's reminder is allowed again", () => {
  const before = member("a", "2026-11-09");
  const sent = new Set([reminderKey(before)]);
  assert.deepEqual(dueForExpiryReminder([before], "2026-11-07", sent), []);
  const renewed = member("a", "2026-12-09");
  assert.deepEqual(dueForExpiryReminder([renewed], "2026-12-08", sent).map((m) => m.id), ["a"]);
});

test("closure extends only the members whose subscription covers the closed day", () => {
  const members = [member("a", "2026-11-20"), member("b", "2026-11-07"), member("c", "2026-11-06"), member("d", null)];
  assert.deepEqual(closureExtensions(members, "2026-11-07"), [
    { memberId: "a", newEndDate: "2026-11-21" },
    { memberId: "b", newEndDate: "2026-11-08" },
  ]);
  assert.deepEqual(closureExtensions(members, "2026-11-07", 3)[0], { memberId: "a", newEndDate: "2026-11-23" });
});
