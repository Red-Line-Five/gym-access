import assert from "node:assert/strict";
import { test } from "node:test";
import { quotePayment } from "../src/index.ts";

const base = { priceUsd: 60, months: 1, lbpRate: 90000, creditUsd: 0, useCredit: true };

test("default: $60 = 5,400,000 LL, nothing left over", () => {
  const q = quotePayment(base);
  assert.equal(q.due, 60);
  assert.equal(q.dueLbp, 5_400_000);
  assert.equal(q.discount, 0);
  assert.equal(q.creditAdded, 0);
});

test("client pays 55: $5 discount, month still given", () => {
  const q = quotePayment({ ...base, received: 55 });
  assert.equal(q.discount, 5);
  assert.equal(q.creditAdded, 0);
});

test("client pays 100: $40 becomes credit", () => {
  const q = quotePayment({ ...base, received: 100 });
  assert.equal(q.creditAdded, 40);
  assert.equal(q.creditAfter, 40);
});

test("existing $40 credit reduces what is due, and can be switched off", () => {
  const on = quotePayment({ ...base, creditUsd: 40 });
  assert.equal(on.creditUsed, 40);
  assert.equal(on.due, 20);
  assert.equal(on.creditAfter, 0);
  const off = quotePayment({ ...base, creditUsd: 40, useCredit: false });
  assert.equal(off.due, 60);
  assert.equal(off.creditAfter, 40);
});

test("credit larger than the price: only the price is used", () => {
  const q = quotePayment({ ...base, creditUsd: 100, received: 0 });
  assert.equal(q.creditUsed, 60);
  assert.equal(q.due, 0);
  assert.equal(q.creditAfter, 40);
  assert.equal(q.discount, 0);
});

test("paying in LL converts at the rate; rounding noise is not credit", () => {
  assert.equal(quotePayment({ ...base, received: 5_400_000, currency: "LBP" }).creditAdded, 0);
  assert.equal(quotePayment({ ...base, received: 5_400_100, currency: "LBP" }).creditAdded, 0); // $0.001 over
  assert.equal(quotePayment({ ...base, received: 4_500_000, currency: "LBP" }).discount, 10);
});

test("bad input is rejected", () => {
  assert.throws(() => quotePayment({ ...base, months: 0 }), RangeError);
  assert.throws(() => quotePayment({ ...base, received: -1 }), RangeError);
  assert.throws(() => quotePayment({ ...base, lbpRate: 0 }), RangeError);
});
