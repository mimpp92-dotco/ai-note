// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DisclosureNavigationItem,
  LibraryDialogShell,
  LibraryDrawerShell,
} from "@/components/LibraryPrimitives";

describe("library client primitives", () => {
  it("dialog focuses cancel, closes on Escape, and returns focus to trigger", async () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    render(
      <LibraryDialogShell open title="워크스페이스 만들기" onClose={close} trigger={trigger}>
        <input aria-label="이름" />
      </LibraryDialogShell>,
    );
    const cancel = screen.getByRole("button", { name: "취소" });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("drawer has dialog semantics and closes from its labeled button", () => {
    const close = vi.fn();
    render(<LibraryDrawerShell open title="라이브러리" onClose={close}><p>내용</p></LibraryDrawerShell>);
    expect(screen.getByRole("dialog", { name: "라이브러리" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "라이브러리 닫기" }));
    expect(close).toHaveBeenCalled();
  });

  it("uses disclosure/list semantics without falsely declaring a full ARIA tree", () => {
    render(
      <ul>
        <DisclosureNavigationItem label="프로젝트">
          <a href="/?folder=f1">회의</a>
        </DisclosureNavigationItem>
      </ul>,
    );
    const disclosure = screen.getByRole("button", { name: "프로젝트" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "회의" })).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "회의" })).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });
});
