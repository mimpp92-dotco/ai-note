// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecorderFinalizeResultView } from "@/components/RecorderFinalizeResultView";

const DEFAULT_WORKSPACE = "10000000-0000-4000-8000-000000000001";
const FOLDER = "30000000-0000-4000-8000-000000000003";
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: {
    href: string;
    children: import("react").ReactNode;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/components/LibraryProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LibraryProvider")>();
  return {
    ...actual,
    useOptionalLibrary: () => ({
      library: {
        defaultWorkspaceId: DEFAULT_WORKSPACE,
        workspaces: [{ id: DEFAULT_WORKSPACE, name: "기본" }],
        folders: [{ id: FOLDER, parentFolderId: null, name: "프로젝트" }],
      },
    }),
  };
});

const base = {
  artifact: "published" as const,
  durability: "durable" as const,
  playback: "ready" as const,
  transcription: "accepted" as const,
  placement: {
    requested: { workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER },
    actual: { workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER },
    outcome: "saved" as const,
    fallbackReason: null,
  },
};

describe("RecorderFinalizeResultView", () => {
  beforeEach(() => {
    router.push.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the authoritative breadcrumb and marks destination focus before navigation", () => {
    render(<RecorderFinalizeResultView meetingId="meeting-result" result={base} onRefresh={vi.fn()} />);
    expect(screen.getByText("실제: 기본 / 프로젝트")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "실제 위치 열기" });
    expect(link).toHaveAttribute("href", `/?workspace=${DEFAULT_WORKSPACE}&folder=${FOLDER}`);
    fireEvent.click(link);
    expect(window.sessionStorage.getItem("ai-note-focus-scope")).toBe("1");
  });

  it("separates partial recovery and omits placement retry for a null receipt", () => {
    const onRefresh = vi.fn();
    render(<RecorderFinalizeResultView
      meetingId="meeting-result"
      result={{
        ...base,
        durability: "pending",
        playback: "failed",
        transcription: "failed",
        placement: {
          requested: null,
          actual: null,
          outcome: "unavailable",
          fallbackReason: null,
        },
      }}
      onRefresh={onRefresh}
    />);
    expect(screen.getByText(/안정화하는 중/)).toBeInTheDocument();
    expect(screen.getByText(/브라우저 재생 파일/)).toBeInTheDocument();
    expect(screen.getByText(/로컬 전사 요청/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "위치 저장 다시 확인" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장 상태 새로고침" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "데이터 폴더 열기" })).toBeInTheDocument();
  });

  it("posts the exact meeting ID once, refreshes the finalize result, and restores trigger focus", async () => {
    let finishRequest: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    }));
    const onRefresh = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RecorderFinalizeResultView
        meetingId="meeting-retry-exact"
        result={{ ...base, transcription: "failed" }}
        onRefresh={onRefresh}
      />,
    );

    const trigger = screen.getByRole("button", { name: "전사 다시 시도" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "전사 요청 중…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "전사 요청 중…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "meeting-retry-exact" }),
    });

    await act(async () => {
      finishRequest?.(new Response(JSON.stringify({
        id: "meeting-retry-exact",
        status: "transcribing",
        durability: "durable",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status", { name: "전사 다시 시도 상태" }))
      .toHaveTextContent("최신 전사 상태를 확인했습니다.");
    expect(trigger).toHaveFocus();
  });

  it("keeps the retry action and shows only a static safe failure after refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "private_provider_path", message: "/tmp/private/provider" },
    }), { status: 502 })));
    render(
      <RecorderFinalizeResultView
        meetingId="meeting-retry-safe"
        result={{ ...base, transcription: "failed" }}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전사 다시 시도" }));
    expect(await screen.findByRole("status", { name: "전사 다시 시도 상태" })).toHaveTextContent(
      "전사 요청을 보내지 못했습니다. 녹음 원본은 보존됐습니다. 잠시 후 다시 시도하세요.",
    );
    expect(screen.getByRole("button", { name: "전사 다시 시도" })).toBeEnabled();
    expect(screen.queryByText(/private|\/tmp|provider/u)).not.toBeInTheDocument();
  });
});
