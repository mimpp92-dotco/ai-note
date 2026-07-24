import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/settings/page";
import { UserProfileForm } from "@/components/UserProfileForm";

const LOCAL_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const MISSING_PROFILE = {
  configured: false as const,
  defaults: { timezone: LOCAL_TIMEZONE, weekStartsOn: "monday" as const },
};

const CONFIGURED_PROFILE = {
  configured: true as const,
  profile: {
    schemaVersion: 1 as const,
    displayName: "Dylan",
    aliases: ["딜런"],
    timezone: LOCAL_TIMEZONE,
    weekStartsOn: "monday" as const,
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubProfile(options: {
  initial?: unknown;
  getMode?: "ok" | "non_ok" | "throw";
  saveMode?: "durable" | "pending" | "non_ok" | "throw";
  deferredSave?: Promise<Response>;
} = {}) {
  const {
    initial = MISSING_PROFILE,
    getMode = "ok",
    saveMode = "durable",
    deferredSave,
  } = options;
  const posted: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/llm") return response({ provider: null });
    if (url !== "/api/settings/profile") throw new Error(`unexpected URL: ${url}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      if (deferredSave) return deferredSave;
      if (saveMode === "throw") throw new Error("network");
      if (saveMode === "non_ok") return response({ error: { code: "internal_error" } }, 500);
      return response({
        configured: true,
        profile: body,
        durability: saveMode === "pending" ? "pending" : "durable",
      });
    }
    if (getMode === "throw") throw new Error("network");
    if (getMode === "non_ok") return response({ error: { code: "internal_error" } }, 500);
    return response(initial);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posted };
}

async function fillRequiredProfile(displayName = "Dylan") {
  fireEvent.change(await screen.findByRole("textbox", { name: "표시 이름" }), {
    target: { value: displayName },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("UserProfileForm", () => {
  it("renders one Settings main/page heading with the model before the optional profile", async () => {
    stubProfile();
    render(<SettingsPage />);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1, name: "설정" })).toHaveLength(1);
    const profileHeading = screen.getByRole("heading", { level: 2, name: "내 정보" });
    const modelHeading = screen.getByRole("heading", { level: 2, name: "요약 모델" });
    const profileSection = profileHeading.closest("section");
    const modelSection = modelHeading.closest("section");
    expect(profileSection).not.toBeNull();
    expect(modelSection).not.toBeNull();
    expect(profileSection).not.toBe(modelSection);
    expect(profileSection?.parentElement).toBe(modelSection?.parentElement);
    expect(
      modelSection!.compareDocumentPosition(profileSection!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/내 정보가 없어도 녹음·전사·일반 검색을 사용할 수 있습니다/))
      .toBeInTheDocument();
    await within(profileSection as HTMLElement).findByText(/아직 저장되지 않음/);
  });

  it("shows name and aliases first, with date settings in a closed native disclosure", async () => {
    stubProfile({ initial: CONFIGURED_PROFILE });
    render(<UserProfileForm />);

    const name = await screen.findByRole("textbox", { name: "표시 이름" });
    const aliases = screen.getByRole("textbox", { name: "별칭" });
    expect(name).toHaveValue("Dylan");
    expect(aliases).toHaveValue("딜런");
    expect(name).toHaveClass("w-full", "min-w-0");
    expect(aliases).toHaveClass("w-full", "min-w-0");
    expect(screen.getByText(/쉼표 또는 줄바꿈/)).toBeInTheDocument();

    const summary = screen.getByText("날짜 기준");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByRole("combobox", { name: "시간대 (IANA)" })).toHaveValue(LOCAL_TIMEZONE);
    expect(screen.getByRole("combobox", { name: "주 시작 요일" })).toHaveValue("monday");
  });

  it("keeps replacement save locked when initial loading fails", async () => {
    const { fetchMock } = stubProfile({ getMode: "non_ok" });
    render(<UserProfileForm />);

    expect(await screen.findByText(/내 정보를 불러오지 못했어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "내 정보 저장" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("normalizes comma/newline aliases and applies the server-confirmed profile", async () => {
    const { posted } = stubProfile();
    render(<UserProfileForm />);
    await fillRequiredProfile(" Dylan ");
    const aliases = await screen.findByRole("textbox", { name: "별칭" });
    fireEvent.change(aliases, { target: { value: " 딜런, Dylan\n딜런，  " } });
    fireEvent.click(screen.getByRole("button", { name: "내 정보 저장" }));

    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      schemaVersion: 1,
      displayName: "Dylan",
      aliases: ["딜런", "Dylan"],
      timezone: LOCAL_TIMEZONE,
      weekStartsOn: "monday",
    });
    expect(aliases).toHaveValue("딜런, Dylan");
    expect(screen.getByRole("button", { name: "내 정보 저장" })).toBeDisabled();
  });

  it.each(["non_ok", "throw"] as const)("preserves the draft when save is %s", async (saveMode) => {
    stubProfile({ initial: CONFIGURED_PROFILE, saveMode });
    render(<UserProfileForm />);
    const name = await screen.findByRole("textbox", { name: "표시 이름" });
    fireEvent.change(name, { target: { value: "작성 중 이름" } });
    fireEvent.click(screen.getByRole("button", { name: "내 정보 저장" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/저장하지 못했어요/);
    expect(name).toHaveValue("작성 중 이름");
    expect(screen.getByRole("button", { name: "내 정보 저장" })).toBeEnabled();
  });

  it("presents a missing profile as optional and labels the unsaved local timezone default", async () => {
    stubProfile();
    render(<UserProfileForm />);

    const heading = screen.getByRole("heading", { level: 2, name: "내 정보" });
    expect(heading.nextElementSibling).toHaveTextContent(/일반 검색과 질문에 필수 설정은 아닙니다/);
    expect(await screen.findByText(new RegExp(`브라우저 기준 기본 시간대.*${LOCAL_TIMEZONE}`)))
      .toHaveTextContent("아직 저장되지 않음");
    expect(screen.queryByText(/설정이 필요합니다/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("날짜 기준"));
    const timezone = screen.getByRole("combobox", { name: "시간대 (IANA)" });
    const listId = timezone.getAttribute("list");
    expect(listId).toBeTruthy();
    expect(document.querySelector(`#${listId} option[value="${LOCAL_TIMEZONE}"]`)).not.toBeNull();
  });

  it("treats pending durability as committed and does not restore a dirty draft", async () => {
    stubProfile({ saveMode: "pending" });
    render(<UserProfileForm />);
    await fillRequiredProfile();
    fireEvent.click(await screen.findByRole("button", { name: "내 정보 저장" }));

    expect(await screen.findByRole("status")).toHaveTextContent("저장됨 · 디스크 동기화 확인 대기");
    expect(screen.queryByText(/저장하지 못했어요|다시 저장/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "내 정보 저장" })).toBeDisabled();
  });

  it("keeps the date disclosure open for validation and blocks an invalid timezone", async () => {
    stubProfile({ initial: CONFIGURED_PROFILE });
    render(<UserProfileForm />);
    await screen.findByRole("textbox", { name: "표시 이름" });
    const summary = screen.getByText("날짜 기준");
    fireEvent.click(summary);
    const timezone = screen.getByRole("combobox", { name: "시간대 (IANA)" });
    timezone.focus();
    fireEvent.change(timezone, { target: { value: "Mars/Base" } });

    expect(timezone).toHaveFocus();
    expect(timezone).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/IANA 시간대 이름을 확인하세요/)).toBeInTheDocument();
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "내 정보 저장" })).toBeDisabled();
  });

  it("does not submit an active IME composition and exposes an explicit saving state", async () => {
    let resolveSave: ((value: Response) => void) | undefined;
    const deferredSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const { posted } = stubProfile({ deferredSave });
    render(<UserProfileForm />);
    const name = await screen.findByRole("textbox", { name: "표시 이름" });
    fireEvent.change(name, { target: { value: "딜런" } });
    fireEvent.compositionStart(name);
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    expect(posted).toHaveLength(0);

    fireEvent.compositionEnd(name);
    const save = screen.getByRole("button", { name: "내 정보 저장" });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(save).toHaveFocus();
    expect(save).toBeDisabled();
    expect(save.closest("form")).toHaveAttribute("aria-busy", "true");

    await act(async () => resolveSave?.(response({
      configured: true,
      profile: posted[0],
      durability: "durable",
    })));
    expect(await screen.findByText("저장됨")).toBeInTheDocument();
  });
});
