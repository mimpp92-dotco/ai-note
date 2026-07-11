// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  useRef,
  useState,
} from "react";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AppDialog,
  AppDrawer,
  type AppDialogDismissReason,
} from "@/components/AppDialog";

function dispatchCancel(dialog: HTMLElement) {
  const event = new Event("cancel", { cancelable: true });
  fireEvent(dialog, event);
  return event;
}

function StableInputDialog({ revision }: { revision: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  return (
    <AppDialog
      open
      title="새 워크스페이스"
      initialFocusRef={inputRef}
      onDismiss={() => { void revision; }}
    >
      <input
        ref={inputRef}
        aria-label="워크스페이스 이름"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    </AppDialog>
  );
}

function DismissHarness({
  onDismiss,
}: {
  onDismiss: (reason: AppDialogDismissReason) => void;
}) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button">열기</button>
      <AppDialog
        open={open}
        title="확인"
        initialFocusRef={safeRef}
        returnFocus={triggerRef}
        onDismiss={(reason) => {
          onDismiss(reason);
          setOpen(false);
        }}
      >
        {(dismiss) => (
          <button ref={safeRef} type="button" onClick={() => dismiss("explicit_cancel")}>
            취소
          </button>
        )}
      </AppDialog>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

describe("AppDialog", () => {
  it("shows once, focuses the requested input, and preserves focus/value across callback rerenders", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const view = render(<StableInputDialog revision={0} />);
    const input = screen.getByRole("textbox", { name: "워크스페이스 이름" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "집중 유지" } });

    view.rerender(<StableInputDialog revision={1} />);
    view.rerender(<StableInputDialog revision={2} />);

    expect(input).toHaveValue("집중 유지");
    expect(input).toHaveFocus();
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["escape", "escape"],
    ["backdrop", "backdrop"],
    ["explicit cancel", "explicit_cancel"],
  ] as const)("returns focus after %s dismissal", async (action, expectedReason) => {
    const onDismiss = vi.fn();
    render(<DismissHarness onDismiss={onDismiss} />);
    const dialog = screen.getByRole("dialog", { name: "확인" });
    const cancel = screen.getByRole("button", { name: "취소" });
    await waitFor(() => expect(cancel).toHaveFocus());

    if (action === "escape") {
      const event = dispatchCancel(dialog);
      expect(event.defaultPrevented).toBe(true);
    } else if (action === "backdrop") {
      fireEvent.pointerDown(dialog);
      fireEvent.click(dialog);
    } else {
      fireEvent.click(cancel);
    }

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(expectedReason);
    await waitFor(() => expect(screen.getByRole("button", { name: "열기" })).toHaveFocus());
  });

  it("does not treat a panel press followed by an outside release as a backdrop dismissal", () => {
    const onDismiss = vi.fn();
    render(
      <AppDialog open title="드래그 확인" onDismiss={onDismiss}>
        <div data-testid="panel-content">내용</div>
      </AppDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "드래그 확인" });
    fireEvent.pointerDown(screen.getByTestId("panel-content"));
    fireEvent.click(dialog);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside the top dialog at both Tab boundaries", async () => {
    const firstRef = { current: null as HTMLButtonElement | null };
    render(
      <AppDialog
        open
        title="포커스 경계"
        initialFocusRef={firstRef}
        onDismiss={() => {}}
      >
        <button ref={(node) => { firstRef.current = node; }} type="button">첫 동작</button>
        <button type="button">마지막 동작</button>
      </AppDialog>,
    );
    const first = screen.getByRole("button", { name: "첫 동작" });
    const last = screen.getByRole("button", { name: "마지막 동작" });
    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("keeps a busy dialog open for Escape, backdrop, and explicit cancel", () => {
    const onDismiss = vi.fn();
    render(
      <AppDialog open title="저장 중" dismissible={false} onDismiss={onDismiss}>
        {(dismiss) => (
          <button type="button" onClick={() => dismiss("explicit_cancel")}>취소</button>
        )}
      </AppDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "저장 중" });
    dispatchCancel(dialog);
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
  });

  it("reference-counts body scroll lock across nested dialog and drawer", async () => {
    document.body.style.overflow = "clip";
    const view = render(
      <>
        <AppDialog open title="아래 dialog" onDismiss={() => {}}>아래</AppDialog>
        <AppDrawer open title="위 drawer" onDismiss={() => {}}>위</AppDrawer>
      </>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    view.rerender(
      <>
        <AppDialog open title="아래 dialog" onDismiss={() => {}}>아래</AppDialog>
        <AppDrawer open={false} title="위 drawer" onDismiss={() => {}}>위</AppDrawer>
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    view.rerender(
      <>
        <AppDialog open={false} title="아래 dialog" onDismiss={() => {}}>아래</AppDialog>
        <AppDrawer open={false} title="위 drawer" onDismiss={() => {}}>위</AppDrawer>
      </>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("clip"));
  });

  it("releases scroll lock on generation-style unmount without focusing a stale trigger", async () => {
    document.body.style.overflow = "auto";
    const trigger = document.createElement("button");
    trigger.textContent = "이전 세대 trigger";
    document.body.appendChild(trigger);
    const initialFocusRef = { current: null as HTMLButtonElement | null };
    const view = render(
      <AppDialog
        open
        title="이전 세대 dialog"
        initialFocusRef={initialFocusRef}
        returnFocus={trigger}
        onDismiss={() => {}}
      >
        <button ref={(node) => { initialFocusRef.current = node; }} type="button">안전 동작</button>
      </AppDialog>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    await waitFor(() => expect(screen.getByRole("button", { name: "안전 동작" })).toHaveFocus());

    view.unmount();

    await waitFor(() => expect(document.body.style.overflow).toBe("auto"));
    expect(trigger).not.toHaveFocus();
    trigger.remove();
  });
});
