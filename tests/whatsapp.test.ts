import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Set before the import: these are read at call time, not module load, but
// keeping the assignment first makes that independent of import ordering.
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";

import {
  verifySignature,
  verifyHandshake,
  parseInbound,
  parseFailedStatuses,
  truncate,
} from "../lib/whatsapp";

function sign(body: string, secret = "test-app-secret") {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* Signatures                                                          */
/* ------------------------------------------------------------------ */

test("a correctly signed body is accepted", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifySignature(body, sign(body)), true);
});

test("a body signed with the wrong secret is rejected", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifySignature(body, sign(body, "wrong-secret")), false);
});

test("a tampered body is rejected", () => {
  const body = JSON.stringify({ hello: "world" });
  const header = sign(body);
  assert.equal(verifySignature(JSON.stringify({ hello: "mars" }), header), false);
});

test("a missing or malformed signature header is rejected", () => {
  const body = "{}";
  assert.equal(verifySignature(body, null), false);
  assert.equal(verifySignature(body, ""), false);
  assert.equal(verifySignature(body, "sha256=short"), false);
  assert.equal(verifySignature(body, "garbage"), false);
});

test("the handshake requires the exact token and subscribe mode", () => {
  assert.equal(verifyHandshake("subscribe", "test-verify-token"), true);
  assert.equal(verifyHandshake("subscribe", "test-verify-tokem"), false);
  assert.equal(verifyHandshake("unsubscribe", "test-verify-token"), false);
  assert.equal(verifyHandshake(null, "test-verify-token"), false);
  assert.equal(verifyHandshake("subscribe", null), false);
});

/* ------------------------------------------------------------------ */
/* Payload parsing                                                     */
/* ------------------------------------------------------------------ */

