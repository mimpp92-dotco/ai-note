import { Suspense } from "react";

import { HomeClient } from "@/components/HomeClient";

// State comes from app-api (force-dynamic routes) via client polling, so this page
// reads no data/ at build — it stays a static shell around the client dashboard.
export default function HomePage() {
  return (
    <Suspense fallback={<main id="main" className="px-6 py-12 text-[14px] text-inkSoft">라이브러리를 불러오는 중…</main>}>
      <HomeClient />
    </Suspense>
  );
}
