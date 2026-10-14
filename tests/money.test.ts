import test from "node:test";
import assert from "node:assert/strict";
import { fmtMoney, parseMoneyToMinor, orderRef } from "../lib/money";

test("fmtMoney renders whole naira without decimals", () => {
  assert.equal(fmtMoney(3_000_000, "NGN"), "₦30,000");
  assert.equal(fmtMoney(1_500_000, "NGN"), "₦15,000");
  assert.equal(fmtMoney(0, "NGN"), "₦0");
});

test("fmtMoney shows kobo only when there are kobo", () => {
  // The old implementation produced "15,000.5" here — a price that reads as
  // a typo to a customer.
  assert.equal(fmtMoney(1_500_050, "NGN"), "₦15,000.50");
  assert.equal(fmtMoney(1_500_005, "NGN"), "₦15,000.05");
});

test("fmtMoney handles the other currency and negatives", () => {
  assert.equal(fmtMoney(2_500_000, "GHS"), "GH₵25,000");
  assert.equal(fmtMoney(-500_000, "NGN"), "-₦5,000");
});

test("fmtMoney survives the shapes Postgres actually returns", () => {
  // bigint columns arrive as strings over PostgREST once they exceed 2^53,
  // and a left join can hand back null.
  assert.equal(fmtMoney("3000000", "NGN"), "₦30,000");
  assert.equal(fmtMoney(null, "NGN"), "₦0");
  assert.equal(fmtMoney(undefined, "NGN"), "₦0");
});

test("parseMoneyToMinor reads what an owner types one-handed", () => {
  assert.equal(parseMoneyToMinor("35000"), 3_500_000);
  assert.equal(parseMoneyToMinor("₦35,000"), 3_500_000);
  assert.equal(parseMoneyToMinor(" 35,000.50 "), 3_500_050);
  assert.equal(parseMoneyToMinor("35k"), 3_500_000);
  assert.equal(parseMoneyToMinor("2.5k"), 250_000);
});

test("parseMoneyToMinor refuses what it cannot read", () => {
  // Returning 0 or NaN here would silently set a product's price to nothing.
  assert.equal(parseMoneyToMinor("abc"), null);
  assert.equal(parseMoneyToMinor(""), null);
  assert.equal(parseMoneyToMinor("35 000 naira"), null);
  assert.equal(parseMoneyToMinor("1.234"), null);
});

test("orderRef is stable, short, and uppercase", () => {
  const id = "3f2a1b9c-0d4e-4f6a-8b7c-1234567890ab";
  assert.equal(orderRef(id), "3F2A1B");
  assert.equal(orderRef(id), orderRef(id));
  assert.equal(orderRef(id).length, 6);
});
