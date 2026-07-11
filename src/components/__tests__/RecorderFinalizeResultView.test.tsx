// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("shows the authoritative breadcrumb and marks destination focus before navigation", () => {
    render(<RecorderFinalizeResultView result={base} onRefresh={vi.fn()} />);
    expect(screen.getByText("실제: 기본 / 프로젝트")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "실제 위치 열기" });
    expect(link).toHaveAttribute("href", `/?workspace=${DEFAULT_WORKSPACE}&folder=${FOLDER}`);
    fireEvent.click(link);
    expect(window.sessionStorage.getItem("ai-note-focus-scope")).toBe("1");
  });

  it("separates partial recovery and omits placement retry for a null receipt", () => {
    const onRefresh = vi.fn();
    render(<RecorderFinalizeResultView
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
});
