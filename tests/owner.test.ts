import test from "node:test";
import assert from "node:assert/strict";
import { samePhone } from "../lib/owner";
import { trimToUserStart, type Turn } from "../lib/supabase";

/* ------------------------------------------------------------------ */
/* Owner recognition                                                   */
/* ------------------------------------------------------------------ */

test("the same number written three ways is recognised as one person", () => {
  // Meta delivers `from` as 2348012345678. Owners type whichever form they
  // think in. A raw string compare meant the owner console silently never
  // triggered — indistinguishable from the feature being broken.
  assert.equal(samePhone("2348012345678", "2348012345678"), true);
  assert.equal(samePhone("+2348012345678", "2348012345678"), true);
  assert.equal(samePhone("+234 801 234 5678", "2348012345678"), true);
  assert.equal(samePhone("08012345678", "2348012345678"), true);
});

test("different people are not confused for each other", () => {
  assert.equal(samePhone("2348012345678", "2348012345679"), false);
  assert.equal(samePhone("2348012345678", "2349165073999"), false);
});

test("missing or too-short numbers never match", () => {
  // Matching on a short suffix would make the owner console fire for
  // customers, handing a stranger the ability to cancel orders.
  assert.equal(samePhone(null, "2348012345678"), false);
  assert.equal(samePhone("", "2348012345678"), false);
  assert.equal(samePhone(undefined, undefined), false);
  assert.equal(samePhone("5678", "2348012345678"), false);
  assert.equal(samePhone("12345678", "2348012345678"), false);
});

test("a nine-digit suffix is enough, eight is not", () => {
  assert.equal(samePhone("123456789", "234123456789"), true);
  assert.equal(samePhone("12345678", "234123456789"), false);
});

/* ------------------------------------------------------------------ */
/* Conversation history shape                                          */
/* ------------------------------------------------------------------ */

const u = (content: string): Turn => ({ role: "user", content });
const a = (content: string): Turn => ({ role: "assistant", content });

test("history already starting on user is unchanged", () => {
  const turns = [u("how much"), a("₦30,000"), u("ok")];
  assert.deepEqual(trimToUserStart(turns), turns);
});

test("leading assistant turns are dropped", () => {
  // The API rejects a messages array that starts on `assistant`. Taking the
  // last N rows of a live transcript lands there roughly half the time — and
  // it only happens once a conversation is long enough to slide, so it fails
  // on established customers rather than in testing.
  const turns = [a("₦30,000"), u("ok"), a("noted")];
  assert.deepEqual(trimToUserStart(turns), [u("ok"), a("noted")]);
});

test("several leading assistant turns are all dropped", () => {
  const turns = [a("one"), a("two"), u("three")];
  assert.deepEqual(trimToUserStart(turns), [u("three")]);
});

test("an all-assistant history collapses to empty rather than throwing", () => {
  assert.deepEqual(trimToUserStart([a("one"), a("two")]), []);
  assert.deepEqual(trimToUserStart([]), []);
});

test("the result always starts on user or is empty", () => {
  const cases: Turn[][] = [
    [a("x")],
    [a("x"), u("y")],
    [u("y"), a("x")],
    [a("x"), a("y"), a("z")],
    [],
  ];
  for (const c of cases) {
    const out = trimToUserStart(c);
    assert.ok(out.length === 0 || out[0].role === "user");
  }
});
