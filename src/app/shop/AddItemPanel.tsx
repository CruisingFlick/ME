"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { addItem } from "@/app/actions/basket";

type Method = "link" | "photo" | "manual";

type Draft = {
  title: string;
  price: string;
  imageUrl: string | null;
  sourceUrl: string | null;
  quantity: string;
  note: string;
};

const EMPTY: Draft = {
  title: "",
  price: "",
  imageUrl: null,
  sourceUrl: null,
  quantity: "1",
  note: "",
};

export function AddItemPanel({
  sharedUrl,
  sharedTitle,
}: {
  sharedUrl?: string;
  sharedTitle?: string;
}) {
  const [method, setMethod] = useState<Method>(sharedUrl ? "link" : "link");
  const [url, setUrl] = useState(sharedUrl ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<null | string>(null);
  const [notice, setNotice] = useState<{
    tone: "warn" | "error" | "ok";
    text: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const fileRef = useRef<HTMLInputElement>(null);
  const autoRan = useRef(false);

  async function lookUp(value: string) {
    const target = value.trim();
    if (!target) return;

    setBusy("Reading that page…");
    setNotice(null);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Even a hard error keeps the link — guardrail #4.
        setDraft({ ...EMPTY, sourceUrl: target, title: sharedTitle ?? "" });
        setNotice({
          tone: "warn",
          text:
            data?.error ??
            "We couldn't read that page. Type the item in — the link stays attached.",
        });
        return;
      }

      setDraft({
        title: data.title ?? sharedTitle ?? "",
        price: data.price ?? "",
        imageUrl: data.imageUrl ?? null,
        sourceUrl: data.sourceUrl ?? target,
        quantity: "1",
        note: "",
      });

      if (data.degraded) {
        setNotice({
          tone: "warn",
          text: data.reason ?? "We couldn't read much from that page.",
        });
      }
    } catch {
      setDraft({ ...EMPTY, sourceUrl: target, title: sharedTitle ?? "" });
      setNotice({
        tone: "warn",
        text: "Couldn't reach that page. Type the item in — the link stays attached.",
      });
    } finally {
      setBusy(null);
    }
  }

  // A link arriving from the Android share sheet goes straight through the
  // scraper — the customer shouldn't have to press anything.
  useEffect(() => {
    if (sharedUrl && !autoRan.current) {
      autoRan.current = true;
      void lookUp(sharedUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedUrl]);

  async function uploadPhoto(file: File) {
    setBusy("Uploading photo…");
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      const data = await res.json();

      if (!res.ok) {
        setDraft({ ...EMPTY });
        setNotice({ tone: "warn", text: data?.error ?? "Upload failed." });
        return;
      }
      setDraft({ ...EMPTY, imageUrl: data.url });
    } catch {
      setDraft({ ...EMPTY });
      setNotice({
        tone: "warn",
        text: "Upload failed. Describe the item instead and your rep will follow up.",
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function commit() {
    if (!draft) return;
    if (!draft.title.trim() && !draft.sourceUrl && !draft.imageUrl) {
      setNotice({ tone: "error", text: "Give the item a name first." });
      return;
    }

    const fd = new FormData();
    fd.set("title", draft.title);
    fd.set("price", draft.price);
    fd.set("quantity", draft.quantity);
    fd.set("customerNote", draft.note);
    if (draft.sourceUrl) fd.set("sourceUrl", draft.sourceUrl);
    if (draft.imageUrl) fd.set("imageUrl", draft.imageUrl);

    startTransition(async () => {
      await addItem(fd);
      setDraft(null);
      setUrl("");
      setNotice({ tone: "ok", text: "Added to your request." });
    });
  }

  function pickMethod(next: Method) {
    setMethod(next);
    setNotice(null);
    setDraft(next === "manual" ? { ...EMPTY } : null);
  }

  return (
    <section className="card">
      <div className="tabs" role="tablist" aria-label="How to add an item">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={method === "link"}
          onClick={() => pickMethod("link")}
        >
          Paste a link
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={method === "photo"}
          onClick={() => pickMethod("photo")}
        >
          Photo
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={method === "manual"}
          onClick={() => pickMethod("manual")}
        >
          Type it in
        </button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.tone}`}>{notice.text}</div>
      )}

      {method === "link" && (
        <div className="field">
          <label htmlFor="url">Product link</label>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              id="url"
              className="grow"
              type="url"
              inputMode="url"
              placeholder="Paste a product page link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lookUp(url);
                }
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void lookUp(url)}
              disabled={!!busy || !url.trim()}
            >
              Look up
            </button>
          </div>
          <p className="tiny" style={{ marginTop: "0.3rem" }}>
            We read the public page for a name, photo and price. If a site
            won&rsquo;t let us, you can still type it in and we keep the link.
          </p>
        </div>
      )}

      {method === "photo" && (
        <div className="field">
          <label htmlFor="photo">Photo of the item</label>
          <input
            id="photo"
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadPhoto(f);
            }}
          />
          <p className="tiny" style={{ marginTop: "0.3rem" }}>
            Snap the shelf label, the box, or the old one you&rsquo;re
            replacing.
          </p>
        </div>
      )}

      {busy && <p className="spinner-text">{busy}</p>}

      {draft && (
        <div style={{ marginTop: "0.75rem" }}>
          <div className="divider" />
          <div className="row" style={{ alignItems: "flex-start" }}>
            {draft.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="thumb" src={draft.imageUrl} alt="" />
            ) : (
              <div className="thumb thumb-placeholder" aria-hidden="true">
                📦
              </div>
            )}
            <div className="grow">
              <div className="field">
                <label htmlFor="d-title">Item</label>
                <input
                  id="d-title"
                  value={draft.title}
                  placeholder="What is it?"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="row" style={{ marginTop: "0.75rem" }}>
            <div className="grow">
              <label htmlFor="d-price">Price (if you know it)</label>
              <input
                id="d-price"
                value={draft.price}
                placeholder="optional"
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              />
            </div>
            <div className="qty">
              <label htmlFor="d-qty">Qty</label>
              <input
                id="d-qty"
                type="number"
                min={1}
                max={999}
                value={draft.quantity}
                onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="d-note">Note for your rep</label>
            <textarea
              id="d-note"
              value={draft.note}
              placeholder="e.g. the 5Ah kit, not the bare tool"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>

          {draft.sourceUrl && (
            <p className="tiny">Link attached: {draft.sourceUrl}</p>
          )}

          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn grow"
              onClick={commit}
              disabled={pending}
            >
              {pending ? "Adding…" : "Add to request"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setDraft(null);
                setNotice(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
