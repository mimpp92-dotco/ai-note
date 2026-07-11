// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryRecoveryPanel } from "@/components/LibraryRecoveryPanel";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const resetForGeneration = vi.hoisted(() => vi.fn());
let recorderBlocked = false;

vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/components/LibraryProvider", () => ({
  useLibrary: () => ({ resetForGeneration }),
}));
vi.mock("@/components/RecorderSessionProvider", () => ({
  useOptionalRecorderSession: () => ({
    hasUnsavedAudio: recorderBlocked,
    hasRetainedBlob: recorderBlocked,
  }),
}));

const FINGERPRINT = "a".repeat(64);
const NEW_LIBRARY_ID = "20000000-0000-4000-8000-000000000020";
const NEW_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

function renderPanel(
  reason:
    | "corrupt"
    | "unsupported_version"
    | "io_error"
    | "recovery_conflict"
    | "recovery_not_supported" = "corrupt",
) {
  return render(
    <LibraryRecoveryPanel
      mode="degraded_last_good"
      reason={reason}
      recovery={reason === "corrupt" ? { canRebuild: true, fingerprint: FINGERPRINT } : null}
      onRetry={vi.fn()}
    />,
  );
}

function dispatchNativeCancel(dialog: HTMLElement) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

describe("LibraryRecoveryPanel", () => {
  beforeEach(() => {
    recorderBlocked = false;
    navigation.replace.mockReset();
    resetForGeneration.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers rebuild only for corrupt state and explains every destructive-looking reset", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "조직 정보 재구축" }));
    const dialog = screen.getByRole("dialog", { name: "조직 정보 재구축" });
    expect(dialog).toHaveTextContent("워크스페이스 이름과 순서가 초기화");
    expect(dialog).toHaveTextContent("폴더 이름·색상·순서");
    expect(dialog).toHaveTextContent("회의 오디오·전사·요약 artifact 디렉터리는 삭제하지 않습니다");
    expect(dialog).toHaveTextContent("상태 파일까지 손상된 회의는 목록에 나타나지 않을 수 있습니다");
    await waitFor(() => expect(screen.getByRole("button", { name: "취소" })).toHaveFocus());
  });

  it.each([
    "unsupported_version",
    "io_error",
    "recovery_conflict",
    "recovery_not_supported",
  ] as const)(
    "keeps %s read-only without a rebuild action",
    (reason) => {
      renderPanel(reason);
      expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "데이터 폴더 열기" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "조직 정보 재구축" })).not.toBeInTheDocument();
    },
  );

  it("blocks rebuild while a recording Blob is retained", () => {
    recorderBlocked = true;
    renderPanel();
    expect(screen.getByRole("button", { name: "조직 정보 재구축" })).toBeDisabled();
    expect(screen.getByText(/먼저 저장하거나 명시적으로 버린 뒤/)).toBeInTheDocument();
  });

  it("uses exact IME-safe confirmation, sends only the fingerprint, and resets to the new default", async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(JSON.stringify({
        mode: "ready",
        version: { libraryId: NEW_LIBRARY_ID, revision: 0 },
        defaultWorkspaceId: NEW_WORKSPACE_ID,
        result: {
          discoveredVisibleMeetingCount: 7,
          organizationReset: true,
          archivePreserved: true,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "조직 정보 재구축" }));
    const input = screen.getByRole("textbox", { name: /재구축.*정확히 입력/ });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.change(input, { target: { value: "재구축" } });
    fireEvent.compositionStart(input);
    fireEvent.submit(form!);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "재구축" }));

    await waitFor(() => expect(resetForGeneration).toHaveBeenCalledWith({
      discoveredVisibleMeetingCount: 7,
      organizationReset: true,
      archivePreserved: true,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/library/rebuild");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedMode: "corrupt",
      recoveryFingerprint: FINGERPRINT,
    });
    expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
      "expectedMode",
      "recoveryFingerprint",
    ]);
    expect(navigation.replace).toHaveBeenCalledWith(`/?workspace=${NEW_WORKSPACE_ID}`);
    expect(window.sessionStorage.getItem("ai-note-focus-scope")).toBe("1");
  });

  it("keeps rebuild open and non-dismissible while the request is in flight", async () => {
    let finishFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finishFetch = resolve; })));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "조직 정보 재구축" }));
    fireEvent.change(screen.getByRole("textbox", { name: /재구축.*정확히 입력/ }), {
      target: { value: "재구축" },
    });
    fireEvent.click(screen.getByRole("button", { name: "재구축" }));
    await screen.findByRole("button", { name: "재구축 중…" });
    const dialog = screen.getByRole("dialog", { name: "조직 정보 재구축" });
    const cancel = screen.getByRole("button", { name: "취소" });
    expect(cancel).toBeDisabled();
    dispatchNativeCancel(dialog);
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(cancel);
    expect(dialog).toBeInTheDocument();

    finishFetch(new Response(JSON.stringify({ error: { code: "failed" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/완료하지 못했습니다/));
    expect(screen.getByRole("dialog", { name: "조직 정보 재구축" })).toBeInTheDocument();
  });
});
