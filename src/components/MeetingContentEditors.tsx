"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { normalizeManualSummaryBody } from "@/lib/summaryBody";

export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
export const MAX_SUMMARY_PATCH_BYTES = 512 * 1024;

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

export function SummaryEditor({
  id,
  value,
  expectedRevision,
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
  expectedRevision: { transcriptSha256: string; summarySha256: string };
  onChange(value: string): void;
  onSave(body: string): void;
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
  const inputId = `summary-editor-${id}`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;
  const normalized = normalizeManualSummaryBody(value);
  const normalizedBody = normalized ?? value.replace(/\r\n/gu, "\n");
  const bodyBytes = utf8Bytes(normalizedBody);
  const requestBytes = utf8Bytes(JSON.stringify({
    expectedRevision,
    body: normalizedBody,
  }));

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
  }, [focusRequest]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalized === null) {
      setValidation("회의록 요약 본문은 비워 둘 수 없습니다.");
      inputRef.current?.focus();
      return;
    }
    if (requestBytes > MAX_SUMMARY_PATCH_BYTES) {
      setValidation("저장 요청은 UTF-8 기준 512 KiB 이하여야 합니다.");
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
        회의록 요약 본문
      </label>
      <p id={helpId} className="mt-1 text-[12px] text-inkSoft">
        제목, 글머리표와 줄바꿈을 포함한 plain text 전체를 그대로 저장합니다.
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
        <span>
          본문 UTF-8 {bodyBytes.toLocaleString("en-US")} bytes · 요청{" "}
          {requestBytes.toLocaleString("en-US")} / {MAX_SUMMARY_PATCH_BYTES.toLocaleString("en-US")} bytes
        </span>
        <span>UTF-8</span>
      </div>
      {validation && (
        <p id={errorId} className="mt-2 text-[13px] text-error">
          {validation}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
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
        className={`mt-3 min-h-5 text-[13px] ${status ? statusClass(status.kind) : "text-inkSoft"}`}
      >
        {status?.message ?? ""}
      </p>
      {supplemental}
    </form>
  );
}
