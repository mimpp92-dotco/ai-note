import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Tabs } from "@/components/Tabs";

const ITEMS = [
  { value: "script", label: "전체 스크립트", content: <p>스크립트 내용</p> },
  { value: "summary", label: "회의록 요약", content: <p>요약 내용</p> },
] as const;

function Harness({ onValueChange = vi.fn() }: { onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState<string>("script");
  return (
    <>
      <Tabs
        id="meeting-detail"
        ariaLabel="회의 내용"
        items={ITEMS}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValueChange(next);
        }}
      />
      <button type="button">다음 컨트롤</button>
    </>
  );
}

describe("Tabs", () => {
  it("connects the tablist, tabs, and selected panel with stable accessible ids", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "회의 내용" })).toBeInTheDocument();
    const script = screen.getByRole("tab", { name: "전체 스크립트" });
    const summary = screen.getByRole("tab", { name: "회의록 요약" });
    const panel = screen.getByRole("tabpanel");

    expect(script).toHaveAttribute("id", "meeting-detail-tab-0");
    expect(script).toHaveAttribute("aria-controls", "meeting-detail-panel-0");
    expect(script).toHaveAttribute("aria-selected", "true");
    expect(script).toHaveAttribute("tabindex", "0");
    expect(summary).toHaveAttribute("aria-selected", "false");
    expect(summary).toHaveAttribute("tabindex", "-1");
    expect(panel).toHaveAttribute("id", "meeting-detail-panel-0");
    expect(panel).toHaveAttribute("aria-labelledby", "meeting-detail-tab-0");
    expect(screen.getByText("스크립트 내용")).toBeInTheDocument();
    expect(screen.queryByText("요약 내용")).not.toBeInTheDocument();
  });

  it("automatically activates and focuses ArrowLeft/ArrowRight with wrap", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    const script = screen.getByRole("tab", { name: "전체 스크립트" });

    script.focus();
    fireEvent.keyDown(script, { key: "ArrowLeft" });
    const summary = screen.getByRole("tab", { name: "회의록 요약" });
    expect(summary).toHaveAttribute("aria-selected", "true");
    expect(summary).toHaveFocus();
    expect(screen.getByText("요약 내용")).toBeInTheDocument();

    fireEvent.keyDown(summary, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "전체 스크립트" })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith("script");
  });

  it("supports Home, End, and click selection while keeping focus on the selected tab", () => {
    render(<Harness />);
    const script = screen.getByRole("tab", { name: "전체 스크립트" });

    fireEvent.keyDown(script, { key: "End" });
    const summary = screen.getByRole("tab", { name: "회의록 요약" });
    expect(summary).toHaveFocus();

    fireEvent.keyDown(summary, { key: "Home" });
    expect(screen.getByRole("tab", { name: "전체 스크립트" })).toHaveFocus();

    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-selected", "true");
    expect(summary).toHaveFocus();
  });

  it("does not intercept Tab so the browser can leave the horizontal tab list", () => {
    render(<Harness />);
    const script = screen.getByRole("tab", { name: "전체 스크립트" });
    script.focus();

    expect(fireEvent.keyDown(script, { key: "Tab" })).toBe(true);
    expect(script).toHaveAttribute("aria-selected", "true");
  });
});