function envelope(messages: unknown[], contacts?: unknown[]) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "PNID1" },
              contacts: contacts ?? [{ profile: { name: "Ada" } }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

test("a text message parses with its profile name and timestamp", () => {
  const [m] = parseInbound(
    envelope([
      { id: "wamid.1", from: "2348012345678", type: "text", timestamp: "1700000000", text: { body: "how much" } },
    ]),
  );
  assert.equal(m.type, "text");
  assert.equal(m.text, "how much");
  assert.equal(m.from, "2348012345678");
  assert.equal(m.phoneNumberId, "PNID1");
  assert.equal(m.profileName, "Ada");
  assert.equal(m.timestamp.getTime(), 1700000000 * 1000);
});

test("template quick-reply taps parse as interactive, not unsupported", () => {
  // Meta delivers these as type "button", not "interactive". Parsing them as
  // unsupported meant a customer who tapped the button we sent them got
  // "could you type what you're looking for?" back.
  const [m] = parseInbound(
    envelope([
      {
        id: "wamid.2",
        from: "234801",
        type: "button",
        timestamp: "1700000000",
        button: { text: "Hold one for me", payload: "HOLD" },
      },
    ]),
  );
  assert.equal(m.type, "interactive");
  assert.equal(m.text, "Hold one for me");
});

test("interactive list and button replies both yield their title", () => {
  const [a, b] = parseInbound(
    envelope([
      {
        id: "wamid.3", from: "234801", type: "interactive", timestamp: "1700000000",
        interactive: { button_reply: { title: "Yes please" } },
      },
      {
        id: "wamid.4", from: "234801", type: "interactive", timestamp: "1700000000",
        interactive: { list_reply: { title: "Bento platter" } },
      },
    ]),
  );
  assert.equal(a.text, "Yes please");
  assert.equal(b.text, "Bento platter");
});

test("voice notes parse as audio under either Meta type name", () => {
  const [a, b] = parseInbound(
    envelope([
      { id: "w.5", from: "234801", type: "audio", timestamp: "1700000000", audio: { id: "media1" } },
      { id: "w.6", from: "234801", type: "voice", timestamp: "1700000000", voice: { id: "media2" } },
    ]),
  );
  assert.equal(a.type, "audio");
  assert.equal(a.mediaId, "media1");
  assert.equal(b.type, "audio");
  assert.equal(b.mediaId, "media2");
});

test("an image carries its caption as the text", () => {
  const [m] = parseInbound(
    envelope([
      {
        id: "w.7", from: "234801", type: "image", timestamp: "1700000000",
        image: { id: "img1", caption: "you get this one?" },
      },
    ]),
  );
  assert.equal(m.type, "image");
  assert.equal(m.mediaId, "img1");
  assert.equal(m.text, "you get this one?");
});

test("a missing timestamp does not become an Invalid Date", () => {
  // Number(undefined) is NaN, and new Date(NaN) inserts as null.
  const [m] = parseInbound(
    envelope([{ id: "w.8", from: "234801", type: "text", text: { body: "hi" } }]),
  );
  assert.ok(Number.isFinite(m.timestamp.getTime()));
});

test("status callbacks and empty payloads yield nothing", () => {
  assert.deepEqual(parseInbound({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), []);
  assert.deepEqual(parseInbound({}), []);
  assert.deepEqual(parseInbound(null), []);
});

test("batched messages all come back", () => {
  const out = parseInbound(
    envelope([
      { id: "w.9", from: "234801", type: "text", timestamp: "1700000000", text: { body: "one" } },
      { id: "w.10", from: "234801", type: "text", timestamp: "1700000001", text: { body: "two" } },
      { id: "w.11", from: "234801", type: "text", timestamp: "1700000002", text: { body: "three" } },
    ]),
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.text), ["one", "two", "three"]);
});

test("a missing contacts array does not throw", () => {
  const [m] = parseInbound(
    envelope([{ id: "w.12", from: "234801", type: "text", timestamp: "1700000000", text: { body: "hi" } }], []),
  );
  assert.equal(m.profileName, null);
});

/* ------------------------------------------------------------------ */
/* Truncation                                                          */
/* ------------------------------------------------------------------ */

test("short bodies pass through untouched", () => {
  assert.equal(truncate("hello", 4096), "hello");
});

test("long bodies cut at a word boundary", () => {
  const body = "word ".repeat(100);
  const out = truncate(body, 50);
  assert.ok(out.length <= 51, `got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("wor…"));
});

/* ------------------------------------------------------------------ */
/* Delivery failures                                                   */
/* ------------------------------------------------------------------ */

// Verbatim shape of the callback Meta sent on 2026-10-14 when the business
// account was locked. Every reply that night was "sent" with a 200 and a
// message id, then failed here, and the dashboard showed none of it.
const LOCKED = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "2194966971234276",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15556651416", phone_number_id: "1314863595053056" },
            statuses: [
              {
                id: "wamid.LOCKED1",
                status: "failed",
                timestamp: "1792008421",
                recipient_id: "2347042840480",
                errors: [
                  {
                    code: 131031,
                    title: "Business Account locked",
                    message: "Business Account locked",
                    error_data: { details: "Business account has been locked." },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ],
};

test("a failed delivery callback is read, with a reason the owner can act on", () => {
  assert.deepEqual(parseFailedStatuses(LOCKED), [
    { waMessageId: "wamid.LOCKED1", reason: "Meta has locked this business account (131031)" },
  ]);
});

test("delivered and read callbacks are not failures", () => {
  const ok: any = structuredClone(LOCKED);
  ok.entry[0].changes[0].value.statuses = [
    { id: "wamid.A", status: "sent" },
    { id: "wamid.B", status: "delivered" },
    { id: "wamid.C", status: "read" },
  ];
  assert.deepEqual(parseFailedStatuses(ok), []);
});

test("an unknown failure code falls back to Meta's own words", () => {
  const odd: any = structuredClone(LOCKED);
  odd.entry[0].changes[0].value.statuses[0].errors = [
    { code: 999999, title: "Something new", error_data: { details: "A reason Meta added later." } },
  ];
  assert.deepEqual(parseFailedStatuses(odd), [
    { waMessageId: "wamid.LOCKED1", reason: "A reason Meta added later. (999999)" },
  ]);
});

test("a failure callback is never mistaken for an inbound message", () => {
  assert.deepEqual(parseInbound(LOCKED), []);
  assert.deepEqual(parseFailedStatuses({}), []);
  assert.deepEqual(parseFailedStatuses(null), []);
});
