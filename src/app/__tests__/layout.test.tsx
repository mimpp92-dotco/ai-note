import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RootLayout from "@/app/layout";

vi.mock("@/components/LibraryProvider", () => ({
  LibraryProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/RecorderSessionProvider", () => ({
  RecorderSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/LibraryNavigation", () => ({
  LibraryNavigation: () => <nav aria-label="라이브러리" />,
}));

vi.mock("@/components/ChatPanel", () => ({
  ChatPanel: () => <aside aria-label="회의 도우미" />,
}));

describe("RootLayout responsive shell", () => {
  it("내비게이션의 데스크톱 breakpoint와 같은 lg에서만 가로 배치한다", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>본문</main>
      </RootLayout>,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const shell = document.getElementById("app-content")?.parentElement;

    expect(shell?.classList.contains("lg:flex-row")).toBe(true);
    expect(shell?.classList.contains("md:flex-row")).toBe(false);
  });

  it("does not hide horizontal layout regressions at the root shell", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>본문</main>
      </RootLayout>,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const shell = document.getElementById("app-content")?.parentElement;

    expect(shell?.classList.contains("overflow-x-hidden")).toBe(false);
  });

  it("does not render the chat panel while the meeting assistant is dormant", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>본문</main>
      </RootLayout>,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const shell = document.getElementById("app-content")?.parentElement;
    const children = shell ? [...shell.children] : [];

    const chatIndex = children.findIndex(
      (child) => child.getAttribute("aria-label") === "회의 도우미",
    );
    expect(chatIndex).toBe(-1);
    expect(children.at(-1)?.id).toBe("app-content");
  });

  it("keeps a single nav landmark and the skip -> nav -> main DOM order", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main id="main">본문</main>
      </RootLayout>,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");

    expect(document.querySelectorAll("nav").length).toBe(1);
    const skip = document.querySelector('a[href="#main"]');
    const nav = document.querySelector("nav");
    const content = document.getElementById("app-content");
    expect(skip).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(content).not.toBeNull();
    const following = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(skip!.compareDocumentPosition(nav!) & following).toBeTruthy();
    expect(nav!.compareDocumentPosition(content!) & following).toBeTruthy();
  });

  it("renders the chat panel as the last flex child when the flag is on", async () => {
    vi.resetModules();
    vi.doMock("@/lib/features", () => ({ MEETING_ASSISTANT_ENABLED: true }));
    try {
      const { default: FlaggedLayout } = await import("@/app/layout");
      const markup = renderToStaticMarkup(
        <FlaggedLayout>
          <main>본문</main>
        </FlaggedLayout>,
      );
      const document = new DOMParser().parseFromString(markup, "text/html");
      const shell = document.getElementById("app-content")?.parentElement;
      const children = shell ? [...shell.children] : [];

      expect(children.at(-1)?.getAttribute("aria-label")).toBe("회의 도우미");
      expect(children.at(-1)?.tagName).toBe("ASIDE");
    } finally {
      vi.doUnmock("@/lib/features");
      vi.resetModules();
    }
  });
});
