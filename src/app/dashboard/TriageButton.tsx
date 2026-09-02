"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function TriageButton({ pending }: { pending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { tone: "ok" | "error"; text: string } | null
  >(null);

  async function run() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/triage", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setNotice({ tone: "error", text: data?.error ?? "Triage didn't run." });
        return;
      }
      setNotice({
        tone: "ok",
        text:
          data.triaged === 0
            ? "Nothing new to triage."
            : `Sorted ${data.triaged} request${data.triaged === 1 ? "" : "s"} — highest priority first.`,
      });
      router.refresh();
    } catch {
      setNotice({
        tone: "error",
        text: "Couldn't reach the server. Your inbox is unchanged.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={run}
        disabled={busy || pending === 0}
        title={
          pending === 0
            ? "Everything waiting on you has already been triaged"
            : undefined
        }
      >
        {busy
          ? "Reading them…"
          : `Run morning triage${pending > 0 ? ` (${pending})` : ""}`}
      </button>
      {notice && (
        <div
          className={`notice notice-${notice.tone}`}
          style={{ marginTop: "0.6rem" }}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
