import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_SUMMARY_PATCH_BYTES,
  SummaryEditor,
  TranscriptEditor,
} from "@/components/MeetingContentEditors";

const REVISION = {
  transcriptSha256: "a".repeat(64),
  summarySha256: "b".repeat(64),
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
  it("visible label과 UTF-8 byte 정보가 있는 단일 자유 본문 textarea만 표시한다", () => {
    render(
      <SummaryEditor
        id="m1"
        value={"요약\n첫 줄\n- 둘째 줄"}
        expectedRevision={REVISION}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        status={{ kind: "error", message: "저장하지 못했습니다." }}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "회의록 요약 본문" });
    expect(textarea).toHaveValue("요약\n첫 줄\n- 둘째 줄");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /추가|삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/한 줄 요약|액션 아이템 담당자|topicSlug|참석자/)).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("summary-editor-m1-status"),
    );
    expect(screen.getByText(/UTF-8.*bytes.*요청/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "회의록 요약 저장" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "수정 취소" })).toHaveClass("min-h-11");
  });

  it("CRLF만 LF로 정규화하고 heading 삭제·공백·내부 개행을 trim 없이 저장한다", () => {
    const save = vi.fn();
    render(
      <SummaryEditor
        id="m1"
        value={"삭제한 제목 뒤 공백  \r\n\r\n- 자유 본문\r단독 CR"}
        expectedRevision={REVISION}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 저장" }));
    expect(save).toHaveBeenCalledWith(
      "삭제한 제목 뒤 공백  \n\n- 자유 본문\r단독 CR",
    );
  });

  it("whitespace-only와 실제 serialized PATCH 512 KiB 초과를 draft/focus 보존 상태로 거부한다", () => {
    const save = vi.fn();
    const { rerender } = render(
      <SummaryEditor
        id="m1"
        value={" \r\n\t"}
        expectedRevision={REVISION}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 저장" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("회의록 요약 본문은 비워 둘 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "회의록 요약 본문" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "회의록 요약 본문" })).toHaveValue(" \n\t");

    const oversized = "가".repeat(174_750);
    expect(new TextEncoder().encode(JSON.stringify({
      expectedRevision: REVISION,
      body: oversized,
    })).byteLength).toBeGreaterThan(MAX_SUMMARY_PATCH_BYTES);
    rerender(
      <SummaryEditor
        id="m1"
        value={oversized}
        expectedRevision={REVISION}
        onChange={vi.fn()}
        onSave={save}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 저장" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/저장 요청은 UTF-8 기준 512 KiB 이하여야 합니다/)).toBeInTheDocument();
    expect(screen.getByText(/요청.*524,288 bytes/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "회의록 요약 본문" })).toHaveFocus();
  });
});
