"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  normalizeUserProfile,
  type UserProfile,
} from "@/domain/userProfile";

type LoadState = "loading" | "ready" | "load_error";
type SaveFeedback = "idle" | "saved" | "pending" | "save_error";
type WeekStartsOn = UserProfile["weekStartsOn"];

interface MissingProfileState {
  configured: false;
  defaults: {
    timezone: string;
    weekStartsOn: "monday";
  };
}

interface ConfiguredProfileState {
  configured: true;
  profile: UserProfile;
}

type ProfileState = MissingProfileState | ConfiguredProfileState;

const field =
  "w-full min-w-0 rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

function isTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function parseProfileState(value: unknown): ProfileState | null {
  if (typeof value !== "object" || value === null || !("configured" in value)) return null;
  const candidate = value as {
    configured?: unknown;
    defaults?: unknown;
    profile?: unknown;
  };
  if (candidate.configured === false) {
    if (typeof candidate.defaults !== "object" || candidate.defaults === null) return null;
    const defaults = candidate.defaults as { timezone?: unknown; weekStartsOn?: unknown };
    if (!isTimezone(defaults.timezone) || defaults.weekStartsOn !== "monday") return null;
    return {
      configured: false,
      defaults: { timezone: defaults.timezone, weekStartsOn: "monday" },
    };
  }
  if (candidate.configured !== true) return null;
  try {
    return { configured: true, profile: normalizeUserProfile(candidate.profile) };
  } catch {
    return null;
  }
}

function parseAliases(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\n,，]+/u)
      .map((alias) => alias.trim())
      .filter(Boolean),
  )];
}

function sameProfile(left: UserProfile | null, right: UserProfile): boolean {
  if (left === null) return false;
  return left.schemaVersion === right.schemaVersion
    && left.displayName === right.displayName
    && left.timezone === right.timezone
    && left.weekStartsOn === right.weekStartsOn
    && left.aliases.length === right.aliases.length
    && left.aliases.every((alias, index) => alias === right.aliases[index]);
}

function boundedTimezoneSuggestions(localTimezone: string): string[] {
  const suggestions = [localTimezone, "UTC"];
  try {
    const supported = Intl.supportedValuesOf("timeZone");
    const stride = Math.max(1, Math.floor(supported.length / 8));
    for (let index = 0; index < supported.length && suggestions.length < 10; index += stride) {
      suggestions.push(supported[index]);
    }
  } catch {
    // A native datalist with local timezone + UTC remains useful on older browsers.
  }
  return [...new Set(suggestions)].slice(0, 10);
}

function isComposingEnter(
  event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  composing: boolean,
): boolean {
  return event.key === "Enter"
    && (composing || event.nativeEvent.isComposing || event.keyCode === 229);
}

