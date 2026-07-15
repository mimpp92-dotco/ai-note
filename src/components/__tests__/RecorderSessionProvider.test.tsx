// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GuardedLink, useGuardedRouter } from "@/components/RecorderNavigation";
import {
  type NavigationBlockerDescriptor,
  type NavigationBlockerPhase,
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
  return (
    <>
      <button onClick={(event) => router.push("/settings", event.currentTarget)}>프로그램 이동</button>
      <button onClick={(event) => router.replace("/glossary", event.currentTarget)}>프로그램 교체</button>
      <button onClick={(event) => router.back(event.currentTarget)}>프로그램 뒤로</button>
    </>
  );
}

const noContentDiscard = () => {};

function sameDetailPage(current: string, destination: string): boolean {
  if (destination === "history:back") return false;
  try {
    return new URL(current).pathname === new URL(destination, current).pathname;
  } catch {
    return false;
  }
}

function ContentNavigationBlocker({
  phase,
  label = "전체 스크립트 수정",
  onDiscard = noContentDiscard,
}: {
  phase: NavigationBlockerPhase;
  label?: NavigationBlockerDescriptor["label"];
  onDiscard?: () => void;
}) {
  const { registerNavigationBlocker, unregisterNavigationBlocker } = useRecorderSession();
  useEffect(() => {
    registerNavigationBlocker({
      id: "meeting-content-m1",
      kind: "meeting_content_edit",
      phase,
      label,
      discard: onDiscard,
      allowNavigation: sameDetailPage,
    });
    return () => unregisterNavigationBlocker("meeting-content-m1");
  }, [label, onDiscard, phase, registerNavigationBlocker, unregisterNavigationBlocker]);
  return null;
}

