// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GuardedLink, useGuardedRouter } from "@/components/RecorderNavigation";
import {
  RecorderSessionProvider,
  useRecorderSession,
} from "@/components/RecorderSessionProvider";
import { Recorder } from "@/components/Recorder";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: {
    href: string;
    children: import("react").ReactNode;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  readonly mimeType: string;
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  requestData() {
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

function Probe() {
  const session = useRecorderSession();
  return (
    <output data-testid="session">
      {session.phase}:{session.meetingId ?? "none"}
    </output>
  );
}

function ProgrammaticNavigation() {
  const router = useGuardedRouter();
  return <button onClick={(event) => router.push("/settings", event.currentTarget)}>프로그램 이동</button>;
}

function App({ full = true }: { full?: boolean }) {
  return (
    <RecorderSessionProvider>
      {full && <Recorder />}
      <SessionCapture />
      <Probe />
      <GuardedLink href="/settings">설정으로</GuardedLink>
      <GuardedLink href="/?workspaceId=00000000-0000-4000-8000-000000000001">범위 이동</GuardedLink>
      <ProgrammaticNavigation />
    </RecorderSessionProvider>
  );
}

async function startRecording() {
  fireEvent.click(screen.getByRole("button", { name: "실시간 기록 시작" }));
  await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/));
}

function dispatchNativeCancel(dialog: HTMLElement) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

