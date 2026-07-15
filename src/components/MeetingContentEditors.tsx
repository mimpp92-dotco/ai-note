"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import type { EditableSummary } from "@/domain/summary";

export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

const FIELD_CLASS =
  "mt-1 min-h-11 w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:bg-soft disabled:opacity-70";
const SECONDARY_CONTROL_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-panel px-4 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";
const PRIMARY_CONTROL_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-5 py-2 text-[13px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";

export interface EditorStatus {
  kind: "neutral" | "success" | "warning" | "error";
  message: string;
}

function statusClass(kind: EditorStatus["kind"]): string {
  if (kind === "error") return "text-error";
  if (kind === "warning") return "text-warn";
  if (kind === "success") return "text-success";
  return "text-inkSoft";
}

function preventComposingSubmit(event: KeyboardEvent<HTMLFormElement>) {
  if (
    event.key === "Enter"
    && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
  ) event.preventDefault();
}

export function normalizeTranscriptDraft(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function TranscriptEditor({
  id,
  value,
  onChange,
  onSave,
  onCancel,
  busy = false,
  saveDisabled = false,
  cancelDisabled = false,
  status = null,
  supplemental = null,
  focusRequest = 0,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  onSave(normalized: string): void;
  onCancel(): void;
  busy?: boolean;
  saveDisabled?: boolean;
  cancelDisabled?: boolean;
  status?: EditorStatus | null;
  supplemental?: ReactNode;
  focusRequest?: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const normalized = normalizeTranscriptDraft(value);
  const bytes = utf8Bytes(normalized);
  const inputId = `transcript-editor-${id}`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
  }, [focusRequest]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalized.trim().length === 0) {
      setValidation("전체 스크립트는 비워 둘 수 없습니다.");
      inputRef.current?.focus();
      return;
    }
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      setValidation("전체 스크립트는 UTF-8 기준 1 MiB 이하여야 합니다.");
      inputRef.current?.focus();
      return;
    }
    setValidation(null);
    onSave(normalized);
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={preventComposingSubmit}
      className="rounded-[14px] border border-line bg-panel p-4 sm:p-5"
    >
      <label htmlFor={inputId} className="block text-[14px] font-semibold text-ink">
        전체 스크립트
      </label>
      <p id={helpId} className="mt-1 text-[12px] text-inkSoft">
        교정된 스크립트만 바뀌며 녹음 원본과 자동 전사 원문은 유지됩니다.
      </p>
      <textarea
        ref={inputRef}
        id={inputId}
        rows={16}
        value={value}
        disabled={busy}
        onChange={(event) => {
          setValidation(null);
          onChange(event.target.value);
        }}
        aria-invalid={validation ? "true" : undefined}
        aria-describedby={`${helpId} ${validation ? errorId : ""} ${statusId}`.trim()}
        className={`${FIELD_CLASS} min-h-64 resize-y font-mono leading-relaxed`}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-inkSoft">
        <span>{bytes.toLocaleString("en-US")} / {MAX_TRANSCRIPT_BYTES.toLocaleString("en-US")} bytes</span>
        <span>UTF-8</span>
      </div>
      {validation && (
        <p id={errorId} className="mt-2 text-[13px] text-error">
          {validation}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || saveDisabled} className={PRIMARY_CONTROL_CLASS}>
          {busy ? "저장 확인 중…" : "전체 스크립트 저장"}
        </button>
        <button type="button" disabled={busy || cancelDisabled} onClick={onCancel} className={SECONDARY_CONTROL_CLASS}>
          수정 취소
        </button>
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={`mt-3 min-h-5 text-[13px] ${status ? statusClass(status.kind) : "text-inkSoft"}`}
      >
        {status?.message ?? ""}
      </p>
      {supplemental}
    </form>
  );
}

export interface SummaryDraftItem {
  key: string;
  value: string;
}

export interface SummaryActionDraft {
  key: string;
  owner: string;
  task: string;
  due: string;
}

export interface SummaryEditorDraft {
  oneLine: string;
  purpose: string;
  highlights: SummaryDraftItem[];
  discussion: SummaryDraftItem[];
  decisions: SummaryDraftItem[];
  actionItems: SummaryActionDraft[];
  risks: SummaryDraftItem[];
  followups: SummaryDraftItem[];
}

export type SummaryListField =
  | "highlights"
  | "discussion"
  | "decisions"
  | "risks"
  | "followups";

let nextDraftKey = 0;

function draftKey(prefix: string): string {
  nextDraftKey += 1;
  return `${prefix}-${nextDraftKey}`;
}

