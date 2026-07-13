import { normalizeSearchText } from "@/lib/meetingSearch";

// Pure, filesystem-free transcript discovery for the chatbot. The AI-free
// `/api/search` deliberately never reads transcript.md; this module lets the
// chatbot fall back to a bounded substring scan of transcript bytes that were
// already read through the fenced artifact-read path. It grants no citation
// credit — callers use it only to surface candidate meetingIds to re-read.

const SNIPPET_RADIUS = 90;
const MAX_SNIPPET_CHARS = 200;
const DEFAULT_SNIPPETS_PER_MEETING = 3;
const DEFAULT_CANDIDATE_LIMIT = 10;
const MAX_CANDIDATE_LIMIT = 20;
const MIN_KEYWORD_CHARS = 2;

// Trailing Korean particles/endings stripped from a query token so that a user
// who types "라이드를"·"고퀄에서"·"대표님" still discovers a transcript that only
// contains the bare stem "라이드"·"고퀄"·"대표". Longest first so a multi-syllable
// particle wins over a single-syllable suffix of itself.
const KOREAN_TAIL_PARTICLES = [
  "으로써", "으로서", "에서는", "에게서", "한테서", "이라는", "이라고",
  "으로", "에서", "에게", "한테", "께서", "라는", "라고", "까지", "부터",
  "조차", "마저", "처럼", "보다", "만큼", "이나", "이랑",
  "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "만", "랑", "나", "님", "씨", "들",
].sort((left, right) => right.length - left.length);

export interface TranscriptScanSnippet {
  text: string;
}

export interface TranscriptCandidateInput {
  meetingId: string;
  /** null when the transcript is unavailable (tombstoned/corrupt/missing) — excluded. */
  transcript: string | null;
}

export interface TranscriptCandidate {
  meetingId: string;
  matchedKeywords: string[];
  snippets: TranscriptScanSnippet[];
}

export interface TranscriptCandidateResult {
  keywords: string[];
  candidates: TranscriptCandidate[];
  hasMore: boolean;
}

export interface CollectTranscriptCandidatesOptions {
  limit?: number;
  snippetsPerMeeting?: number;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function stripKoreanTail(token: string): string {
  for (const particle of KOREAN_TAIL_PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle)) {
      const stem = token.slice(0, token.length - particle.length);
      if (characterLength(stem) >= MIN_KEYWORD_CHARS) return stem;
    }
  }
  return token;
}

/**
 * Split a query into bare, deduplicated keywords using the same locale-neutral
 * normalization as `/api/search`, then relax Korean josa/eomi so attached
 * particles do not zero out a substring match.
 */
export function extractQueryKeywords(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const keywords = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    const stem = stripKoreanTail(token);
    if (characterLength(stem) >= MIN_KEYWORD_CHARS) keywords.add(stem);
    else if (characterLength(token) >= MIN_KEYWORD_CHARS) keywords.add(token);
  }
  return [...keywords];
}

function buildSnippet(characters: readonly string[], matchCharIndex: number, matchLength: number): TranscriptScanSnippet {
  const start = Math.max(0, matchCharIndex - SNIPPET_RADIUS);
  const end = Math.min(characters.length, matchCharIndex + matchLength + SNIPPET_RADIUS);
  const raw = characters.slice(start, end).join("").replace(/\s+/gu, " ").trim();
  return { text: Array.from(raw).slice(0, MAX_SNIPPET_CHARS).join("") };
}

function scanTranscript(
  transcript: string,
  keywords: readonly string[],
  snippetsPerMeeting: number,
): { matchedKeywords: string[]; snippets: TranscriptScanSnippet[]; score: number } | null {
  const characters = Array.from(transcript);
  const normalized = transcript.normalize("NFKC").toLowerCase();
  const matchedKeywords: string[] = [];
  const snippets: TranscriptScanSnippet[] = [];
  for (const keyword of keywords) {
    const codeUnitIndex = normalized.indexOf(keyword);
    if (codeUnitIndex < 0) continue;
    matchedKeywords.push(keyword);
    if (snippets.length < snippetsPerMeeting) {
      const charIndex = Array.from(normalized.slice(0, codeUnitIndex)).length;
      snippets.push(buildSnippet(characters, charIndex, characterLength(keyword)));
    }
  }
  return matchedKeywords.length > 0
    ? { matchedKeywords, snippets, score: matchedKeywords.length }
    : null;
}

export function collectTranscriptCandidates(
  inputs: readonly TranscriptCandidateInput[],
  query: string,
  options: CollectTranscriptCandidatesOptions = {},
): TranscriptCandidateResult {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_CANDIDATE_LIMIT), MAX_CANDIDATE_LIMIT);
  const snippetsPerMeeting = Math.max(1, options.snippetsPerMeeting ?? DEFAULT_SNIPPETS_PER_MEETING);
  const keywords = extractQueryKeywords(query);
  if (keywords.length === 0) return { keywords, candidates: [], hasMore: false };

  const scored = inputs.flatMap((input, index) => {
    if (input.transcript === null) return [];
    const scan = scanTranscript(input.transcript, keywords, snippetsPerMeeting);
    return scan ? [{ index, meetingId: input.meetingId, ...scan }] : [];
  });
  // Rank by keyword coverage; the caller passes inputs in its preferred order
  // (e.g. most recent first), preserved as a stable tiebreak.
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const visible = scored.slice(0, limit);
  return {
    keywords,
    candidates: visible.map((item) => ({
      meetingId: item.meetingId,
      matchedKeywords: item.matchedKeywords,
      snippets: item.snippets,
    })),
    hasMore: scored.length > visible.length,
  };
}
