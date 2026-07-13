"use client";

import { useRef, useState } from "react";

import { AppDrawer } from "@/components/AppDialog";
import { ChatClient, useChatController } from "@/components/ChatClient";
import { CloseIcon } from "@/components/InlineIcons";
import { useGuardedRouter } from "@/components/RecorderNavigation";

// The chatbot lives in the app shell as a collapsible right-hand column (desktop)
// and a reused AppDrawer (mobile). The controller is hoisted here so the current
// conversation and draft survive collapse/expand; a browser refresh still starts
// fresh (the controller keeps state in React memory only, matching the tab policy).
export function ChatPanel() {
  const chat = useChatController();
  const router = useGuardedRouter();
  const [expanded, setExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  const goToSearch = () => {
    setMobileOpen(false);
    router.push("/search");
  };

  const view = (
    <ChatClient
      controller={chat}
      onSearchReplay={goToSearch}
      onSwitchToSearch={goToSearch}
    />
  );

  return (
    <>
      {expanded && (
        <aside
          aria-label="회의 도우미"
          className="hidden shrink-0 flex-col border-l border-line bg-chrome transition-opacity duration-300 motion-reduce:transition-none lg:flex lg:w-[380px]"
        >
          <div className="flex min-h-16 items-center justify-between border-b border-line px-4">
            <h2 className="text-[15px] font-bold text-ink">회의 도우미</h2>
            <button
              type="button"
              aria-label="회의 도우미 접기"
              onClick={() => setExpanded(false)}
              className="min-h-11 rounded-lg px-3 text-[13px] font-semibold text-accent hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              접기
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-24">{view}</div>
        </aside>
      )}

      {!expanded && (
        <button
          type="button"
          aria-label="회의 도우미 펼치기"
          onClick={() => setExpanded(true)}
          className="fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 rounded-l-lg border border-r-0 border-line bg-chrome px-2 py-4 text-[13px] font-semibold text-accent shadow-[0_8px_28px_-12px_rgba(42,36,32,.35)] transition-opacity duration-300 motion-reduce:transition-none hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:flex [writing-mode:vertical-rl]"
        >
          회의 도우미
        </button>
      )}

      <button
        ref={launcherRef}
        type="button"
        aria-label="회의 도우미 열기"
        onClick={() => setMobileOpen(true)}
        className="fixed bottom-4 left-4 z-40 flex min-h-11 items-center rounded-full border border-line bg-panel px-4 text-[13px] font-semibold text-accent shadow-[0_12px_36px_-14px_rgba(42,36,32,.35)] transition-opacity duration-300 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
      >
        회의 도우미
      </button>

      {mobileOpen && (
        <AppDrawer
          open
          title="회의 도우미"
          initialFocusRef={drawerCloseRef}
          returnFocus={launcherRef}
          onDismiss={() => setMobileOpen(false)}
          className="lg:hidden"
          panelClassName="flex w-[min(92vw,26rem)] flex-col border-l border-line bg-chrome shadow-xl"
        >
          {(dismiss) => (
            <>
              <div className="flex min-h-16 items-center justify-between border-b border-line px-4">
                <span className="text-[15px] font-bold text-ink">회의 도우미</span>
                <button
                  ref={drawerCloseRef}
                  type="button"
                  aria-label="회의 도우미 닫기"
                  onClick={() => dismiss("explicit_cancel")}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-inkFaint bg-panel text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <CloseIcon />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">{view}</div>
            </>
          )}
        </AppDrawer>
      )}
    </>
  );
}
