"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { useHealth } from "@/components/useHealth";
import type {
  CorrectionMode,
  PipelineSettings,
  WhisperModel,
} from "@/lib/pipelineSettings";

const MODEL_OPTIONS: Array<{ value: WhisperModel; label: string }> = [
  { value: "large-v3", label: "large-v3 — 품질 우선(기본)" },
  { value: "large-v3-turbo", label: "large-v3-turbo — 더 빠른 후보" },
];

const CORRECTION_OPTIONS: Array<{ value: CorrectionMode; label: string }> = [
  { value: "full", label: "전체 교정 — 품질 우선(기본)" },
  { value: "fast", label: "빠른 교정 — 명시적 선택" },
];

const fieldClass =
  "min-h-11 w-full min-w-0 rounded-md border border-inkFaint bg-panel px-3 py-2 text-[14px] text-ink focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";
type PrepareState =
  | { model: WhisperModel; status: "preparing" | "ready" | "error" }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isWhisperModel(value: unknown): value is WhisperModel {
  return value === "large-v3" || value === "large-v3-turbo";
}

function isCorrectionMode(value: unknown): value is CorrectionMode {
  return value === "full" || value === "fast";
}

function parseSettings(value: unknown): PipelineSettings | null {
  if (!isRecord(value) || !exactKeys(value, ["transcription", "correction"])) {
    return null;
  }
  const transcription = value.transcription;
  const correction = value.correction;
  if (
    !isRecord(transcription)
    || !exactKeys(transcription, ["model"])
    || !isWhisperModel(transcription.model)
    || !isRecord(correction)
    || !exactKeys(correction, ["mode"])
    || !isCorrectionMode(correction.mode)
  ) {
    return null;
  }
  return {
    transcription: { model: transcription.model },
    correction: { mode: correction.mode },
  };
}

function parseLoadResponse(value: unknown): PipelineSettings | null {
  if (
    !isRecord(value)
    || !exactKeys(value, ["source", "settings"])
    || (value.source !== "default" && value.source !== "stored")
  ) {
    return null;
  }
  return parseSettings(value.settings);
}

function parseSaveResponse(value: unknown): PipelineSettings | null {
  if (
    !isRecord(value)
    || !exactKeys(value, ["settings", "durability"])
    || !["durable", "best_effort", "pending"].includes(String(value.durability))
  ) {
    return null;
  }
  return parseSettings(value.settings);
}

function parsePrepareResponse(
  value: unknown,
  expectedModel: WhisperModel,
): "preparing" | "ready" | null {
  if (
    !isRecord(value)
    || !exactKeys(value, ["model", "status"])
    || value.model !== expectedModel
    || (value.status !== "preparing" && value.status !== "ready")
  ) {
    return null;
  }
  return value.status;
}

