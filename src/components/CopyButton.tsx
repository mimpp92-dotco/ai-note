"use client";

import { useState } from "react";

// Copies `text` to the clipboard and flashes "복사됨" briefly. Used by the pending
// banner and the detail next-step card. Falls back silently if clipboard is blocked.
export function CopyButton({ text, label = "복사", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — no-op.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className={`shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft ${className}`}
    >
      {copied ? "복사됨" : label}
    </button>
  );
}
