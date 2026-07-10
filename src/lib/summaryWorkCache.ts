import type { ClassifiedMeetingRecord } from "@/domain/library";
import { ensureSummarizeReconciled } from "@/lib/artifactPair";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { dataRoot } from "@/lib/paths";
import { computeSummaryWork, type SummaryWorkResult } from "@/lib/summaryWork";

interface SummaryWorkSnapshot {
  records: ClassifiedMeetingRecord[];
  observedAt: string;
  expiresAt: number;
}

interface SummaryWorkCacheState {
  snapshots: Map<string, SummaryWorkSnapshot>;
  inflight: Map<string, Promise<SummaryWorkSnapshot>>;
}

declare global {
  var __aiNoteSummaryWorkCache: SummaryWorkCacheState | undefined;
}

function cacheState(): SummaryWorkCacheState {
  globalThis.__aiNoteSummaryWorkCache ??= { snapshots: new Map(), inflight: new Map() };
  return globalThis.__aiNoteSummaryWorkCache;
}

async function loadSnapshot(root: string): Promise<SummaryWorkSnapshot> {
  const state = cacheState();
  const cached = state.snapshots.get(root);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached;
  const existing = state.inflight.get(root);
  if (existing) return existing;
  const load = (async () => {
    let library = await readResolvedLibraryState(root);
    const orphanAttempts = root === dataRoot()
      ? library.records.filter((record) => record.status?.summarizeAttempt).map((record) => record.meetingId)
      : [];
    if (orphanAttempts.length > 0) {
      await Promise.all(orphanAttempts.map(async (meetingId) => {
        if (meetingId) await ensureSummarizeReconciled(meetingId).catch(() => undefined);
      }));
      library = await readResolvedLibraryState(root);
    }
    const snapshot = {
      records: library.records,
      observedAt: new Date().toISOString(),
      expiresAt: Date.now() + 1_000,
    };
    state.snapshots.set(root, snapshot);
    return snapshot;
  })();
  state.inflight.set(root, load);
  try {
    return await load;
  } finally {
    if (state.inflight.get(root) === load) state.inflight.delete(root);
  }
}

export async function getSummaryWork(
  attentionAfter?: string | null,
  root = dataRoot(),
): Promise<SummaryWorkResult> {
  const snapshot = await loadSnapshot(root);
  return computeSummaryWork(snapshot.records, attentionAfter, snapshot.observedAt);
}

export function invalidateSummaryWork(root = dataRoot()): void {
  cacheState().snapshots.delete(root);
}

export function resetSummaryWorkCacheForTests(): void {
  globalThis.__aiNoteSummaryWorkCache = { snapshots: new Map(), inflight: new Map() };
}
