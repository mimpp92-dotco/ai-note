// Next.js instrumentation hook: runs once when the server process starts. We use it
// to boot the background summarize worker. Guarded so it only runs in the Node.js
// runtime (not edge/build) and can be disabled for tests and `next build`.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AI_NOTE_DISABLE_WORKER === "1") return;

  try {
    const { startSummarizeWorker } = await import("@/lib/summarizeWorker");
    startSummarizeWorker();
  } catch {
    // The worker is best-effort; a failure here must never block server startup.
  }
}
