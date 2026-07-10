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
});
