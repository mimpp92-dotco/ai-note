"use client";

import { useState } from "react";

import { ChatClient, useChatController } from "@/components/ChatClient";
import { SearchPanel, useMeetingSearch } from "@/components/SearchOverlay";
import { Tabs } from "@/components/Tabs";
import type { ChatResponse } from "@/domain/chat";

type SearchTab = "question" | "search";

export function SearchClient() {
  const [tab, setTab] = useState<SearchTab>("question");
  const chat = useChatController();
  const search = useMeetingSearch();

  const replayFromChat = (replay: NonNullable<ChatResponse["searchReplay"]>) => {
    setTab("search");
    search.replay(replay);
  };

  return (
    <main id="main" className="w-full max-w-5xl space-y-7 px-4 py-12 sm:px-6">
      <header className="max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight text-ink">검색/질문</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
          여러 회의에 질문해 출처와 함께 답을 확인하거나, 회의를 직접 검색합니다.
        </p>
      </header>

      <Tabs<SearchTab>
        id="search-question-tabs"
        ariaLabel="회의 질문과 검색"
        value={tab}
        onValueChange={setTab}
        panelClassName="pt-6"
        items={[
          {
            value: "question",
            label: "질문",
            content: (
              <ChatClient
                controller={chat}
                onSearchReplay={replayFromChat}
                onSwitchToSearch={() => setTab("search")}
              />
            ),
          },
          { value: "search", label: "검색", content: <SearchPanel search={search} /> },
        ]}
      />
    </main>
  );
}
