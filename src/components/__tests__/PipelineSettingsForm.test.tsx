// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelineSettingsForm } from "@/components/PipelineSettingsForm";

const health = vi.hoisted(() => ({
  value: {
    whisper: {
      connected: true,
      ok: true,
      ready: true,
      model: "large-v3",
      modelPreparation: [
        { model: "large-v3" as const, status: "idle" as const },
        { model: "large-v3-turbo" as const, status: "idle" as const },
      ],
    },
    llm: null,
  },
}));

vi.mock("@/components/useHealth", () => ({
  useHealth: () => health.value,
}));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function defaultSettingsResponse() {
  return json({
    source: "default",
    settings: {
      transcription: { model: "large-v3" },
      correction: { mode: "full" },
    },
  });
}

describe("PipelineSettingsForm", () => {
  beforeEach(() => {
    health.value.whisper.modelPreparation = [
      { model: "large-v3", status: "idle" },
      { model: "large-v3-turbo", status: "idle" },
    ];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows only the two fixed Whisper choices with quality-first defaults and mobile-safe controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(defaultSettingsResponse()));
    render(<PipelineSettingsForm />);

    expect(await screen.findByRole("heading", { name: "전사·교정" })).toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "Whisper 모델" });
    expect(model).toHaveValue("large-v3");
    expect(within(model).getAllByRole("option").map((option) => ({
      text: option.textContent,
      value: (option as HTMLOptionElement).value,
    }))).toEqual([
      { text: "large-v3 — 품질 우선(기본)", value: "large-v3" },
      { text: "large-v3-turbo — 더 빠른 후보", value: "large-v3-turbo" },
    ]);
    expect(within(model).queryByText(/repo|path|직접 입력/u)).not.toBeInTheDocument();

    const correction = screen.getByRole("combobox", { name: "교정 방식" });
    expect(correction).toHaveValue("full");
    expect(within(correction).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "전체 교정 — 품질 우선(기본)",
      "빠른 교정 — 실험적·검증 필요",
    ]);
    expect(model.closest("form")).toHaveClass("p-4", "sm:p-6");
    expect(screen.getByRole("button", { name: "설정 저장" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "선택 모델 미리 준비" })).toHaveClass(
      "min-h-11",
      "w-full",
      "sm:w-auto",
    );
  });

  it("saves model and correction choices without issuing a prepare request", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/pipeline" && init?.method === "POST") {
        const settings = JSON.parse(String(init.body));
        return json({ settings, durability: "durable" });
      }
      return defaultSettingsResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PipelineSettingsForm />);

    const model = await screen.findByRole("combobox", { name: "Whisper 모델" });
    fireEvent.change(model, { target: { value: "large-v3-turbo" } });
    fireEvent.change(screen.getByRole("combobox", { name: "교정 방식" }), {
      target: { value: "fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "전사·교정 설정 상태" }))
      .toHaveTextContent("저장됨"));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toBe("/api/settings/pipeline");
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      transcription: { model: "large-v3-turbo" },
      correction: { mode: "fast" },
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/models/prepare"))).toBe(false);
  });

  it("starts one explicit prepare request and reports its bounded state", async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      if (String(input) === "/api/whisper/models/prepare") {
        return json({ model: "large-v3", status: "preparing" }, 202);
      }
      return defaultSettingsResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PipelineSettingsForm />);

    const prepare = await screen.findByRole("button", { name: "선택 모델 미리 준비" });
    fireEvent.click(prepare);

    await waitFor(() => expect(screen.getByRole("status", { name: "Whisper 모델 준비 상태" }))
      .toHaveTextContent("large-v3 모델 준비 중"));
    expect(fetchMock.mock.calls.filter(([input]) => (
      String(input) === "/api/whisper/models/prepare"
    ))).toHaveLength(1);
    const request = fetchMock.mock.calls.find(([input]) => (
      String(input) === "/api/whisper/models/prepare"
    ));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ model: "large-v3" });
  });

  it("ignores an old prepare response after the selected model changes", async () => {
    const pending: { resolve?: (response: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input) === "/api/whisper/models/prepare") {
        return new Promise<Response>((resolve) => {
          pending.resolve = resolve;
        });
      }
      return Promise.resolve(defaultSettingsResponse());
    }));
    render(<PipelineSettingsForm />);

    const model = await screen.findByRole("combobox", { name: "Whisper 모델" });
    fireEvent.click(screen.getByRole("button", { name: "선택 모델 미리 준비" }));
    fireEvent.change(model, { target: { value: "large-v3-turbo" } });
    pending.resolve?.(json({ model: "large-v3", status: "ready" }));

    await waitFor(() => expect(model).toHaveValue("large-v3-turbo"));
    expect(screen.getByRole("status", { name: "Whisper 모델 준비 상태" }))
      .not.toHaveTextContent("large-v3 모델 준비 완료");
  });

  it("replaces raw prepare failures with safe recovery copy and preserves the selection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/whisper/models/prepare") {
        return new Response("private /Users/dylan/model-cache", { status: 503 });
      }
      return defaultSettingsResponse();
    }));
    render(<PipelineSettingsForm />);

    await screen.findByRole("combobox", { name: "Whisper 모델" });
    fireEvent.click(screen.getByRole("button", { name: "선택 모델 미리 준비" }));

    const status = await screen.findByRole("status", { name: "Whisper 모델 준비 상태" });
    expect(status).toHaveTextContent(
      "모델을 준비하지 못했습니다. 선택은 유지됐습니다. 잠시 후 다시 시도하세요.",
    );
    expect(status).not.toHaveTextContent(/Users|model-cache|private/u);
    expect(screen.getByRole("combobox", { name: "Whisper 모델" })).toHaveValue("large-v3");
  });
});