export function createSummaryEditorDraft(summary: EditableSummary): SummaryEditorDraft {
  const items = (field: SummaryListField) => summary[field].map((value) => ({
    key: draftKey(field),
    value,
  }));
  return {
    oneLine: summary.oneLine,
    purpose: summary.purpose,
    highlights: items("highlights"),
    discussion: items("discussion"),
    decisions: items("decisions"),
    actionItems: summary.actionItems.map((item) => ({
      key: draftKey("action"),
      ...item,
    })),
    risks: items("risks"),
    followups: items("followups"),
  };
}

export function summaryDraftToEditable(draft: SummaryEditorDraft): EditableSummary {
  const items = (field: SummaryListField) => draft[field].map((item) => item.value.trim());
  return {
    oneLine: draft.oneLine.trim(),
    purpose: draft.purpose.trim(),
    highlights: items("highlights"),
    discussion: items("discussion"),
    decisions: items("decisions"),
    actionItems: draft.actionItems.map(({ owner, task, due }) => ({ owner, task, due })),
    risks: items("risks"),
    followups: items("followups"),
  };
}

const LIST_FIELDS: { field: SummaryListField; label: string }[] = [
  { field: "highlights", label: "핵심" },
  { field: "discussion", label: "논의 내용" },
  { field: "decisions", label: "결정 사항" },
  { field: "risks", label: "리스크" },
  { field: "followups", label: "후속 확인" },
];

interface SummaryValidation {
  listKeys: Set<string>;
  actionKeys: Set<string>;
}

function emptyValidation(): SummaryValidation {
  return { listKeys: new Set(), actionKeys: new Set() };
}