function App({
  full = true,
  blockerPhase = null,
  blockerLabel,
  onContentDiscard,
  strict = false,
}: {
  full?: boolean;
  blockerPhase?: NavigationBlockerPhase | null;
  blockerLabel?: NavigationBlockerDescriptor["label"];
  onContentDiscard?: () => void;
  strict?: boolean;
}) {
  const tree = (
    <RecorderSessionProvider>
      {full && <Recorder />}
      {blockerPhase && (
        <ContentNavigationBlocker
          phase={blockerPhase}
          label={blockerLabel}
          onDiscard={onContentDiscard}
        />
      )}
      <SessionCapture />
      <Probe />
      <GuardedLink href="/settings">설정으로</GuardedLink>
      <GuardedLink href="/?workspaceId=00000000-0000-4000-8000-000000000001">범위 이동</GuardedLink>
      <ProgrammaticNavigation />
    </RecorderSessionProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
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
    vi.useRealTimers();
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

  it("registers one idempotent dirty content blocker in Strict Mode and removes it on cleanup", async () => {
    const discard = vi.fn();
    const view = render(
      <App blockerPhase="dirty" onContentDiscard={discard} strict />,
    );
    const link = screen.getByRole("link", { name: "설정으로" });

    fireEvent.click(link);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog", { name: "수정 내용이 저장되지 않았습니다" }))
      .toHaveLength(1);
    dispatchNativeCancel(screen.getByRole("dialog"));
    await waitFor(() => expect(link).toHaveFocus());

    view.rerender(<App strict />);
    fireEvent.click(link);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });

  it("keeps a dirty content draft until explicit discard and returns cancel focus to the link", async () => {
    const discard = vi.fn();
    render(<App blockerPhase="dirty" onContentDiscard={discard} />);
    const link = screen.getByRole("link", { name: "설정으로" });

    fireEvent.click(link);
    const dialog = screen.getByRole("dialog", { name: "수정 내용이 저장되지 않았습니다" });
    expect(dialog).toHaveTextContent("전체 스크립트 수정");
    expect(dialog).toHaveTextContent("이동하면 사라집니다");
    const keep = screen.getByRole("button", { name: "계속 편집" });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(discard).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();

    dispatchNativeCancel(dialog);
    await waitFor(() => expect(link).toHaveFocus());
    fireEvent.click(link);
    fireEvent.click(await screen.findByRole("button", { name: "수정 내용 버리고 이동" }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledWith("/settings");
  });

  it.each([
    ["프로그램 이동", "push", "/settings"],
    ["프로그램 교체", "replace", "/glossary"],
    ["프로그램 뒤로", "back", undefined],
  ] as const)("guards %s with the same pending navigation", async (button, method, destination) => {
    const discard = vi.fn();
    render(<App blockerPhase="dirty" onContentDiscard={discard} />);

    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByRole("dialog", { name: "수정 내용이 저장되지 않았습니다" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리고 이동" }));

    expect(discard).toHaveBeenCalledTimes(1);
    if (destination === undefined) expect(navigation[method]).toHaveBeenCalledWith();
    else expect(navigation[method]).toHaveBeenCalledWith(destination);
  });

  it.each(["saving", "verifying"] as const)(
    "%s content cannot be discarded and commits its pending navigation after blocker removal",
    async (phase) => {
      const discard = vi.fn();
      const view = render(<App blockerPhase={phase} onContentDiscard={discard} />);
      fireEvent.click(screen.getByRole("link", { name: "설정으로" }));

      expect(screen.getByRole("dialog")).toHaveTextContent("저장 결과를 확인한 뒤 이동합니다");
      expect(screen.queryByRole("button", { name: /버리고 이동/ })).not.toBeInTheDocument();
      expect(discard).not.toHaveBeenCalled();
      expect(navigation.push).not.toHaveBeenCalled();

      view.rerender(<App />);
      await waitFor(() => expect(navigation.push).toHaveBeenCalledTimes(1));
      expect(navigation.push).toHaveBeenCalledWith("/settings");
      expect(discard).not.toHaveBeenCalled();
    },
  );

  it("changes a pending saving guard to dirty after failure without losing the draft", async () => {
    const discard = vi.fn();
    const view = render(<App blockerPhase="saving" onContentDiscard={discard} />);
    fireEvent.click(screen.getByRole("link", { name: "설정으로" }));
    expect(screen.queryByRole("button", { name: /버리고 이동/ })).not.toBeInTheDocument();

    view.rerender(<App blockerPhase="dirty" onContentDiscard={discard} />);
    expect(await screen.findByRole("button", { name: "수정 내용 버리고 이동" }))
      .toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리고 이동" }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledTimes(1);
  });

  it.each(["dirty", "saving", "verifying"] as const)(
    "adds beforeunload protection for %s content and removes it when pristine",
    (phase) => {
      const view = render(<App blockerPhase={phase} />);
      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
      view.rerender(<App />);
      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    },
  );

  it("combines unsaved audio and dirty content without discarding either before explicit confirmation", async () => {
    const discardContent = vi.fn();
    render(<App full={false} blockerPhase="dirty" onContentDiscard={discardContent} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/));

    fireEvent.click(screen.getByRole("link", { name: "설정으로" }));
    const dialog = screen.getByRole("dialog", { name: "녹음과 수정 내용이 저장되지 않았습니다" });
    expect(dialog).toHaveTextContent("녹음 원본");
    expect(dialog).toHaveTextContent("전체 스크립트 수정");
    expect(discardContent).not.toHaveBeenCalled();
    expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/);
    expect(navigation.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "계속 녹음" }));
    expect(discardContent).not.toHaveBeenCalled();
    expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/);
    fireEvent.click(screen.getByRole("link", { name: "설정으로" }));
    fireEvent.click(screen.getByRole("button", { name: "녹음과 수정 내용 버리고 이동" }));

    expect(discardContent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("session")).toHaveTextContent("idle:none");
    expect(navigation.push).toHaveBeenCalledTimes(1);
  });

  it("restores popstate URL for dirty content and consumes the destination once after confirmation", async () => {
    window.history.replaceState({}, "", "/meetings/m1");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const discard = vi.fn();
    render(<App blockerPhase="dirty" onContentDiscard={discard} />);

    window.history.pushState({}, "", "/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("dialog", { name: "수정 내용이 저장되지 않았습니다" }))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe("/meetings/m1");
    fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리고 이동" }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
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

  it("keeps the full-recorder timer and meter out of any live region and announces only the phase", async () => {
    vi.useFakeTimers();
    render(<App />);
    const session = getRecorderSession();
    await act(async () => session.start());

    const announce = screen.getByTestId("recorder-announce");
    expect(announce).toHaveAttribute("aria-live", "polite");
    expect(announce).toHaveTextContent("기록 시작");
    expect(announce.textContent).not.toMatch(/\d\d:\d\d/);
    const announcement = announce.textContent;

    const timer = screen.getByText("00:00");
    expect(timer.closest("[aria-live]")).toBeNull();
    const meter = screen.getByRole("meter", { name: "입력 레벨" });
    expect(meter.closest("[aria-live]")).toBeNull();

    act(() => vi.advanceTimersByTime(1_250));
    expect(screen.getByText("00:01")).toBeInTheDocument();
    expect(announce).toHaveTextContent(announcement!);
  });

  it("drops the compact aside live region but keeps its timer, action, and a dedicated phase status", async () => {
    render(<App full={false} />);
    const session = getRecorderSession();
    await act(async () => session.start());
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(/^recording:/));

    const aside = screen.getByRole("complementary", { name: "진행 중인 녹음" });
    expect(aside).not.toHaveAttribute("aria-live");

    const announce = screen.getByTestId("compact-recorder-announce");
    expect(announce).toHaveAttribute("aria-live", "polite");
    expect(announce).toHaveTextContent("기록 시작");
    expect(announce.textContent).not.toMatch(/\d\d:\d\d/);

    // The ticking visible label and the stop control stay in the tree, just not live.
    expect(within(aside).getByText(/기록 중 · \d\d:\d\d/)).toBeInTheDocument();
    expect(within(aside).getByRole("button", { name: "기록 중지" })).toBeInTheDocument();
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
