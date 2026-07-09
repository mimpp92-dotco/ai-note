import { GlossaryClient } from "@/components/GlossaryClient";

// The glossary lives behind app-api (force-dynamic route) read via client fetch, so
// this page stays a static shell around the client editor — it reads no data at build.
export default function GlossaryPage() {
  return <GlossaryClient />;
}
