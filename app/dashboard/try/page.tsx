"use client";

/**
 * Try it as a customer.
 *
 * The live demo: hand someone the laptop, they type like a customer, and the
 * real assistant answers from the real catalogue through /api/simulate — the
 * same turn a WhatsApp customer gets. The conversation lands in Chats and any
 * order in Orders, so the person watching sees cause and effect instead of
 * being asked to believe sample data.
 *
 * Drawn from the CUSTOMER's side, mirrored from the owner's transcript view:
 * their messages on the right in green, the shop's replies on the left. That
 * is what they would see on their own WhatsApp.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, MessagesSquare, ReceiptText, RotateCcw, SendHorizontal } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../merchant-context";
import { fmtMoney } from "@/lib/money";
import { clock, shortModel } from "../ui";

type Line =
  | { kind: "customer"; body: string; at: string }
  | { kind: "shop"; body: string; at: string; model?: string | null; costMinor?: number | null }
  | { kind: "order"; ref: string; totalMinor: number | null }
  | { kind: "handover" }
  | { kind: "muted" };

type Session = { phone: string; name: string; conversationId: string | null };

const STORE_KEY = "wa-agent:try-session";

function newPhone(): string {
  // 000 + nine digits. No real E.164 number starts with 0, so this can never
  // collide with a real customer; the server enforces the same pattern.
  let digits = "";
  for (let i = 0; i < 9; i++) digits += Math.floor(Math.random() * 10);
  return `000${digits}`;
}

/** "Thrill Bites" → "Thrill Bites'", "Mama Put" → "Mama Put's". */
function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Private windows can refuse storage. The demo still works; a reload just
    // starts a fresh customer.
  }
}

