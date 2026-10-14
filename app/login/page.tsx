"use client";

/**
 * Dashboard login.
 *
 * Supabase email/password against the same auth.users row that owns the
 * merchant. There is deliberately no sign-up form: merchants are onboarded by
 * you, and an open sign-up would let a stranger create an account that then
 * needs a merchant row attached to it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, LogIn } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { PhoneDemo } from "../phone-demo";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { error } = await browserClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        setError(error.message);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      // A missing NEXT_PUBLIC_* var throws here rather than returning an
      // error, and "nothing happened" is the worst possible failure mode.
      setError(e instanceof Error ? e.message : "Could not reach Supabase.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth-art">
        <PhoneDemo />
        <p>
          <strong>It answers from your real price list.</strong>
          Every price comes from your catalogue the moment it&apos;s quoted. Haggling, complaints and anything
          unusual come straight to you.
        </p>
      </aside>

      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={onSubmit}>
          <div>
            <div className="auth-brand">
              <span className="store-mark" aria-hidden>
                W
              </span>
              <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>
                WhatsApp AI Agent
              </span>
            </div>
            <h1 className="auth-title">Welcome back</h1>
            <p className="page-sub">Sign in to see what your assistant has been selling.</p>
          </div>

          {error && (
            <div className="banner error" style={{ margin: 0 }}>
              <CircleAlert aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="block" disabled={busy} style={{ minHeight: 48 }}>
            <LogIn /> {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="hint" style={{ textAlign: "center", margin: 0 }}>
            Accounts are set up for you during onboarding.
          </p>
        </form>
      </div>
    </div>
  );
}
