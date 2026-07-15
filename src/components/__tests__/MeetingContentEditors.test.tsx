import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SummaryEditor,
  TranscriptEditor,
  createSummaryEditorDraft,
  summaryDraftToEditable,
} from "@/components/MeetingContentEditors";
import type { EditableSummary } from "@/domain/summary";

const EDITABLE_SUMMARY: EditableSummary = {
  oneLine: "한 줄 요약",
  purpose: "회의 목적",
  highlights: ["첫 줄\n둘째 줄"],
  discussion: ["논의 내용"],
  decisions: ["결정 사항"],
  actionItems: [{ owner: "딜런", task: "초안 작성", due: "2026-07-20" }],
  risks: ["일정 위험"],
  followups: ["후속 회의"],
};

describe("TranscriptEditor", () => {
  it("현재 스크립트, UTF-8 byte 수, 44px 저장·취소 control을 제공한다", () => {
    render(
      <TranscriptEditor
        id="m1"
        value="한글"
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("한글");
    expect(screen.getByText("6 / 1,048,576 bytes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "전체 스크립트 저장" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "수정 취소" })).toHaveClass("min-h-11");
  });

  it("LF로 정규화해 저장하고 빈 값·1 MiB 초과는 draft를 유지한 채 textarea에 focus한다", () => {
    const save = vi.fn();
    const { rerender } = render(
      <TranscriptEditor
        id="m1"
        value={"수정한\r\n스크립트\r"}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));
    expect(save).toHaveBeenCalledWith("수정한\n스크립트\n");

    rerender(
      <TranscriptEditor
        id="m1"
        value="   "
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));
    expect(screen.getByText("전체 스크립트는 비워 둘 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveFocus();

    rerender(
      <TranscriptEditor
        id="m1"
        value={"가".repeat(349_526)}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));
    expect(screen.getByText("전체 스크립트는 UTF-8 기준 1 MiB 이하여야 합니다.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveFocus();
  });

  it("한국어 IME의 composing Enter와 keyCode 229를 form submit 전에 막는다", () => {
    render(
      <TranscriptEditor
        id="m1"
        value="수정 중"
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "전체 스크립트" });
    const composing = createEvent.keyDown(input, {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
      cancelable: true,
    });
    fireEvent(input, composing);
    expect(composing.defaultPrevented).toBe(true);
  });
});

describe("SummaryEditor", () => {
  it("내부 title/topicSlug/participants 없이 모든 사용자 편집 필드를 표시한다", () => {
    render(
      <SummaryEditor
        id="m1"
        draft={createSummaryEditorDraft(EDITABLE_SUMMARY)}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        status={{ kind: "error", message: "저장하지 못했습니다." }}
      />,
    );

    expect(screen.getByRole("textbox", { name: "한 줄 요약" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "목적" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "핵심 1" })).toHaveValue("첫 줄\n둘째 줄");
    expect(screen.getByRole("textbox", { name: "논의 내용 1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "결정 사항 1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "액션 아이템 1 담당자" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "액션 아이템 1 할 일" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "액션 아이템 1 기한" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "리스크 1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "후속 확인 1" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /제목|topicSlug|참석자/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "한 줄 요약" })).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("summary-editor-m1-status"),
    );
    expect(screen.getByRole("textbox", { name: "핵심 1" })).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("summary-editor-m1-status"),
    );
    expect(screen.getByRole("textbox", { name: "액션 아이템 1 담당자" })).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("summary-editor-m1-status"),
    );
  });

  it("문자열 목록을 item별 textarea로 추가·삭제해 내부 개행과 배열 순서를 보존한다", () => {
    const initial = createSummaryEditorDraft(EDITABLE_SUMMARY);
    let draft = initial;
    const change = vi.fn((next: typeof initial) => {
      draft = next;
    });
    const { rerender } = render(
      <SummaryEditor
        id="m1"
        draft={draft}
        onChange={change}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "핵심 추가" }));
    rerender(
      <SummaryEditor
        id="m1"
        draft={draft}
        onChange={change}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "핵심 2" }), {
      target: { value: "새 항목 첫 줄\n새 항목 둘째 줄" },
    });
    rerender(
      <SummaryEditor
        id="m1"
        draft={draft}
        onChange={change}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(summaryDraftToEditable(draft).highlights).toEqual([
      "첫 줄\n둘째 줄",
      "새 항목 첫 줄\n새 항목 둘째 줄",
    ]);
    expect(screen.getByRole("button", { name: "핵심 1 삭제" })).toHaveClass("min-h-11");
  });

  it("빈 목록 항목과 불완전한 action row는 저장하지 않고 첫 invalid field에 focus한다", () => {
    const invalid = createSummaryEditorDraft({
      ...EDITABLE_SUMMARY,
      highlights: [""],
      actionItems: [{ owner: "", task: "", due: "" }],
    });
    const save = vi.fn();
    render(
      <SummaryEditor
        id="m1"
        draft={invalid}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 저장" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "핵심 1" })).toHaveFocus();
    expect(screen.getByText("빈 목록 항목을 삭제하거나 내용을 입력하세요.")).toBeInTheDocument();
    expect(screen.getByText("담당자, 할 일, 기한을 모두 입력하세요.")).toBeInTheDocument();
  });
});
