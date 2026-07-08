import { SettingsForm } from "@/components/SettingsForm";

// Settings live behind app-api (force-dynamic routes) read via client fetch, so this
// page stays a static shell around the client form — it reads no data/ at build.
export default function SettingsPage() {
  return <SettingsForm />;
}