export function PipelineSettingsForm() {
  const health = useHealth();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [model, setModel] = useState<WhisperModel>("large-v3");
  const [correctionMode, setCorrectionMode] = useState<CorrectionMode>("full");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [prepareState, setPrepareState] = useState<PrepareState>(null);
  const prepareRequestRef = useRef(0);
  const selectedModelRef = useRef<WhisperModel>("large-v3");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/settings/pipeline", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("load failed");
        const settings = parseLoadResponse(await response.json());
        if (!settings) throw new Error("invalid response");
        if (!active) return;
        setModel(settings.transcription.model);
        selectedModelRef.current = settings.transcription.model;
        setCorrectionMode(settings.correction.mode);
        setLoadState("ready");
      } catch {
        if (active) setLoadState("error");
      }
    })();
    return () => {
      active = false;
      prepareRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!prepareState || prepareState.status !== "preparing") return;
    const current = health.whisper?.modelPreparation?.find(
      (item) => item.model === prepareState.model,
    );
    if (current?.status === "ready" || current?.status === "error") {
      setPrepareState({ model: prepareState.model, status: current.status });
    }
  }, [health.whisper, prepareState]);

  function changeModel(nextModel: WhisperModel) {
    prepareRequestRef.current += 1;
    selectedModelRef.current = nextModel;
    setModel(nextModel);
    setPrepareState(null);
    setSaveState("idle");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState !== "ready" || saveState === "saving") return;
    setSaveState("saving");
    const settings: PipelineSettings = {
      transcription: { model },
      correction: { mode: correctionMode },
    };
    try {
      const response = await fetch("/api/settings/pipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error("save failed");
      const saved = parseSaveResponse(await response.json());
      if (!saved) throw new Error("invalid response");
      setModel(saved.transcription.model);
      selectedModelRef.current = saved.transcription.model;
      setCorrectionMode(saved.correction.mode);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function prepareSelectedModel() {
    if (loadState !== "ready") return;
    const requestedModel = model;
    const requestId = ++prepareRequestRef.current;
    setPrepareState({ model: requestedModel, status: "preparing" });
    try {
      const response = await fetch("/api/whisper/models/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: requestedModel }),
      });
      if (!response.ok) throw new Error("prepare failed");
      const status = parsePrepareResponse(await response.json(), requestedModel);
      if (!status) throw new Error("invalid response");
      if (
        requestId !== prepareRequestRef.current
        || selectedModelRef.current !== requestedModel
      ) {
        return;
      }
      setPrepareState({ model: requestedModel, status });
    } catch {
      if (
        requestId === prepareRequestRef.current
        && selectedModelRef.current === requestedModel
      ) {
        setPrepareState({ model: requestedModel, status: "error" });
      }
    }
  }

  const settingsStatus = loadState === "loading"
    ? "불러오는 중"
    : loadState === "error"
      ? "설정을 불러오지 못했습니다."
      : saveState === "saving"
        ? "저장 중"
        : saveState === "saved"
          ? "저장됨"
          : saveState === "error"
            ? "설정을 저장하지 못했습니다. 다시 시도하세요."
            : "변경할 수 있습니다.";

  const prepareStatus = prepareState?.status === "preparing"
    ? `${prepareState.model} 모델 준비 중`
    : prepareState?.status === "ready"
      ? `${prepareState.model} 모델 준비 완료`
      : prepareState?.status === "error"
        ? "모델을 준비하지 못했습니다. 선택은 유지됐습니다. 잠시 후 다시 시도하세요."
        : "모델 준비는 저장과 별도로 시작합니다.";

  return (
    <section aria-labelledby="pipeline-settings-heading">
      <form
        className="min-w-0 rounded-xl border border-inkFaint bg-panel p-4 sm:p-6"
        onSubmit={save}
      >
        <div>
          <h2 id="pipeline-settings-heading" className="text-lg font-semibold text-ink">
            전사·교정
          </h2>
          <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
            품질 우선 모델이 기본입니다. 더 빠른 모델은 직접 선택한 경우에만 사용합니다.
          </p>
        </div>

        <div className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="min-w-0 text-[14px] font-medium text-ink">
            Whisper 모델
            <select
              aria-label="Whisper 모델"
              className={`${fieldClass} mt-2`}
              disabled={loadState !== "ready"}
              value={model}
              onChange={(event) => changeModel(event.target.value as WhisperModel)}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="min-w-0 text-[14px] font-medium text-ink">
            교정 방식
            <select
              aria-label="교정 방식"
              className={`${fieldClass} mt-2`}
              disabled={loadState !== "ready"}
              value={correctionMode}
              onChange={(event) => {
                setCorrectionMode(event.target.value as CorrectionMode);
                setSaveState("idle");
              }}
            >
              {CORRECTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            className="min-h-11 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-semibold text-white sm:w-auto"
            disabled={loadState !== "ready" || saveState === "saving"}
          >
            설정 저장
          </button>
          <button
            type="button"
            className="min-h-11 w-full rounded-md border border-inkFaint px-4 py-2 text-[14px] font-semibold text-ink sm:w-auto"
            disabled={loadState !== "ready" || prepareState?.status === "preparing"}
            onClick={() => void prepareSelectedModel()}
          >
            선택 모델 미리 준비
          </button>
        </div>

        <div className="mt-4 space-y-1 text-[13px] text-inkSoft">
          <p role="status" aria-label="전사·교정 설정 상태">{settingsStatus}</p>
          <p role="status" aria-label="Whisper 모델 준비 상태">{prepareStatus}</p>
        </div>
      </form>
    </section>
  );
}