describe("RecorderSessionProvider", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.replace.mockReset();
    navigation.back.mockReset();
    navigation.refresh.mockReset();
    latestSession = null;
    window.history.replaceState({}, "", "/");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the stable session and stop control when the full recorder unmounts", async () => {
    const view = render(<App />);
    await startRecording();
    const session = screen.getByTestId("session").textContent;

    view.rerender(<App full={false} />);
    expect(screen.getByTestId("session")).toHaveTextContent(session!);
    expect(screen.getByRole("button", { name: "기록 중지" })).toBeInTheDocument();
  });

  it("retains captured audio while uploading and only confirmed explicit discard removes it", async () => {
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/));
    fireEvent.click(screen.getByRole("button", { name: "기록 중지" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^uploading:/));
    expect(screen.getByText("녹음을 저장하는 중…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "녹음 버리기" }));
    expect(screen.getByRole("dialog", { name: "녹음을 영구히 버릴까요?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "유지하기" })).toHaveFocus());
    expect(screen.getByTestId("session")).toHaveTextContent(/^uploading:/);
    fireEvent.click(screen.getByRole("button", { name: "녹음 영구히 버리기" }));
    expect(screen.getByTestId("session")).toHaveTextContent("idle:none");
  });

  it("does not offer a new recording while a retained Blob is blocked by a finalize conflict", async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/finalize?")) {
        return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
      }
      return new Response(JSON.stringify({ status: "recorded", error: null }), { status: 200 });
    }));
    render(<App />);
    await startRecording();
    fireEvent.click(screen.getAllByRole("button", { name: "기록 중지" })[0]);
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^failed:/));
    expect(screen.getByRole("button", { name: "저장 상태 충돌" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "데이터 폴더 열기" })).toBeInTheDocument();
    expect(screen.getByText(/원본을 덮어쓰지 않습니다/)).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("blocks link and programmatic non-scope navigation, focuses cancel, and discards explicitly", async () => {
    render(<App />);
    await startRecording();
    const link = screen.getByRole("link", { name: "설정으로" });
    fireEvent.click(link);
    expect(navigation.push).not.toHaveBeenCalled();
    const cancel = await screen.findByRole("button", { name: "계속 녹음" });
    await waitFor(() => expect(cancel).toHaveFocus());
    dispatchNativeCancel(screen.getByRole("dialog", { name: "녹음이 아직 저장되지 않았습니다" }));
    await waitFor(() => expect(link).toHaveFocus());
    expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/);

    fireEvent.click(screen.getByRole("button", { name: "프로그램 이동" }));
    fireEvent.click(await screen.findByRole("button", { name: "녹음 버리고 이동" }));
    expect(navigation.push).toHaveBeenCalledWith("/settings");
    expect(screen.getByTestId("session")).toHaveTextContent("idle:none");
  });

  it("returns from permanent discard confirmation to its connected trigger", async () => {
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/));
    const trigger = screen.getByRole("button", { name: "녹음 버리기" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "녹음을 영구히 버릴까요?" });
    await waitFor(() => expect(screen.getByRole("button", { name: "유지하기" })).toHaveFocus());
    dispatchNativeCancel(dialog);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/);
  });

  it("allows a scope-query-only navigation without interrupting recording", async () => {
    render(<App />);
    await startRecording();
    fireEvent.click(screen.getByRole("link", { name: "범위 이동" }));
    expect(navigation.push).toHaveBeenCalledWith(
      "/?workspaceId=00000000-0000-4000-8000-000000000001",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/);
  });

  it("intercepts popstate and provides beforeunload best-effort protection", async () => {
    render(<App />);
    await startRecording();
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);

    window.history.pushState({}, "", "/glossary");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it.each([
    ["All", { workspaceId: "10000000-0000-4000-8000-000000000001", folderId: null }],
    ["unfiled", { workspaceId: "20000000-0000-4000-8000-000000000002", folderId: null }],
    ["folder", { workspaceId: "20000000-0000-4000-8000-000000000002", folderId: "30000000-0000-4000-8000-000000000003" }],
  ])("pins the %s location at start and sends only canonical IDs", async (_label, requestedLocation) => {
    const finalizeCalls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/finalize?")) {
        finalizeCalls.push([url, init ?? {}]);
        return new Response(JSON.stringify({
          artifact: "published",
          durability: "durable",
          playback: "ready",
          placement: { requested: requestedLocation, actual: requestedLocation, outcome: "saved", fallbackReason: null },
          transcription: "accepted",
          status: "transcribing",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "transcribing", error: null }), { status: 200 });
    }));
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start({ requestedLocation }));
    act(() => session.stop());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^saved:/));
    expect(finalizeCalls).toHaveLength(1);
    const url = new URL(finalizeCalls[0][0], "http://127.0.0.1:3000");
    expect(url.searchParams.get("workspaceId")).toBe(requestedLocation.workspaceId);
    expect(url.searchParams.get("folderId")).toBe(requestedLocation.folderId);
    expect(JSON.stringify(finalizeCalls[0][1])).not.toContain("name");
  });

  it("probes without a body after response loss and accepts an already-published result", async () => {
    const finalizeCalls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/finalize?")) {
        return new Response(JSON.stringify({ status: "transcribing", error: null }), { status: 200 });
      }
      finalizeCalls.push(init ?? {});
      if (finalizeCalls.length === 1) throw new Error("response lost");
      return new Response(JSON.stringify({
        probe: "published",
        artifact: "already_published",
        durability: "durable",
        playback: "unchanged",
        version: null,
        placement: { requested: null, actual: null, outcome: "unavailable", fallbackReason: null },
        transcription: "unchanged",
        status: "transcribing",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    act(() => session.stop());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^finalize_ambiguous:/));
    fireEvent.click(screen.getByRole("button", { name: "저장 상태 확인" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^saved:/));
    expect(finalizeCalls).toHaveLength(2);
    expect(finalizeCalls[0].body).toBeInstanceOf(Blob);
    expect(finalizeCalls[1].body).toBeUndefined();
    expect(new Headers(finalizeCalls[1].headers).get("x-ai-note-finalize-probe")).toBe("1");
  });

  it("retries the retained body with the same ID only after a not-committed probe", async () => {
    const finalizeCalls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/finalize?")) {
        return new Response(JSON.stringify({ status: "transcribing", error: null }), { status: 200 });
      }
      finalizeCalls.push({ url, init: init ?? {} });
      if (finalizeCalls.length === 1) throw new Error("response lost");
      if (finalizeCalls.length === 2) {
        return new Response(JSON.stringify({ probe: "not_committed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        artifact: "published",
        durability: "durable",
        playback: "ready",
        placement: { requested: null, actual: null, outcome: "unavailable", fallbackReason: null },
        transcription: "accepted",
        status: "transcribing",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    act(() => session.stop());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^finalize_ambiguous:/));
    fireEvent.click(screen.getByRole("button", { name: "저장 상태 확인" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "저장 다시 시도" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "저장 다시 시도" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^saved:/));
    expect(finalizeCalls).toHaveLength(3);
    expect(finalizeCalls[1].init.body).toBeUndefined();
    expect(finalizeCalls[2].init.body).toBeInstanceOf(Blob);
    expect(finalizeCalls[2].url.split("?")[0]).toBe(finalizeCalls[0].url.split("?")[0]);
  });
});

let latestSession: ReturnType<typeof useRecorderSession> | null = null;

function SessionCapture() {
  latestSession = useRecorderSession();
  return null;
}

function getRecorderSession() {
  if (!latestSession) {
    throw new Error("session harness is not mounted");
  }
  return latestSession;
}