export function SummaryEditor({
  id,
  draft,
  onChange,
  onSave,
  onCancel,
  busy = false,
  saveDisabled = false,
  cancelDisabled = false,
  status = null,
  supplemental = null,
  focusRequest = 0,
}: {
  id: string;
  draft: SummaryEditorDraft;
  onChange(draft: SummaryEditorDraft): void;
  onSave(summary: EditableSummary): void;
  onCancel(): void;
  busy?: boolean;
  saveDisabled?: boolean;
  cancelDisabled?: boolean;
  status?: EditorStatus | null;
  supplemental?: ReactNode;
  focusRequest?: number;
}) {
  const rootRef = useRef<HTMLFormElement>(null);
  const [validation, setValidation] = useState<SummaryValidation>(emptyValidation);
  const statusId = `summary-editor-${id}-status`;

  useEffect(() => {
    if (focusRequest === 0) return;
    rootRef.current?.querySelector<HTMLElement>("textarea, input")?.focus();
  }, [focusRequest]);

  const replaceList = (
    field: SummaryListField,
    updater: (items: SummaryDraftItem[]) => SummaryDraftItem[],
  ) => {
    setValidation(emptyValidation());
    onChange({ ...draft, [field]: updater(draft[field]) });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const listKeys = new Set<string>();
    for (const { field } of LIST_FIELDS) {
      for (const item of draft[field]) {
        if (item.value.trim().length === 0) listKeys.add(item.key);
      }
    }
    const actionKeys = new Set(
      draft.actionItems
        .filter((item) => !item.owner.trim() || !item.task.trim() || !item.due.trim())
        .map((item) => item.key),
    );
    setValidation({ listKeys, actionKeys });
    const invalidKeys = [...listKeys, ...actionKeys];
    const firstInvalid = invalidKeys.length > 0
      ? rootRef.current?.querySelector<HTMLElement>(
          invalidKeys.map((key) => `[data-draft-key="${key}"]`).join(","),
        )
      : null;
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }
    onSave(summaryDraftToEditable(draft));
  };

  return (
    <form
      ref={rootRef}
      onSubmit={submit}
      onKeyDown={preventComposingSubmit}
      className="space-y-6 rounded-[14px] border border-line bg-panel p-4 sm:p-5"
    >
      <div>
        <label htmlFor={`summary-one-line-${id}`} className="block text-[13px] font-semibold text-ink">
          한 줄 요약
        </label>
        <textarea
          id={`summary-one-line-${id}`}
        rows={2}
        value={draft.oneLine}
        disabled={busy}
        aria-describedby={statusId}
        onChange={(event) => onChange({ ...draft, oneLine: event.target.value })}
        className={`${FIELD_CLASS} resize-y`}
        />
      </div>
      <div>
        <label htmlFor={`summary-purpose-${id}`} className="block text-[13px] font-semibold text-ink">
          목적
        </label>
        <textarea
          id={`summary-purpose-${id}`}
        rows={3}
        value={draft.purpose}
        disabled={busy}
        aria-describedby={statusId}
        onChange={(event) => onChange({ ...draft, purpose: event.target.value })}
        className={`${FIELD_CLASS} resize-y`}
        />
      </div>

      {LIST_FIELDS.map(({ field, label }) => (
        <fieldset key={field} className="space-y-3 border-t border-line pt-5">
          <legend className="text-[14px] font-bold text-ink">{label}</legend>
          {draft[field].map((item, index) => {
            const inputId = `summary-${field}-${item.key}`;
            const errorId = `${inputId}-error`;
            const invalid = validation.listKeys.has(item.key);
            return (
              <div key={item.key} className="rounded-[12px] bg-soft p-3">
                <label htmlFor={inputId} className="block text-[12px] font-medium text-inkSoft">
                  {label} {index + 1}
                </label>
                <textarea
                  id={inputId}
                  data-draft-key={item.key}
                  rows={3}
                  value={item.value}
                  disabled={busy}
                  aria-invalid={invalid ? "true" : undefined}
                  aria-describedby={invalid ? `${errorId} ${statusId}` : statusId}
                  onChange={(event) => replaceList(field, (items) => items.map((candidate) => (
                    candidate.key === item.key ? { ...candidate, value: event.target.value } : candidate
                  )))}
                  className={`${FIELD_CLASS} resize-y`}
                />
                {invalid && (
                  <p id={errorId} className="mt-1 text-[12px] text-error">
                    빈 목록 항목을 삭제하거나 내용을 입력하세요.
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => replaceList(field, (items) => items.filter((candidate) => candidate.key !== item.key))}
                  className={`${SECONDARY_CONTROL_CLASS} mt-2 text-error`}
                >
                  {label} {index + 1} 삭제
                </button>
              </div>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => replaceList(field, (items) => [...items, { key: draftKey(field), value: "" }])}
            className={SECONDARY_CONTROL_CLASS}
          >
            {label} 추가
          </button>
        </fieldset>
      ))}

      <fieldset className="space-y-3 border-t border-line pt-5">
        <legend className="text-[14px] font-bold text-ink">액션 아이템</legend>
        {draft.actionItems.map((item, index) => {
          const invalid = validation.actionKeys.has(item.key);
          const errorId = `summary-action-${item.key}-error`;
          const update = (next: Partial<SummaryActionDraft>) => {
            setValidation(emptyValidation());
            onChange({
              ...draft,
              actionItems: draft.actionItems.map((candidate) => (
                candidate.key === item.key ? { ...candidate, ...next } : candidate
              )),
            });
          };
          return (
            <div key={item.key} className="space-y-3 rounded-[12px] bg-soft p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {(["owner", "task", "due"] as const).map((field) => {
                  const label = field === "owner" ? "담당자" : field === "task" ? "할 일" : "기한";
                  const inputId = `summary-action-${item.key}-${field}`;
                  return (
                    <label key={field} htmlFor={inputId} className="block text-[12px] font-medium text-inkSoft">
                      액션 아이템 {index + 1} {label}
                      <input
                        id={inputId}
                        data-draft-key={item.key}
                        value={item[field]}
                        disabled={busy}
                        aria-invalid={invalid ? "true" : undefined}
                        aria-describedby={invalid ? `${errorId} ${statusId}` : statusId}
                        onChange={(event) => update({ [field]: event.target.value })}
                        className={FIELD_CLASS}
                      />
                    </label>
                  );
                })}
              </div>
              {invalid && (
                <p id={errorId} className="text-[12px] text-error">
                  담당자, 할 일, 기한을 모두 입력하세요.
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange({
                  ...draft,
                  actionItems: draft.actionItems.filter((candidate) => candidate.key !== item.key),
                })}
                className={`${SECONDARY_CONTROL_CLASS} text-error`}
              >
                액션 아이템 {index + 1} 삭제
              </button>
            </div>
          );
        })}
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({
            ...draft,
            actionItems: [
              ...draft.actionItems,
              { key: draftKey("action"), owner: "", task: "", due: "" },
            ],
          })}
          className={SECONDARY_CONTROL_CLASS}
        >
          액션 아이템 추가
        </button>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
        <button type="submit" disabled={busy || saveDisabled} className={PRIMARY_CONTROL_CLASS}>
          {busy ? "저장 확인 중…" : "회의록 요약 저장"}
        </button>
        <button type="button" disabled={busy || cancelDisabled} onClick={onCancel} className={SECONDARY_CONTROL_CLASS}>
          수정 취소
        </button>
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={`min-h-5 text-[13px] ${status ? statusClass(status.kind) : "text-inkSoft"}`}
      >
        {status?.message ?? ""}
      </p>
      {supplemental}
    </form>
  );
}
