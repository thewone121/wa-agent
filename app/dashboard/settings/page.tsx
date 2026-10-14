"use client";

/**
 * Settings.
 *
 * Only the fields that change the bot's behaviour. WhatsApp bindings
 * (wa_phone_number_id) are deliberately read-only here: changing that value
 * re-points a live webhook at a different Meta number, and getting it wrong
 * means every inbound message silently finds no merchant and is dropped.
 */

import { useMemo, useState } from "react";
import { CircleCheck, Save } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../merchant-context";
import { fmtMoney, parseMoneyToMinor } from "@/lib/money";

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Postgres jsonb stores object keys sorted by length, so the hours come back
 * as sat, sun, mon_fri. Put them back in the order a week is read.
 */
function weekOrder(a: string, b: string): number {
  const rank = (k: string) => {
    const i = WEEK.indexOf(k.slice(0, 3).toLowerCase());
    return i === -1 ? 99 : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** "mon_fri" → "Mon – Fri". The stored keys are whatever onboarding wrote. */
function dayName(key: string): string {
  return key
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" – ");
}

export default function SettingsPage() {
  const merchant = useMerchant();

  const initial = useMemo(
    () => ({
      tone: merchant.ai_tone,
      greeting: merchant.greeting ?? "",
      escalation: merchant.escalation_number ?? "",
      delivery: String(Math.round(merchant.delivery_fee_minor / 100)),
      hours: merchant.business_hours ?? {},
      notify: merchant.owner_notify,
    }),
    [merchant],
  );

  const [tone, setTone] = useState(initial.tone);
  const [greeting, setGreeting] = useState(initial.greeting);
  const [escalation, setEscalation] = useState(initial.escalation);
  const [delivery, setDelivery] = useState(initial.delivery);
  const [hours, setHours] = useState<Record<string, string>>(initial.hours);
  const [hoursText, setHoursText] = useState(JSON.stringify(initial.hours, null, 2));
  const [rawHours, setRawHours] = useState(false);
  const [notify, setNotify] = useState(initial.notify);

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState(initial);

  const dirty =
    tone !== baseline.tone ||
    greeting !== baseline.greeting ||
    escalation !== baseline.escalation ||
    delivery !== baseline.delivery ||
    notify !== baseline.notify ||
    (rawHours ? hoursText !== JSON.stringify(baseline.hours, null, 2) : JSON.stringify(hours) !== JSON.stringify(baseline.hours));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const fee = parseMoneyToMinor(delivery);
    if (fee === null) {
      setError(`Couldn't read "${delivery}" as an amount.`);
      return;
    }

    let parsedHours: Record<string, string> = hours;
    if (rawHours) {
      try {
        parsedHours = JSON.parse(hoursText);
      } catch {
        setError("Business hours must be valid JSON, like {\"mon_fri\": \"9-18\"}.");
        return;
      }
    }

    setBusy(true);
    const { error } = await browserClient()
      .from("merchants")
      .update({
        ai_tone: tone,
        greeting: greeting.trim() || null,
        // Stored as digits only so it matches what Meta delivers as `from`.
        // lib/owner.ts compares on a digit suffix, but normalising on write
        // keeps the stored value predictable.
        escalation_number: escalation.replace(/\D/g, "") || null,
        delivery_fee_minor: fee,
        business_hours: parsedHours,
        owner_notify: notify,
      })
      .eq("id", merchant.id);
    setBusy(false);

    if (error) {
      setError(error.message);
      return;
    }
    setHours(parsedHours);
    setHoursText(JSON.stringify(parsedHours, null, 2));
    setBaseline({ tone, greeting, escalation, delivery, hours: parsedHours, notify });
    setSavedAt(Date.now());
  }

  return (
    <form onSubmit={save}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">How the assistant talks, and where it sends things it shouldn&apos;t handle alone.</p>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <section className="group">
        <h2 className="group-title">How the assistant talks</h2>

        <div className="field">
          <label htmlFor="tone">Tone</label>
          <textarea id="tone" rows={3} value={tone} onChange={(e) => setTone(e.target.value)} />
          <div className="hint">
            Describe the voice, not the rules. The hard rules — never invent a price, never agree a discount — are
            fixed in code and can&apos;t be changed from here.
          </div>
        </div>

        <div className="field">
          <label htmlFor="greeting">Greeting</label>
          <input
            id="greeting"
            value={greeting}
            placeholder="Welcome to Thrill Bites! What are you planning?"
            onChange={(e) => setGreeting(e.target.value)}
          />
          <div className="hint">Optional. Used the first time a customer messages.</div>
        </div>

        <div className="field">
          <label htmlFor={rawHours ? "hours-raw" : undefined}>Business hours</label>
          {rawHours ? (
            <textarea
              id="hours-raw"
              rows={5}
              value={hoursText}
              onChange={(e) => setHoursText(e.target.value)}
              style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
            />
          ) : Object.keys(hours).length === 0 ? (
            <div className="hint">None set.</div>
          ) : (
            <div className="kv" style={{ gap: 0 }}>
              {Object.entries(hours)
                .sort(([a], [b]) => weekOrder(a, b))
                .map(([k, v]) => (
                <div key={k}>
                  <dt>{dayName(k)}</dt>
                  <dd>
                    <input
                      aria-label={`Hours for ${dayName(k)}`}
                      value={v}
                      onChange={(e) => setHours({ ...hours, [k]: e.target.value })}
                      style={{ width: 130, minHeight: 36, textAlign: "right", fontFamily: "var(--font-mono)" }}
                    />
                  </dd>
                </div>
              ))}
            </div>
          )}
          <div className="hint">
            The assistant tells customers when you&apos;re closed, and keeps replying anyway.{" "}
            <button
              type="button"
              onClick={() => {
                if (!rawHours) setHoursText(JSON.stringify(hours, null, 2));
                setRawHours((v) => !v);
              }}
              style={{
                display: "inline",
                minHeight: 0,
                padding: 0,
                background: "none",
                color: "var(--brand)",
                fontSize: "inherit",
                fontWeight: 600,
              }}
            >
              {rawHours ? "Back to simple view" : "Add or rename days"}
            </button>
          </div>
        </div>
      </section>

      <section className="group">
        <h2 className="group-title">Handovers and orders</h2>

        <div className="field">
          <label htmlFor="esc">Your WhatsApp number</label>
          <input
            id="esc"
            inputMode="tel"
            value={escalation}
            onChange={(e) => setEscalation(e.target.value)}
            placeholder="+234 803 000 0000"
          />
          <div className="hint">
            Handovers and new orders go here. Messages from this number are treated as owner commands — send{" "}
            <strong>help</strong> to your business number to see them. Include the country code.
          </div>
        </div>

        <div className="toggle-row">
          <div>
            <strong>Message me about new orders</strong>
            <div className="hint">Off is the same as sending mute. Orders still appear here either way.</div>
          </div>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={notify}
            aria-label="Message me about new orders"
            onClick={() => setNotify((v) => !v)}
          />
        </div>

        <div className="field">
          <label htmlFor="del">Delivery fee</label>
          <input id="del" inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          <div className="hint">
            Added to every order total by the server. Use 0 if you quote delivery case by case. Saved value:{" "}
            {fmtMoney(merchant.delivery_fee_minor, merchant.currency)}.
          </div>
        </div>
      </section>

      <section className="group">
        <h2 className="group-title">Connection</h2>
        <p className="hint">Set at onboarding. Changing the linked Meta number re-points a live webhook, so it&apos;s done
          deliberately, in the database.</p>
        <dl className="kv" style={{ margin: 0 }}>
          <div>
            <dt>WhatsApp number</dt>
            <dd>{merchant.wa_display_number ?? "not set"}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{merchant.currency}</dd>
          </div>
          <div>
            <dt>Timezone</dt>
            <dd>{merchant.timezone}</dd>
          </div>
          <div>
            <dt>Monthly replies</dt>
            <dd>{merchant.plan_reply_cap.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Assistant</dt>
            <dd>
              <span className={`live${merchant.is_active ? "" : " off"}`}>{merchant.is_active ? "Live" : "Paused"}</span>
            </dd>
          </div>
        </dl>
      </section>

      {(dirty || savedAt) && (
        <div className="savebar" role="status">
          {dirty ? (
            <>
              <span>Unsaved changes</span>
              <button type="submit" className="small" disabled={busy}>
                <Save /> {busy ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
              <CircleCheck style={{ width: 17, height: 17 }} /> Saved. The assistant uses it from the next message.
            </span>
          )}
        </div>
      )}
    </form>
  );
}
