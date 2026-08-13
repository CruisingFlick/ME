"use client";

import { useState } from "react";

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API needs a secure context; the input is selectable anyway.
      setCopied(false);
    }
  }

  return (
    <div className="linkbox">
      <input
        className="grow"
        readOnly
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Your invite link"
      />
      <button type="button" className="btn" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
