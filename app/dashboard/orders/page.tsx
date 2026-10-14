"use client";

/**
 * Orders.
 *
 * Drawn as paper tickets on a rail, because that is what an order is to a
 * food business — something you pull, prepare and hand over. Tapping one opens
 * the full receipt in a sheet, so the rest of the rail stays in view.
 *
 * Every status change goes through the set_order_status function, never a
 * direct UPDATE. Cancelling has to restore stock, and that restore has to
 * happen in the same transaction as the status flip — an order cancelled
 * without it holds its stock forever and the item stays unsellable.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, MapPin, NotebookPen, Phone, ReceiptText, Truck, User, Wallet } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../merchant-context";
import { fmtMoney, orderRef } from "@/lib/money";
import { chatStamp, Empty, phoneLabel, Pill, Sheet, SkeletonRows } from "../ui";

type Status = "draft" | "pending_payment" | "confirmed" | "fulfilled" | "cancelled";

type Row = {
  id: string;
  status: Status;
  total_minor: number;
  currency: "NGN" | "GHS";
  customer_name: string | null;
  customer_phone: string;
  created_at: string;
  item_count: number;
};

type Detail = {
  id: string;
  status: Status;
  subtotal_minor: number;
  delivery_minor: number;
  total_minor: number;
  currency: "NGN" | "GHS";
  delivery_address: string | null;
  notes: string | null;
  customer_name: string | null;
  customer_phone: string;
  items: {
    product_name: string;
    quantity: number;
    unit_price_minor: number;
    line_total_minor: number;
  }[];
};

const FILTERS: { key: Status | ""; label: string }[] = [
  { key: "", label: "All" },
  { key: "pending_payment", label: "Awaiting payment" },
  { key: "confirmed", label: "Paid" },
  { key: "fulfilled", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

export default function OrdersPage() {
  const merchant = useMerchant();
  const [status, setStatus] = useState<Status | "">("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await browserClient().rpc("recent_orders", {
      p_merchant_id: merchant.id,
      p_status: status || null,
      p_limit: 50,
    });
    if (error) setError(error.message);
    else {
      setRows((data ?? []) as Row[]);
      setError(null);
    }
  }, [merchant.id, status]);

  useEffect(() => {
    setRows(null);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function openOrder(id: string) {
    const { data, error } = await browserClient().rpc("order_summary", { p_order_id: id });
    if (error) setError(error.message);
    else {
      setCancelling(false);
      setReason("");
      setOpen(data as Detail);
    }
  }

  const close = useCallback(() => setOpen(null), []);

  async function transition(id: string, to: Status, note?: string) {
    setBusy(true);
    const { data, error } = await browserClient().rpc("set_order_status", {
      p_merchant_id: merchant.id,
      p_order_id: id,
      p_status: to,
      p_actor: "dashboard",
      p_note: note || null,
    });
    setBusy(false);

    if (error) {
      setError(friendly(error.message));
      return;
    }
    setError(null);
    setCancelling(false);
    setOpen(data as Detail);
    await load();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Orders</h1>
          <p className="page-sub">
            Stock comes off the catalogue the moment an order is placed. Cancelling puts it back.
          </p>
        </div>
      </div>

      <div className="chips" role="toolbar" aria-label="Filter orders">
        {FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={status === f.key} onClick={() => setStatus(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="banner error">{error}</div>}

      {rows === null ? (
        <SkeletonRows n={3} h={150} />
      ) : rows.length === 0 ? (
        <Empty icon={ReceiptText} title={status ? "Nothing in this state" : "No orders yet"}>
          Orders the assistant takes on WhatsApp land here with their total already worked out.
        </Empty>
      ) : (
        <div className="tickets">
          {rows.map((o) => (
            <button key={o.id} className={`ticket ${o.status}`} onClick={() => openOrder(o.id)}>
              <div className="ticket-body">
                <div className="ticket-top">
                  <span className="ticket-ref">#{orderRef(o.id)}</span>
                  <Pill status={o.status} />
                </div>
                <div className="ticket-who">
                  {o.customer_name || "Customer"}
                  <span>
                    {o.item_count} item{o.item_count === 1 ? "" : "s"} · {chatStamp(o.created_at)}
                  </span>
                </div>
                <div className="ticket-total">
                  <span>Total</span>
                  <strong>{fmtMoney(o.total_minor, o.currency)}</strong>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <Sheet
          onClose={close}
          title={
            <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="mono">#{orderRef(open.id)}</span>
              <Pill status={open.status} />
            </span>
          }
          footer={
            cancelling ? (
              <>
                <button className="ghost" disabled={busy} onClick={() => setCancelling(false)}>
                  Keep order
                </button>
                <button className="danger" disabled={busy} onClick={() => transition(open.id, "cancelled", reason.trim())}>
                  Cancel & restock
                </button>
              </>
            ) : (
              <>
                {open.status === "pending_payment" && (
                  <button disabled={busy} onClick={() => transition(open.id, "confirmed")}>
                    <Wallet /> Mark paid
                  </button>
                )}
                {(open.status === "pending_payment" || open.status === "confirmed") && (
                  <button
                    className={open.status === "confirmed" ? undefined : "ghost"}
                    disabled={busy}
                    onClick={() => transition(open.id, "fulfilled")}
                  >
                    <Truck /> Mark delivered
                  </button>
                )}
                {open.status !== "cancelled" && open.status !== "fulfilled" && (
                  <button className="danger" disabled={busy} onClick={() => setCancelling(true)}>
                    Cancel order
                  </button>
                )}
                {(open.status === "cancelled" || open.status === "fulfilled") && (
                  <button className="ghost" onClick={close}>
                    <CircleCheck /> Done
                  </button>
                )}
              </>
            )
          }
        >
          <div className="facts">
            <div className="fact">
              <User aria-hidden />
              <span>{open.customer_name || "Customer"}</span>
            </div>
            <div className="fact">
              <Phone aria-hidden />
              <span className="mono">{phoneLabel(open.customer_phone)}</span>
            </div>
            {open.delivery_address && (
              <div className="fact">
                <MapPin aria-hidden />
                <span>{open.delivery_address}</span>
              </div>
            )}
            {open.notes && (
              <div className="fact">
                <NotebookPen aria-hidden />
                <span className="muted">{open.notes}</span>
              </div>
            )}
          </div>

          <div className="receipt">
            {open.items.map((i, n) => (
              <div className="receipt-row" key={n}>
                <span>
                  {i.quantity} × {i.product_name}
                </span>
                <span>{fmtMoney(i.line_total_minor, open.currency)}</span>
              </div>
            ))}
            {open.delivery_minor > 0 && (
              <div className="receipt-row muted">
                <span>Delivery</span>
                <span>{fmtMoney(open.delivery_minor, open.currency)}</span>
              </div>
            )}
            <div className="receipt-row total">
              <span>Total</span>
              <span>{fmtMoney(open.total_minor, open.currency)}</span>
            </div>
          </div>

          {cancelling && (
            <div className="field">
              <label htmlFor="cancel-reason">Why is it being cancelled? (optional)</label>
              <textarea
                id="cancel-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Customer changed their mind, couldn't pay…"
              />
              <div className="hint">
                Stock for every item on this order goes back on the catalogue straight away.
              </div>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

/** Postgres exception strings are not customer-facing prose. */
function friendly(msg: string): string {
  if (msg.includes("ORDER_TERMINAL")) {
    return "That order is already delivered or cancelled — it can't be changed.";
  }
  if (msg.includes("ORDER_NOT_FOUND")) return "That order no longer exists.";
  return msg;
}
