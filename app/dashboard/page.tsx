"use client";

/**
 * Home.
 *
 * Ordered by what the owner has to DO. "Needs you" comes first because it is
 * the only part of the page that asks for action; the month's figures come
 * after, because they are for reading.
 *
 * The number that matters most below the fold is margin: plan revenue minus
 * what the month's AI replies actually cost. The v1 schema aggregated AI spend
 * and nothing ever displayed it, so the ₦35k plan was priced on an assumption
 * nobody could check. This is where that assumption gets checked.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BellRing,
  ChevronRight,
  CircleCheck,
  Hand,
  PackageX,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "./merchant-context";
import { fmtMoney } from "@/lib/money";
import { greeting, SkeletonRows } from "./ui";

type Overview = {
  usage: {
    period_month: string;
    ai_replies: number;
    service_messages: number;
    template_messages: number;
    ai_cost_minor: number;
    overage_replies: number;
    reply_cap: number;
    plan_price_minor: number;
    overage_price_minor: number;
    currency: "NGN" | "GHS";
  };
  open_conversations: number;
  escalated_conversations: number;
  messages_today: number;
  orders_pending: number;
  revenue_month_minor: number;
  out_of_stock: number;
  pending_alerts: number;
};

export default function HomePage() {
  const merchant = useMerchant();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data, error } = await browserClient().rpc("dashboard_overview", {
        p_merchant_id: merchant.id,
      });
      if (cancelled) return;
      if (error) setError(error.message);
      else setData(data as Overview);
    }

    load();
    // The owner leaves this open while working. A 30s poll is enough to feel
    // live without a realtime subscription to maintain.
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [merchant.id]);

  const head = (
    <div className="page-head">
      <div>
        <div className="eyebrow">{greeting()}</div>
        <h1 className="page-title">{merchant.name}</h1>
        <p className="page-sub">
          {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
        </p>
      </div>
    </div>
  );

  if (error) {
    return (
      <>
        {head}
        <div className="banner error">{error}</div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        {head}
        <SkeletonRows n={3} />
      </>
    );
  }

  const u = data.usage;
  const cur = u.currency;

  const overageRevenue = u.overage_replies * u.overage_price_minor;
  const margin = u.plan_price_minor + overageRevenue - u.ai_cost_minor;
  const capUsed = u.reply_cap > 0 ? Math.round((u.ai_replies / u.reply_cap) * 100) : 0;
  const capTone = capUsed >= 100 ? "bad" : capUsed >= 80 ? "warn" : "";

  // Meta gives 1,000 free service messages per number per month; past that
  // each one is billed, and it comes out of the same plan revenue.
  const freeServiceLeft = Math.max(1000 - u.service_messages, 0);

  const monthLabel = (() => {
    const [y, mo] = u.period_month.split("-").map(Number);
    return new Date(y, (mo || 1) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  })();

  const todos: { tone: "attn" | "warn" | "calm"; icon: LucideIcon; title: string; detail: string; href?: string }[] = [];

  if (data.escalated_conversations > 0) {
    const n = data.escalated_conversations;
    todos.push({
      tone: "attn",
      icon: Hand,
      title: `${n} chat${n === 1 ? "" : "s"} waiting on you`,
      detail: `The assistant has stepped back from ${n === 1 ? "this one" : "these"} until you reply.`,
      href: "/dashboard/conversations?status=escalated",
    });
  }
  if (data.orders_pending > 0) {
    const n = data.orders_pending;
    todos.push({
      tone: "warn",
      icon: Wallet,
      title: `${n} order${n === 1 ? "" : "s"} awaiting payment`,
      detail: "Mark them paid once the transfer lands.",
      href: "/dashboard/orders",
    });
  }
  if (data.out_of_stock > 0) {
    const n = data.out_of_stock;
    todos.push({
      tone: "warn",
      icon: PackageX,
      title: `${n} item${n === 1 ? "" : "s"} out of stock`,
      detail: "The assistant won't sell these until you restock.",
      href: "/dashboard/products",
    });
  }
  if (data.pending_alerts > 0) {
    const n = data.pending_alerts;
    todos.push({
      tone: "calm",
      icon: BellRing,
      title: `${n} restock alert${n === 1 ? "" : "s"} queued`,
      detail: "Customers who asked will be messaged within the hour.",
    });
  }

  return (
    <>
      {head}

      <h2 className="section-title" style={{ marginTop: 4 }}>
        Needs you
      </h2>
      <div className="todo">
        {todos.length === 0 ? (
          <div className="todo-item calm">
            <span className="todo-icon">
              <CircleCheck />
            </span>
            <div className="todo-text">
              <strong>All quiet</strong>
              <span>The assistant is handling every chat. Nothing is waiting on you.</span>
            </div>
          </div>
        ) : (
          todos.map((t) => {
            const Icon = t.icon;
            const inner = (
              <>
                <span className="todo-icon">
                  <Icon />
                </span>
                <div className="todo-text">
                  <strong>{t.title}</strong>
                  <span>{t.detail}</span>
                </div>
                {t.href && <ChevronRight aria-hidden />}
              </>
            );
            return t.href ? (
              <Link key={t.title} href={t.href} className={`todo-item ${t.tone}`}>
                {inner}
              </Link>
            ) : (
              <div key={t.title} className={`todo-item ${t.tone}`}>
                {inner}
              </div>
            );
          })
        )}
      </div>

      <h2 className="section-title">
        This month <small>{monthLabel}</small>
      </h2>
      <div className="figures">
        <div className="figure hero">
          <div>
            <div className="figure-label">Sales the assistant closed</div>
            <div className="figure-value">{fmtMoney(data.revenue_month_minor, cur)}</div>
          </div>
          <div className="figure-note">Paid and delivered orders</div>
        </div>

        <div className="figure">
          <div className="figure-label">Replies used</div>
          <div className="figure-value">
            {u.ai_replies.toLocaleString()}
            <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>
              {" "}
              / {u.reply_cap.toLocaleString()}
            </span>
          </div>
          <div className={`meter ${capTone}`} aria-label={`${capUsed}% of allowance used`}>
            <span style={{ width: `${Math.min(capUsed, 100)}%` }} />
          </div>
        </div>

        <div className="figure">
          <div className="figure-label">Margin</div>
          <div className={`figure-value${margin < 0 ? " bad" : ""}`}>{fmtMoney(margin, cur)}</div>
          <div className="figure-note">after {fmtMoney(u.ai_cost_minor, cur)} of AI</div>
        </div>

        <div className="figure">
          <div className="figure-label">Messages today</div>
          <div className="figure-value">{data.messages_today}</div>
        </div>

        <div className="figure">
          <div className="figure-label">Open chats</div>
          <div className="figure-value">{data.open_conversations}</div>
        </div>
      </div>

      <h2 className="section-title">Where the money goes</h2>
      <div className="panel">
        {u.ai_replies === 0 ? (
          <div className="empty" style={{ padding: "26px 16px" }}>
            No replies yet this month.
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              <LedgerRow
                k="AI cost per reply"
                v={fmtMoney(Math.round(u.ai_cost_minor / u.ai_replies), cur)}
                hint="averaged across this month"
              />
              <LedgerRow
                k="Plan revenue per reply"
                v={fmtMoney(Math.round(u.plan_price_minor / Math.max(u.reply_cap, 1)), cur)}
                hint="if the full allowance is used"
              />
              <LedgerRow
                k="Meta service messages"
                v={u.service_messages.toLocaleString()}
                hint={
                  freeServiceLeft > 0
                    ? `${freeServiceLeft.toLocaleString()} of the free 1,000 left`
                    : "past the free 1,000 — every reply is now billed by Meta too"
                }
              />
              {u.template_messages > 0 && (
                <LedgerRow
                  k="Restock alerts sent"
                  v={u.template_messages.toLocaleString()}
                  hint="marketing templates, ~₦70 each"
                />
              )}
              {u.overage_replies > 0 && (
                <LedgerRow
                  k="Replies past the allowance"
                  v={u.overage_replies.toLocaleString()}
                  hint={`${fmtMoney(overageRevenue, cur)} billable overage`}
                />
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function LedgerRow({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <tr>
      <td>
        {k}
        {hint && <div className="hint">{hint}</div>}
      </td>
      <td>{v}</td>
    </tr>
  );
}
