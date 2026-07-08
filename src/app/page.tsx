import { HomeClient } from "@/components/HomeClient";

// State comes from app-api (force-dynamic routes) via client polling, so this page
// reads no data/ at build — it stays a static shell around the client dashboard.
export default function HomePage() {
  return <HomeClient />;
}
