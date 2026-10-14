"use client";

/**
 * Dashboard shell: auth guard, merchant resolution, navigation.
 *
 * The guard here is a redirect for UX, not a security boundary. The actual
 * boundary is RLS in Postgres: every query the browser makes is filtered by
 * `auth.uid()`, so a user who somehow rendered this page without a session
 * would see empty tables rather than someone else's data.
 *
 * Navigation is a bottom tab bar on phones and a left rail from 900px. The
 * owner mostly opens this on a phone, one-handed, so the five destinations
 * sit where a thumb already is.
 */

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  House,
  LogOut,
  MessagesSquare,
  Package,
  ReceiptText,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { MerchantProvider, type DashboardMerchant } from "./merchant-context";
import { SkeletonRows } from "./ui";

type NavItem = { href: string; label: string; icon: LucideIcon; badge?: "chats" | "orders" };

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/dashboard/conversations", label: "Chats", icon: MessagesSquare, badge: "chats" },
  { href: "/dashboard/orders", label: "Orders", icon: ReceiptText, badge: "orders" },
  { href: "/dashboard/products", label: "Catalogue", icon: Package },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

type Counts = { chats: number; orders: number };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [merchant, setMerchant] = useState<DashboardMerchant | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "no-merchant" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({ chats: 0, orders: 0 });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const db = browserClient();

        const {
          data: { session },
        } = await db.auth.getSession();

        if (!session) {
          router.replace("/login");
          return;
        }

        const { data, error } = await db.rpc("my_merchant");
        if (cancelled) return;

        if (error) {
          setError(error.message);
          setState("error");
          return;
        }
        if (!data) {
          // Authenticated but owns no merchant row — the state you land in
          // after creating the auth user but before running the seed script.
          setState("no-merchant");
          return;
        }

        setMerchant(data as DashboardMerchant);
        setState("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  /* The badges are the reason to open the app at all: something is waiting.
     One cheap call every 30s keeps them honest without a realtime channel. */
  useEffect(() => {
    if (!merchant) return;
    let cancelled = false;

    async function poll() {
      const { data } = await browserClient().rpc("dashboard_overview", {
        p_merchant_id: merchant!.id,
      });
      if (cancelled || !data) return;
      setCounts({
        chats: Number(data.escalated_conversations ?? 0),
        orders: Number(data.orders_pending ?? 0),
      });
    }

    poll();
    const t = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [merchant, pathname]);

  async function signOut() {
    await browserClient().auth.signOut();
    router.replace("/login");
  }

  if (state === "loading") {
    return (
      <div className="main" style={{ paddingTop: 40 }}>
        <SkeletonRows n={5} />
      </div>
    );
  }

  if (state === "error" || state === "no-merchant") {
    return (
      <div className="landing">
        <div className="landing-card">
          <h1 className="page-title">
            {state === "error" ? "Couldn't load your account" : "No business linked"}
          </h1>
          <p className="page-sub">
            {state === "error" ? (
              error
            ) : (
              <>
                This account is signed in but doesn&apos;t own a merchant yet. Run{" "}
                <code>npm run seed</code> with this user as the first account in Supabase →
                Authentication → Users.
              </>
            )}
          </p>
          <div>
            <button className="ghost" onClick={signOut}>
              <LogOut /> Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const m = merchant!;
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
  // Full-screen on a phone: an open chat, and the try-it screen (which is one).
  const inChat =
    /^\/dashboard\/conversations\/[^/]+/.test(pathname) || pathname.startsWith("/dashboard/try");
  const flush = pathname.startsWith("/dashboard/conversations") || pathname.startsWith("/dashboard/try");
  const badgeFor = (item: NavItem) => (item.badge ? counts[item.badge] : 0);

  return (
    <MerchantProvider value={m}>
      <div className="app" data-focus={inChat ? "chat" : undefined}>
        <aside className="rail">
          <StoreBadge merchant={m} />

          <nav className="rail-nav" aria-label="Main">
            {NAV.map((item) => {
              const Icon = item.icon;
              const n = badgeFor(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rail-link${isActive(item.href) ? " active" : ""}`}
                  aria-current={isActive(item.href) ? "page" : undefined}
                >
                  <Icon aria-hidden />
                  {item.label}
                  {n > 0 && <span className="count">{n}</span>}
                </Link>
              );
            })}
            <Link
              href="/dashboard/try"
              className={`rail-link rail-try${pathname.startsWith("/dashboard/try") ? " active" : ""}`}
              aria-current={pathname.startsWith("/dashboard/try") ? "page" : undefined}
            >
              <Sparkles aria-hidden />
              Try it as a customer
            </Link>
          </nav>

          <div className="rail-foot">
            <span className={`live${m.is_active ? "" : " off"}`}>
              {m.is_active ? "Assistant is live" : "Assistant paused"}
            </span>
            <button onClick={signOut}>
              <LogOut /> Sign out
            </button>
          </div>
        </aside>

        <div style={{ minWidth: 0 }}>
          <header className="topbar">
            <StoreBadge merchant={m} />
            <span className={`live${m.is_active ? "" : " off"}`}>
              {m.is_active ? "Live" : "Paused"}
            </span>
          </header>

          <main className={`main${flush ? " flush" : ""}`}>{children}</main>
        </div>

        <nav className="tabbar" aria-label="Main">
          {NAV.map((item) => {
            const Icon = item.icon;
            const n = badgeFor(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`tab${isActive(item.href) ? " active" : ""}`}
                aria-current={isActive(item.href) ? "page" : undefined}
              >
                <Icon aria-hidden />
                {item.label}
                {n > 0 && <span className="dot">{n > 9 ? "9+" : n}</span>}
              </Link>
            );
          })}
        </nav>
      </div>
    </MerchantProvider>
  );
}

function StoreBadge({ merchant }: { merchant: DashboardMerchant }) {
  return (
    <div className="store">
      <span className="store-mark" aria-hidden>
        {merchant.name.trim()[0]?.toUpperCase() ?? "S"}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="store-name">{merchant.name}</div>
        <div className="store-sub">{merchant.wa_display_number ?? "No number linked"}</div>
      </div>
    </div>
  );
}
