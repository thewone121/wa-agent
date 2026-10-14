"use client";

/**
 * Small pieces every dashboard page shares.
 *
 * Kept deliberately plain: no component library, nothing that ships more
 * JavaScript than the markup it replaces. Pages own their data; these only
 * draw it.
 */

import { useEffect, useRef } from "react";
import { X, type LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

// A short, deliberately chosen set rather than a hash into the full hue wheel,
// so no two adjacent customers land on muddy or unreadable colours.
const AVATAR_COLOURS = ["#0b5d3f", "#b45309", "#1d4ed8", "#9d174d", "#0e7490", "#6d28d9", "#a16207", "#be123c"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string | null, phone: string): string {
  const n = (name ?? "").trim();
  if (!n) return phone.slice(-2);
  const parts = n.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || n[0].toUpperCase();
}

export function Avatar({
  name,
  phone,
  small,
}: {
  name: string | null;
  phone: string;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar${small ? " sm" : ""}`}
      style={{ background: AVATAR_COLOURS[hash(phone) % AVATAR_COLOURS.length] }}
      aria-hidden
    >
      {initials(name, phone)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  open: "Bot handling",
  escalated: "Waiting on you",
  closed: "Closed",
  draft: "Draft",
  pending_payment: "Awaiting payment",
  confirmed: "Paid",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

export function Pill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{statusLabel(status)}</span>;
}

/* ------------------------------------------------------------------ */
/* Empty and loading states                                            */
/* ------------------------------------------------------------------ */

export function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon aria-hidden />
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

export function SkeletonRows({ n = 4, h = 64 }: { n?: number; h?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-busy aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

/**
 * Bottom sheet on a phone, right-hand drawer on desktop — the same component,
 * the CSS decides. A modal would cover the order list the owner is working
 * through; a sheet keeps it one swipe away.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" tabIndex={-1} ref={panel}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <div className="sheet-title">{title}</div>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time and model labels                                               */
/* ------------------------------------------------------------------ */

/** WhatsApp-style relative stamp: "14:05" today, "Yesterday", then a date. */
export function chatStamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";

  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * "moonshotai/kimi-k2.6" → "kimi-k2.6", "nvidia/nemotron-3-super-120b-a12b:free"
 * → "nemotron-3-super". The provider prefix and the :free/:batch routing
 * suffix are OpenRouter plumbing, not something the owner needs to read.
 */
export function shortModel(model: string): string {
  const bare = model.split("/").pop()!.split(":")[0];
  const parts = bare.split("-");
  return parts.length > 3 ? parts.slice(0, 3).join("-") : bare;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