export default function TryItPage() {
  const merchant = useMerchant();

  const [session, setSession] = useState<Session | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  /* Pick up where the last session left off, from the database rather than
     from memory — so what you see after a reload is what was really stored. */
  useEffect(() => {
    const s = loadSession();
    if (!s) return;
    setSession(s);
    if (!s.conversationId) return;

    browserClient()
      .rpc("conversation_transcript", { p_conversation_id: s.conversationId, p_limit: 200 })
      .then(({ data }) => {
        const msgs = (data?.messages ?? []) as {
          direction: "inbound" | "outbound";
          body: string | null;
          model: string | null;
          cost_minor: number | null;
          created_at: string;
        }[];
        setLines(
          msgs
            .filter((m) => m.body)
            .map((m) =>
              m.direction === "inbound"
                ? { kind: "customer" as const, body: m.body!, at: m.created_at }
                : {
                    kind: "shop" as const,
                    body: m.body!,
                    at: m.created_at,
                    model: m.model,
                    costMinor: m.cost_minor,
                  },
            ),
        );
      });
  }, []);

  /* Suggested openers built from the live catalogue, so they work for any
     merchant rather than only the demo one. */
  useEffect(() => {
    browserClient()
      .from("products")
      .select("name")
      .eq("merchant_id", merchant.id)
      .eq("is_active", true)
      .order("price_minor")
      .limit(3)
      .then(({ data }) => {
        const names = (data ?? []).map((p) => p.name as string);
        const a = names[0] ?? "your cheapest item";
        const b = names[names.length - 1] ?? a;
        setSuggestions([
          `abeg how much be the ${a}?`,
          `I need food for 50 guests this Saturday, what do you recommend?`,
          `last price for the ${b}? reduce am small`,
        ]);
      });
  }, [merchant.id]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, busy]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy) return;

      const s: Session = session ?? {
        phone: newPhone(),
        name: nameDraft.trim() || "Test customer",
        conversationId: null,
      };
      if (!session) {
        setSession(s);
        saveSession(s);
      }

      setError(null);
      setDraft("");
      setLines((l) => [...l, { kind: "customer", body, at: new Date().toISOString() }]);
      setBusy(true);

      try {
        const {
          data: { session: auth },
        } = await browserClient().auth.getSession();

        const res = await fetch("/api/simulate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth?.access_token ?? ""}`,
          },
          body: JSON.stringify({ text: body, phone: s.phone, name: s.name }),
        });
        const out = await res.json().catch(() => ({}));

        if (out.conversationId && out.conversationId !== s.conversationId) {
          const next = { ...s, conversationId: out.conversationId as string };
          setSession(next);
          saveSession(next);
        }

        if (!res.ok) {
          setError(out.error ?? "Something went wrong. Try again.");
          return;
        }

        const now = new Date().toISOString();
        setLines((l) => {
          const add: Line[] = (out.replies ?? []).map((r: string, i: number, all: string[]) => ({
            kind: "shop" as const,
            body: r,
            at: now,
            // Only the AI reply carries a model and cost; a throttle notice doesn't.
            model: i === all.length - 1 ? out.model : null,
            costMinor: i === all.length - 1 ? out.costMinor : null,
          }));
          if (out.orderRef) add.push({ kind: "order", ref: out.orderRef, totalMinor: out.orderTotalMinor ?? null });
          if (out.escalated) add.push({ kind: "handover" });
          if (out.muted) add.push({ kind: "muted" });
          return [...l, ...add];
        });
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      } finally {
        setBusy(false);
        input.current?.focus();
      }
    },
    [busy, session, nameDraft],
  );

  function reset() {
    saveSession(null);
    setSession(null);
    setLines([]);
    setError(null);
    setNameDraft("");
    input.current?.focus();
  }

  const spend = lines.reduce((sum, l) => sum + (l.kind === "shop" ? Number(l.costMinor ?? 0) : 0), 0);
  const replies = lines.filter((l) => l.kind === "shop").length;
  const orders = lines.filter((l): l is Extract<Line, { kind: "order" }> => l.kind === "order");
  const handedOver = lines.some((l) => l.kind === "handover" || l.kind === "muted");
  const lastModel = [...lines].reverse().find((l) => l.kind === "shop" && l.model) as
    | Extract<Line, { kind: "shop" }>
    | undefined;

  return (
    <div className="try">
      <div className="thread try-chat">
        <header className="thread-head">
          <Link href="/dashboard" className="thread-back" aria-label="Back to dashboard">
            <ChevronLeft />
          </Link>
          <span className="store-mark round" aria-hidden>
            {merchant.name.trim()[0]?.toUpperCase() ?? "S"}
          </span>
          <div className="thread-who">
            <strong>{merchant.name}</strong>
            <span>{busy ? "typing…" : session ? `You're ${session.name}` : "Try it — you're the customer"}</span>
          </div>
          {session && (
            <button className="ghost small new-customer" onClick={reset} disabled={busy}>
              <RotateCcw /> <span className="label">New customer</span>
            </button>
          )}
        </header>

        <div className="thread-scroll" ref={scroller}>
          <div className="thread-inner">
            {lines.length === 0 && (
              <div className="try-intro">
                <h2>You&apos;re the customer now</h2>
                <p>
                  Type anything a customer would send on WhatsApp — Pidgin is fine. The assistant answers from{" "}
                  {possessive(merchant.name)} real catalogue and prices, and whatever it does appears in Chats
                  and Orders.
                </p>
                <div className="field">
                  <label htmlFor="try-name">Customer name (optional)</label>
                  <input
                    id="try-name"
                    value={nameDraft}
                    placeholder="e.g. Mrs Adeyemi"
                    onChange={(e) => setNameDraft(e.target.value)}
                  />
                </div>
                <div className="suggest">
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {lines.map((l, i) => (
              <Fragment key={i}>
                {l.kind === "customer" && (
                  <div className="bubble outbound">
                    {l.body}
                    <div className="bubble-meta">
                      <span>{clock(l.at)}</span>
                    </div>
                  </div>
                )}
                {l.kind === "shop" && (
                  <div className="bubble inbound">
                    {l.body}
                    <div className="bubble-meta">
                      {l.model && <span className="model">{shortModel(l.model)}</span>}
                      {l.costMinor ? <span>{fmtMoney(l.costMinor, merchant.currency)}</span> : null}
                      <span>{clock(l.at)}</span>
                    </div>
                  </div>
                )}
                {l.kind === "order" && (
                  <div className="event order">
                    Order #{l.ref} created
                    {l.totalMinor != null ? ` · ${fmtMoney(l.totalMinor, merchant.currency)}` : ""} ·{" "}
                    <Link href="/dashboard/orders">see it in Orders</Link>
                  </div>
                )}
                {l.kind === "handover" && (
                  <div className="event handover-event">
                    Handed to the owner — the assistant won&apos;t negotiate.{" "}
                    {session?.conversationId && (
                      <Link href={`/dashboard/conversations/${session.conversationId}`}>See it in Chats</Link>
                    )}
                  </div>
                )}
                {l.kind === "muted" && (
                  <div className="event handover-event">
                    The owner has this chat now, so the assistant stays quiet until it&apos;s handed back.
                  </div>
                )}
              </Fragment>
            ))}

            {busy && (
              <div className="bubble inbound typing" aria-label="The assistant is typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="thread-note" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>
            {error}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <input
            ref={input}
            id="try-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type as a customer…"
            autoComplete="off"
            enterKeyHint="send"
            disabled={busy}
          />
          <button type="submit" className="send" aria-label="Send" disabled={busy || !draft.trim()}>
            <SendHorizontal />
          </button>
        </form>
      </div>

      <aside className="try-side">
        <div>
          <div className="eyebrow">Live demo</div>
          <h2 className="group-title">What&apos;s happening</h2>
          <p className="hint" style={{ marginTop: 6 }}>
            Every reply comes from the same assistant your WhatsApp customers will talk to, reading your live
            catalogue. Nothing on the left is scripted.
          </p>
        </div>

        <dl className="kv">
          <div>
            <dt>Customer</dt>
            <dd>{session?.name ?? "—"}</dd>
          </div>
          <div>
            <dt>Replies</dt>
            <dd>{replies}</dd>
          </div>
          <div>
            <dt>AI cost so far</dt>
            <dd>{fmtMoney(spend, merchant.currency)}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{lastModel?.model ? shortModel(lastModel.model) : "—"}</dd>
          </div>
          <div>
            <dt>Orders taken</dt>
            <dd>{orders.length ? orders.map((o) => `#${o.ref}`).join(", ") : "—"}</dd>
          </div>
          <div>
            <dt>Handed to owner</dt>
            <dd>{handedOver ? "Yes" : "No"}</dd>
          </div>
        </dl>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {session?.conversationId && (
            <Link href={`/dashboard/conversations/${session.conversationId}`} className="btn ghost">
              <MessagesSquare /> Open this chat in Chats
            </Link>
          )}
          <Link href="/dashboard/orders" className="btn ghost">
            <ReceiptText /> Open Orders
          </Link>
        </div>

        <p className="hint">
          Test customers are kept apart from real ones and are labelled &ldquo;Try-it session&rdquo; everywhere in
          the dashboard. Replies here are real AI calls and count towards this month&apos;s AI cost.
        </p>
      </aside>
    </div>
  );
}
