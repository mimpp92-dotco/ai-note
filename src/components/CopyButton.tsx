"use client";

import { useEffect, useRef, useState } from "react";

// Copies `text` to the clipboard and reports both success and failure. A single
// replaceable timer prevents repeated clicks or unmount from leaving stale updates.
export function CopyButton({ text, label = "복사", className = "" }: { text: string; label?: string; className?: string }) {
  const [feedback, setFeedback] = useState<"idle" | "success" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const showFeedback = (next: "success" | "error") => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setFeedback(next);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setFeedback("idle");
    }, 1500);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showFeedback("success");
    } catch {
      showFeedback("error");
    }
  };

  const visibleLabel = feedback === "success"
    ? "복사됨"
    : feedback === "error"
      ? "복사 실패"
      : label;

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className={`inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-line bg-panel px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${className}`}
    >
      <span aria-live="polite" aria-atomic="true">{visibleLabel}</span>
    </button>
  );
}
