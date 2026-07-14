// Build-time feature flags.
//
// MEETING_ASSISTANT_ENABLED gates the 회의 도우미 (meeting assistant / chatbot)
// surface in the app shell. It is intentionally a plain compile-time constant,
// NOT an environment variable — flipping it is a deliberate code change so the
// dormant state is reviewable and `next build` stays deterministic (build-green).
//
// Why dormant: the chatbot's fail-closed citation flow depends on a built
// knowledge index and, in practice, returned "확인된 출처 없음" for real corpora
// while the discovery/citation split proved unreliable. Rather than delete the
// feature, we hold it dormant while the approach is reworked.
//
// How to revive: set this to `true`. Everything the chatbot needs is preserved
// and untouched:
//   - UI:    src/components/ChatPanel.tsx, ChatClient.tsx, ChatAnswer.tsx
//   - route: src/app/api/chat/route.ts
//   - logic: src/lib/chatOrchestrator.ts, src/lib/chatTools.ts,
//            src/lib/transcriptSearch.ts, src/domain/chat.ts
//   - shared index: src/lib/knowledgeIndex.ts (also used by search — must stay live)
//
// Search (SearchOverlay / useMeetingSearch / GET /api/search) and the shared
// knowledge index are independent of this flag and keep working while dormant.
export const MEETING_ASSISTANT_ENABLED = false;
