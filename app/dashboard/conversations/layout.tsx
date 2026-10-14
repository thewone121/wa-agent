"use client";

/**
 * The inbox.
 *
 * Phone: the chat list, and opening a chat takes the whole screen — exactly
 * how WhatsApp behaves, which is the app the owner already knows by heart.
 * From 1100px: list on the left, thread on the right, like WhatsApp Web.
 *
 * The list lives here rather than in page.tsx so it stays mounted (and keeps
 * its scroll position) while the owner moves between threads.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MessagesSquare, Sparkles } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../merchant-context";
import { Avatar, chatStamp, Empty, phoneLabel, samePhone, SkeletonRows } from "../ui";
import { InboxContext } from "./inbox-context";

type Row = {
  id: string;
  status: "open" | "escalated" | "closed";
  customer_name: string | null;
  customer_phone: string;
  last_message_at: string;
  window_expires_at: string | null;
  escalation_reason: string | null;
  last_body: string | null;
  message_count: number;
};

const FILTERS = [
  { key: "", label: "All" },
  { key: "escalated", label: "Waiting on you" },
  { key: "open", label: "Bot handling" },
  { key: "closed", label: "Closed" },
] as const;

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="inbox-list"><SkeletonRows n={6} h={68} /></div>}>
      <Inbox>{children}</Inbox>
    </Suspense>
  );
}

function Inbox({ children }: { children: React.ReactNode }) {
  const merchant = useMerchant();
  const pathname = usePathname();
  const params = useSearchParams();

  const activeId = pathname.match(/^\/dashboard\/conversations\/([^/]+)/)?.[1] ?? null;

  const [status, setStatus] = useState<string>(params.get("status") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await browserClient().rpc("conversation_list", {
      p_merchant_id: merchant.id,
      p_status: status || null,
      p_limit: 100,
    });
    if (error) setError(error.message);
    else {
      // The owner's own number is a command line, not a customer — lib/owner.ts
      // treats every message from it as an instruction. The webhook still logs
      // those messages to a conversation (that row is its duplicate-delivery
      // guard), but listing it here put the owner in their own customer inbox.
      setRows(
        ((data ?? []) as Row[]).filter((r) => !samePhone(r.customer_phone, merchant.escalation_number)),
      );
      setError(null);
    }
  }, [merchant.id, merchant.escalation_number, status]);

  useEffect(() => {
    setRows(null);
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const waiting = rows?.filter((r) => r.status === "escalated").length ?? 0;

  return (
    <InboxContext.Provider value={{ refresh: load }}>
      <div className="inbox" data-thread={activeId ? "true" : "false"}>
        <section className="inbox-list" aria-label="Chats">
          <div className="page-head">
            <div>
              <h1 className="page-title">Chats</h1>
              <p className="page-sub">
                {waiting > 0
                  ? `${waiting} waiting on you. The assistant has stepped back from ${waiting === 1 ? "it" : "those"}.`
                  : "Every conversation the assistant has had with your customers."}
              </p>
            </div>
            <Link href="/dashboard/try" className="btn ghost small">
              <Sparkles /> Try it
            </Link>
          </div>

          <div className="chips" role="toolbar" aria-label="Filter chats">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className="chip"
                aria-pressed={status === f.key}
                onClick={() => setStatus(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {error && <div className="banner error">{error}</div>}

          {rows === null ? (
            <SkeletonRows n={6} h={68} />
          ) : rows.length === 0 ? (
            <Empty icon={MessagesSquare} title="No chats here yet">
              {status === "escalated"
                ? "Nothing is waiting on you."
                : "When a customer messages your WhatsApp number, the conversation appears here."}
            </Empty>
          ) : (
            <ul className="chat-list">
              {rows.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/conversations/${c.id}`}
                    className={`chat-row${c.status === "escalated" ? " waiting" : ""}`}
                    aria-current={c.id === activeId ? "page" : undefined}
                  >
                    <Avatar name={c.customer_name} phone={c.customer_phone} />
                    <div className="chat-body">
                      <div className="chat-top">
                        <span className="chat-name">{c.customer_name || phoneLabel(c.customer_phone)}</span>
                        <span className="chat-time">{chatStamp(c.last_message_at)}</span>
                      </div>
                      <div className="chat-bottom">
                        <span className="chat-preview">{c.last_body ?? "—"}</span>
                        <RowFlag row={c} />
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="inbox-thread" aria-label="Conversation">
          {children}
        </section>
      </div>
    </InboxContext.Provider>
  );
}

/**
 * One flag per row, most urgent first. Meta's 24h service window matters
 * because once it closes a free-form reply will not deliver — only an approved
 * template will. Surfacing it is the difference between "they didn't answer"
 * and "you can't answer".
 */
function RowFlag({ row }: { row: Row }) {
  if (row.status === "escalated") return <span className="chat-flag">Waiting on you</span>;
  if (!row.window_expires_at || row.status === "closed") return null;

  const ms = new Date(row.window_expires_at).getTime() - Date.now();
  if (ms <= 0) {
    return (
      <span className="chat-flag closed-window" title="Only an approved template will deliver now">
        Window closed
      </span>
    );
  }
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 3) return <span className="chat-flag window">{hours}h left</span>;
  return null;
}
