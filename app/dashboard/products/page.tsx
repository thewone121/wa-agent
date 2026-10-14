"use client";

/**
 * Catalogue.
 *
 * This is the agent's source of truth. Editing a price here changes what the
 * bot quotes on the very next message, because search_catalogue reads the live
 * row — the model is never trusted to remember a price.
 *
 * Writes go through the normal table with RLS rather than an RPC: products_own
 * already restricts them to the owner's merchant, so there is nothing an
 * extra function would add. Stock is the exception — set_product_stock also
 * flips track_stock on, which is what makes the restock alerts fire.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Package, Pencil, Plus } from "lucide-react";
import { browserClient } from "@/lib/supabase-browser";
import { useMerchant } from "../merchant-context";
import { fmtMoney, parseMoneyToMinor } from "@/lib/money";
import { Empty, Sheet, SkeletonRows } from "../ui";

type Product = {
  id: string;
  name: string;
  variant_label: string | null;
  category: string | null;
  description: string | null;
  price_minor: number;
  stock: number;
  track_stock: boolean;
  is_active: boolean;
};

const BLANK = {
  name: "",
  variant_label: "",
  category: "",
  description: "",
  price: "",
  stock: "0",
  track_stock: false,
};

export default function CataloguePage() {
  const merchant = useMerchant();
  const [rows, setRows] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);

  const load = useCallback(async () => {
    const { data, error } = await browserClient()
      .from("products")
      .select("id,name,variant_label,category,description,price_minor,stock,track_stock,is_active")
      .eq("merchant_id", merchant.id)
      .order("category", { nullsFirst: false })
      .order("name");

    if (error) setError(error.message);
    else {
      setRows((data ?? []) as Product[]);
      setError(null);
    }
  }, [merchant.id]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of rows ?? []) {
      const key = p.category?.trim() || "Uncategorised";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()];
  }, [rows]);

  async function patch(id: string, fields: Partial<Product>) {
    setBusy(true);
    const { error } = await browserClient()
      .from("products")
      .update(fields)
      .eq("id", id)
      .eq("merchant_id", merchant.id);
    setBusy(false);
    if (error) setError(error.message);
    else await load();
  }

  async function setStock(id: string, n: number) {
    if (!Number.isInteger(n) || n < 0) {
      setError("Stock has to be a whole number, zero or more.");
      return;
    }
    setBusy(true);
    const { error } = await browserClient().rpc("set_product_stock", {
      p_merchant_id: merchant.id,
      p_product_id: id,
      p_stock: n,
    });
    setBusy(false);
    if (error) setError(error.message);
    else await load();
  }

  async function setPrice(id: string, value: string) {
    const minor = parseMoneyToMinor(value);
    if (minor === null) {
      setError(`Couldn't read "${value}" as an amount.`);
      return;
    }
    await patch(id, { price_minor: minor });
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const minor = parseMoneyToMinor(draft.price);
    if (!draft.name.trim()) return setError("Name is required.");
    if (minor === null) return setError(`Couldn't read "${draft.price}" as an amount.`);

    setBusy(true);
    const { error } = await browserClient()
      .from("products")
      .insert({
        merchant_id: merchant.id,
        name: draft.name.trim(),
        variant_label: draft.variant_label.trim() || null,
        category: draft.category.trim() || null,
        description: draft.description.trim() || null,
        price_minor: minor,
        stock: draft.track_stock ? Number(draft.stock) || 0 : 0,
        track_stock: draft.track_stock,
      });
    setBusy(false);

    if (error) setError(error.message);
    else {
      setDraft(BLANK);
      setAdding(false);
      setError(null);
      await load();
    }
  }

  const closeAdd = useCallback(() => setAdding(false), []);
  const liveCount = rows?.filter((p) => p.is_active).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Catalogue</h1>
          <p className="page-sub">
            What the assistant quotes from. A change here is what it says on the very next message.
          </p>
        </div>
        <button onClick={() => setAdding(true)}>
          <Plus /> Add product
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {rows === null ? (
        <SkeletonRows n={5} h={72} />
      ) : rows.length === 0 ? (
        <Empty icon={Package} title="Nothing to sell yet">
          Add your first product, or run <code>npm run seed</code>.
        </Empty>
      ) : (
        <>
          <p className="hint" style={{ margin: "0 4px 14px" }}>
            {liveCount} of {rows.length} item{rows.length === 1 ? "" : "s"} live. Hidden items are never offered to
            customers.
          </p>
          {groups.map(([cat, items]) => (
            <section className="cat-group" key={cat}>
              <h2 className="cat-head">{cat}</h2>
              <ul className="items">
                {items.map((p) => (
                  <li key={p.id} className={`item${p.is_active ? "" : " hidden"}`}>
                    <div style={{ minWidth: 0 }}>
                      <div className="item-name">
                        {p.name}
                        {p.variant_label && <em> · {p.variant_label}</em>}
                      </div>
                      {p.description && <div className="item-desc">{p.description}</div>}
                    </div>

                    <div className="item-controls">
                      <PriceEdit
                        value={fmtMoney(p.price_minor, merchant.currency)}
                        disabled={busy}
                        onSave={(v) => setPrice(p.id, v)}
                      />

                      {p.track_stock ? (
                        <div className={`stepper${p.stock === 0 ? " out" : ""}`} aria-label={`Stock for ${p.name}`}>
                          <button
                            aria-label="One less"
                            disabled={busy || p.stock === 0}
                            onClick={() => setStock(p.id, p.stock - 1)}
                          >
                            <Minus />
                          </button>
                          <output>{p.stock}</output>
                          <button aria-label="One more" disabled={busy} onClick={() => setStock(p.id, p.stock + 1)}>
                            <Plus />
                          </button>
                        </div>
                      ) : (
                        <span className="untracked">Made to order</span>
                      )}

                      <label className="item-live">
                        <span>{p.is_active ? "Live" : "Hidden"}</span>
                        <button
                          type="button"
                          role="switch"
                          className="switch"
                          aria-checked={p.is_active}
                          aria-label={p.is_active ? `Hide ${p.name}` : `Show ${p.name}`}
                          disabled={busy}
                          onClick={() => patch(p.id, { is_active: !p.is_active })}
                        />
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      {adding && (
        <Sheet
          title="New product"
          onClose={closeAdd}
          footer={
            <button type="submit" form="add-product" disabled={busy}>
              <Plus /> Add to catalogue
            </button>
          }
        >
          <form id="add-product" className="form-stack" onSubmit={add}>
            <div className="field">
              <label htmlFor="n">Name</label>
              <input
                id="n"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Bento mini platter"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="p">Price</label>
              <input
                id="p"
                inputMode="decimal"
                placeholder="30000 or 30k"
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                required
              />
              <div className="hint">In {merchant.currency}. Whole amounts and "30k" both work.</div>
            </div>

            <div className="field">
              <label htmlFor="c">Category</label>
              <input
                id="c"
                value={draft.category}
                placeholder="Platters, Small chops…"
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="v">Variant</label>
              <input
                id="v"
                placeholder="Size 43, Large, Spicy…"
                value={draft.variant_label}
                onChange={(e) => setDraft({ ...draft, variant_label: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="d">Description</label>
              <input
                id="d"
                placeholder="Covers roughly 40 guests"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <div className="hint">The assistant uses this when a customer asks what something is.</div>
            </div>

            <div className="toggle-row">
              <div>
                <strong>Track stock</strong>
                <div className="hint">
                  Leave off for made-to-order items. On, the assistant stops selling at zero and can take restock
                  requests.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={draft.track_stock}
                aria-label="Track stock"
                onClick={() => setDraft({ ...draft, track_stock: !draft.track_stock })}
              />
            </div>

            {draft.track_stock && (
              <div className="field">
                <label htmlFor="s">Starting stock</label>
                <input
                  id="s"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={draft.stock}
                  onChange={(e) => setDraft({ ...draft, stock: e.target.value })}
                />
              </div>
            )}
          </form>
        </Sheet>
      )}
    </>
  );
}

/**
 * Tap the price to edit it. Enter or tapping away saves; Escape abandons.
 *
 * Saving on blur is deliberate: on a phone there is no obvious "Enter", and
 * the natural way to finish is to tap somewhere else. Abandoning on blur — as
 * the desktop-first version did — silently threw away every mobile edit.
 */
function PriceEdit({
  value,
  onSave,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Enter and Escape both unmount the input, and some browsers fire blur on
  // the way out. Without this an Escape would save, and an Enter would save
  // twice.
  const settled = useRef(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="price-edit"
        disabled={disabled}
        onClick={() => {
          settled.current = false;
          setDraft(value);
          setEditing(true);
        }}
        aria-label={`Price ${value}, tap to change`}
      >
        {value}
        <Pencil aria-hidden />
      </button>
    );
  }

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (draft.trim() && draft !== value) onSave(draft);
  };

  const abandon = () => {
    settled.current = true;
    setEditing(false);
  };

  return (
    <input
      autoFocus
      className="inline-input"
      disabled={disabled}
      value={draft}
      inputMode="decimal"
      enterKeyHint="done"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") abandon();
      }}
    />
  );
}
