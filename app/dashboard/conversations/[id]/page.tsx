"use client";

/**
 * One conversation, as the customer saw it.
 *
 * The per-message cost and model are shown on every reply. That is the loop
 * SETUP.md asks for — "send me the transcripts where it gets things wrong" —
 * and seeing which turns went to the capable model, and what each cost, is how
 * the routing rules in lib/pricing.ts get tuned against real traffic instead
 * of guesses.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Check, ChevronLeft, Hand, Play, X } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../../merchant-context";
import { fmtMoney } from "@/lib/money";
import { Avatar, clock, dayLabel, shortModel, SkeletonRows, statusLabel } from "../../ui";
import { useInbox } from "../inbox-context";

type Msg = {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  media_type: string | null;
  model: string | null;
  cost_minor: number | null;
  send_error: string | null;
  created_at: string;
};

type Transcript = {
  conversation: {
    id: string;
    status: "open" | "escalated" | "closed";
    window_expires_at: string | null;
    escalated_at: string | null;
    escalation_reason: string | null;
    last_message_at: string;
    customer_name: string | null;
    customer_phone: string;
  };
  messages: Msg[];
};

export default function ThreadPage() {
  const merchant = useMerchant();
  const inbox = useInbox();
  const { id } = useParams<{ id: string }>();

  const [data, setData] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    const { data, error } = await browserClient().rpc("conversation_transcript", {
      p_conversation_id: id,
      p_limit: 200,
    });
    if (error) setError(error.message);
    else {
      setData(data as Transcript);
      setError(null);
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    lastCount.current = 0;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  // Land on the newest message, and follow new ones as they arrive — but only
  // when the count changes, so a poll doesn't yank the owner away from
  // something they scrolled up to read.
  useEffect(() => {
    const n = data?.messages.length ?? 0;
    if (n !== lastCount.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
      lastCount.current = n;
    }
  }, [data]);

  async function act(fn: "resume_conversation" | "close_conversation") {
    setBusy(true);
    const { error } = await browserClient().rpc(fn, {
      p_merchant_id: merchant.id,
      p_conversation_id: id,
    });
    setBusy(false);
    if (error) setError(error.message);
    else {
      await load();
      inbox.refresh();
    }
  }

  const back = (
    <Link href="/dashboard/conversations" className="thread-back" aria-label="Back to chats">
      <ChevronLeft />
    </Link>
  );

  if (error && !data) {
    return (
      <div className="thread">
        <div className="thread-head">{back}</div>
        <div style={{ padding: 16 }}>
          <div className="banner error">{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="thread">
        <div className="thread-head">{back}</div>
        <div className="thread-scroll">
          <div className="thread-inner">
            <SkeletonRows n={5} h={44} />
          </div>
        </div>
      </div>
    );
  }

  const c = data.conversation;
  const spend = data.messages.reduce((sum, m) => sum + Number(m.cost_minor ?? 0), 0);
  const handoverAt = c.status === "escalated" && c.escalated_at ? new Date(c.escalated_at).getTime() : null;
  let handoverShown = false;

  return (
    <div className="thread">
      <header className="thread-head">
        {back}
        <Avatar name={c.customer_name} phone={c.customer_phone} small />
        <div className="thread-who">
          <strong>{c.customer_name || `+${c.customer_phone}`}</strong>
          <span>
            {statusLabel(c.status)} · +{c.customer_phone} · {fmtMoney(spend, merchant.currency)} AI spend
          </span>
        </div>
      </header>

      <div className="thread-scroll" ref={scroller}>
        <div className="thread-inner">
          {data.messages.length === 0 && <div className="day">No messages yet</div>}

          {data.messages.map((m, i) => {
            const prev = data.messages[i - 1];
            const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();

            // Drop a marker at the point the assistant handed over, so the
            // owner can see exactly which message triggered it.
            let marker: React.ReactNode = null;
            if (handoverAt && !handoverShown && new Date(m.created_at).getTime() > handoverAt) {
              handoverShown = true;
              marker = <Handover reason={c.escalation_reason} />;
            }

            return (
              <Fragment key={m.id}>
                {newDay && <div className="day">{dayLabel(m.created_at)}</div>}
                {marker}
                <div className={`bubble ${m.direction}${m.send_error ? " failed" : ""}`}>
                  {m.body ?? <em className="muted">({m.media_type ?? "no text"})</em>}
                  <div className="bubble-meta">
                    {m.model && <span className="model">{shortModel(m.model)}</span>}
                    {m.cost_minor ? <span>{fmtMoney(m.cost_minor, merchant.currency)}</span> : null}
                    <span>{clock(m.created_at)}</span>
                    {/* One tick, not two. In WhatsApp two ticks mean "delivered",
                        and all the app knows is that Meta accepted the message.
                        If Meta later reports it failed, send_error is set and
                        the bubble turns red instead. */}
                    {m.direction === "outbound" && !m.send_error && (
                      <Check aria-label="Sent to WhatsApp">
                        <title>Sent to WhatsApp</title>
                      </Check>
                    )}
                  </div>
                  {m.send_error && <div className="bubble-error">Not delivered — {m.send_error}</div>}
                </div>
              </Fragment>
            );
          })}

          {handoverAt && !handoverShown && <Handover reason={c.escalation_reason} />}
        </div>
      </div>

      {error && (
        <div className="thread-note" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>
          {error}
        </div>
      )}

      {c.status === "escalated" && (
        <div className="thread-note">
          <Hand aria-hidden />
          <span>
            The assistant is muted here. Reply to +{c.customer_phone} on WhatsApp yourself, then hand
            it back.
          </span>
        </div>
      )}

      <footer className="thread-foot">
        {c.status === "escalated" && (
          <button disabled={busy} onClick={() => act("resume_conversation")}>
            <Play /> Hand back to assistant
          </button>
        )}
        {c.status === "open" && (
          <button className="ghost" disabled={busy} onClick={() => act("close_conversation")}>
            <X /> Close chat
          </button>
        )}
        {c.status === "escalated" && (
          <button className="ghost" disabled={busy} onClick={() => act("close_conversation")}>
            Close
          </button>
        )}
        {c.status === "closed" && (
          <button className="ghost" disabled={busy} onClick={() => act("resume_conversation")}>
            <Play /> Reopen
          </button>
        )}
      </footer>
    </div>
  );
}

function Handover({ reason }: { reason: string | null }) {
  return (
    <div className="handover">
      Handed to you{reason ? ` · ${reason}` : ""}
    </div>
  );
}
