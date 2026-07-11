// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { LibraryDialogShell } from "@/components/LibraryPrimitives";

describe("library client primitives", () => {
  it("dialog honors feature-owned initial focus, closes on Escape, and returns focus to trigger", async () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    const inputRef = createRef<HTMLInputElement>();
    document.body.appendChild(trigger);
    trigger.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <LibraryDialogShell
          open={open}
          title="워크스페이스 만들기"
          onClose={() => { close(); setOpen(false); }}
          trigger={trigger}
          initialFocusRef={inputRef}
        >
          <input ref={inputRef} aria-label="이름" />
        </LibraryDialogShell>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "이름" })).toHaveFocus());
    const dialog = screen.getByRole("dialog", { name: "워크스페이스 만들기" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});