export function UserProfileForm() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [savedProfile, setSavedProfile] = useState<UserProfile | null>(null);
  const [defaultTimezone, setDefaultTimezone] = useState("UTC");
  const [displayName, setDisplayName] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>("monday");
  const [dateOpen, setDateOpen] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SaveFeedback>("idle");
  const loadAbortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const timezoneRef = useRef<HTMLInputElement | null>(null);

  const applyState = (state: ProfileState) => {
    if (state.configured) {
      setSavedProfile(state.profile);
      setDefaultTimezone(state.profile.timezone);
      setDisplayName(state.profile.displayName);
      setAliasesText(state.profile.aliases.join(", "));
      setTimezone(state.profile.timezone);
      setWeekStartsOn(state.profile.weekStartsOn);
    } else {
      setSavedProfile(null);
      setDefaultTimezone(state.defaults.timezone);
      setDisplayName("");
      setAliasesText("");
      setTimezone(state.defaults.timezone);
      setWeekStartsOn(state.defaults.weekStartsOn);
    }
    setNameTouched(false);
    setSubmitAttempted(false);
    setEdited(false);
    setFeedback("idle");
  };

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadState("loading");
    setFeedback("idle");
    try {
      const response = await fetch("/api/settings/profile", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("load failed");
      const state = parseProfileState(await response.json());
      if (controller.signal.aborted) return;
      if (!state) throw new Error("invalid response");
      applyState(state);
      setLoadState("ready");
    } catch {
      if (controller.signal.aborted) return;
      setLoadState("load_error");
    }
  }, []);

  useEffect(() => {
    void load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  const profileDraft: UserProfile = {
    schemaVersion: 1,
    displayName: displayName.trim(),
    aliases: parseAliases(aliasesText),
    timezone: timezone.trim(),
    weekStartsOn,
  };
  const ready = loadState === "ready";
  const nameMissing = profileDraft.displayName.length === 0;
  const timezoneInvalid = !isTimezone(profileDraft.timezone);
  const valid = !nameMissing && !timezoneInvalid;
  const dirty = ready && !sameProfile(savedProfile, profileDraft);
  const canSave = ready && dirty && valid && !saving;
  const showNameError = nameMissing && (nameTouched || submitAttempted);
  const suggestions = useMemo(
    () => boundedTimezoneSuggestions(defaultTimezone),
    [defaultTimezone],
  );

  const mutate = () => {
    setEdited(true);
    setFeedback("idle");
  };

  const focusFirstInvalid = () => {
    if (nameMissing) {
      nameRef.current?.focus();
      return;
    }
    if (timezoneInvalid) {
      setDateOpen(true);
      queueMicrotask(() => timezoneRef.current?.focus());
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current) return;
    setSubmitAttempted(true);
    if (!ready || !dirty || saving || !valid) {
      focusFirstInvalid();
      return;
    }

    setSaving(true);
    setFeedback("idle");
    try {
      const response = await fetch("/api/settings/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileDraft),
      });
      if (!response.ok) {
        setFeedback("save_error");
        return;
      }
      const raw: unknown = await response.json();
      const state = parseProfileState(raw);
      const durability = typeof raw === "object" && raw !== null && "durability" in raw
        ? (raw as { durability?: unknown }).durability
        : undefined;
      if (!state?.configured || !["durable", "best_effort", "pending"].includes(String(durability))) {
        setFeedback("save_error");
        return;
      }

      setSavedProfile(state.profile);
      setDisplayName(state.profile.displayName);
      setAliasesText(state.profile.aliases.join(", "));
      setTimezone(state.profile.timezone);
      setWeekStartsOn(state.profile.weekStartsOn);
      setDefaultTimezone(state.profile.timezone);
      setEdited(false);
      setNameTouched(false);
      setSubmitAttempted(false);
      setFeedback(durability === "pending" ? "pending" : "saved");
    } catch {
      setFeedback("save_error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="user-profile-heading" className="min-w-0 space-y-6">
      <div>
        <h2 id="user-profile-heading" className="text-[19px] font-bold tracking-tight text-ink">
          내 정보
        </h2>
        <p className="mt-2 break-words text-[14px] leading-relaxed text-inkSoft">
          표시 이름은 ‘내 할 일’이나 상대 날짜 같은 개인화 질문을 보완합니다. 일반 검색과 질문에 필수 설정은 아닙니다.
        </p>
      </div>

      {loadState === "loading" && (
        <div className="rounded-[16px] border border-line bg-panel p-4 sm:p-6">
          <p role="status" className="text-[14px] text-inkSoft">내 정보를 불러오는 중…</p>
        </div>
      )}

      {loadState === "load_error" && (
        <div className="space-y-3 rounded-[16px] border border-line bg-panel p-4 sm:p-6">
          <p role="status" className="break-words text-[14px] text-error">
            내 정보를 불러오지 못했어요. 기존 값을 덮어쓰지 않도록 편집을 잠갔습니다.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-11 w-full rounded-lg border border-line bg-panel px-4 text-[13px] font-medium text-accent transition-colors hover:bg-soft sm:w-auto"
          >
            다시 시도
          </button>
        </div>
      )}

      {ready && (
        <form
          onSubmit={(event) => void submit(event)}
          aria-busy={saving ? "true" : undefined}
          className="min-w-0 space-y-6 rounded-[16px] border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(42,36,32,.04)] sm:p-6"
        >
          {savedProfile === null && (
            <p className="break-words rounded-md bg-warnBg px-3 py-2 text-[13px] leading-relaxed text-warn">
              브라우저 기준 기본 시간대: {defaultTimezone} · 아직 저장되지 않음
            </p>
          )}

          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <legend className="text-[14px] font-bold text-ink">기본 정보</legend>
            <div className="block min-w-0">
              <label htmlFor="user-profile-display-name" className="text-[13px] font-medium text-inkSoft">
                표시 이름
              </label>
              <input
                ref={nameRef}
                id="user-profile-display-name"
                type="text"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  mutate();
                }}
                onBlur={() => setNameTouched(true)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  composingRef.current = false;
                  setDisplayName(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (isComposingEnter(event, composingRef.current)) event.preventDefault();
                }}
                aria-invalid={showNameError ? "true" : undefined}
                aria-describedby={showNameError ? "user-profile-name-error" : undefined}
                autoComplete="name"
                className={`mt-1 ${field}`}
                placeholder="예: Dylan"
              />
              {showNameError && (
                <span id="user-profile-name-error" className="mt-1 block text-[12px] text-error">
                  표시 이름을 입력하세요.
                </span>
              )}
            </div>

            <div className="block min-w-0">
              <label htmlFor="user-profile-aliases" className="text-[13px] font-medium text-inkSoft">
                별칭
              </label>
              <textarea
                id="user-profile-aliases"
                value={aliasesText}
                onChange={(event) => {
                  setAliasesText(event.target.value);
                  mutate();
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  composingRef.current = false;
                  setAliasesText(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (isComposingEnter(event, composingRef.current)) event.preventDefault();
                }}
                rows={3}
                aria-describedby="user-profile-aliases-help"
                className={`mt-1 resize-y break-words ${field}`}
                placeholder="예: 딜런, Dylan Kim"
              />
              <span id="user-profile-aliases-help" className="mt-1 block break-words text-[12px] leading-relaxed text-inkSoft">
                쉼표 또는 줄바꿈으로 구분합니다. 저장할 때 빈 값과 중복 별칭을 정리합니다.
              </span>
            </div>
          </fieldset>

          <details
            open={dateOpen}
            onToggle={(event) => setDateOpen(event.currentTarget.open)}
            className="min-w-0 rounded-[12px] border border-line bg-bg"
          >
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[14px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
              날짜 기준
            </summary>
            <div className="min-w-0 space-y-4 border-t border-line p-4">
              <div className="block min-w-0">
                <label htmlFor="user-profile-timezone" className="text-[13px] font-medium text-inkSoft">
                  시간대 (IANA)
                </label>
                <input
                  ref={timezoneRef}
                  id="user-profile-timezone"
                  type="text"
                  list="user-profile-timezone-options"
                  value={timezone}
                  disabled={saving}
                  onChange={(event) => {
                    setTimezone(event.target.value);
                    mutate();
                  }}
                  aria-invalid={timezoneInvalid ? "true" : undefined}
                  aria-describedby={timezoneInvalid ? "user-profile-timezone-error" : "user-profile-timezone-help"}
                  className={`mt-1 ${field}`}
                  placeholder="예: Europe/London"
                />
                <datalist id="user-profile-timezone-options">
                  {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
                </datalist>
                {timezoneInvalid ? (
                  <span id="user-profile-timezone-error" className="mt-1 block break-words text-[12px] text-error">
                    IANA 시간대 이름을 확인하세요.
                  </span>
                ) : (
                  <span id="user-profile-timezone-help" className="mt-1 block break-words text-[12px] leading-relaxed text-inkSoft">
                    브라우저 기준은 {defaultTimezone}입니다. 다른 IANA 시간대를 직접 입력할 수 있습니다.
                  </span>
                )}
              </div>

              <div className="block min-w-0">
                <label htmlFor="user-profile-week-start" className="text-[13px] font-medium text-inkSoft">
                  주 시작 요일
                </label>
                <select
                  id="user-profile-week-start"
                  value={weekStartsOn}
                  disabled={saving}
                  onChange={(event) => {
                    setWeekStartsOn(event.target.value as WeekStartsOn);
                    mutate();
                  }}
                  className={`mt-1 min-h-11 ${field}`}
                >
                  <option value="monday">월요일</option>
                  <option value="sunday">일요일</option>
                </select>
              </div>
            </div>
          </details>

          <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <button
              type="submit"
              disabled={!canSave}
              className="min-h-11 w-full rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50 sm:w-auto"
            >
              {saving ? "저장 중…" : "내 정보 저장"}
            </button>
            {edited && dirty && !saving && feedback === "idle" && (
              <span className="break-words text-[13px] text-inkSoft">변경됨</span>
            )}
            {feedback === "saved" && (
              <span role="status" aria-live="polite" className="break-words text-[13px] text-success">
                저장됨
              </span>
            )}
            {feedback === "pending" && (
              <span role="status" aria-live="polite" className="break-words text-[13px] text-warn">
                저장됨 · 디스크 동기화 확인 대기
              </span>
            )}
            {feedback === "save_error" && (
              <span role="status" aria-live="polite" className="min-w-0 break-words text-[13px] text-error">
                내 정보를 저장하지 못했어요. 입력값을 유지했으니 잠시 후 다시 시도하세요.
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
