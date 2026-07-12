import { SettingsForm } from "@/components/SettingsForm";
import { UserProfileForm } from "@/components/UserProfileForm";

// Settings live behind app-api (force-dynamic routes) read via client fetch, so this
// page stays a static shell around the client form — it reads no data/ at build.
export default function SettingsPage() {
  return (
    <main id="main" className="max-w-2xl space-y-10 px-4 py-12 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">설정</h1>
        <p className="mt-2 break-words text-[15px] leading-relaxed text-inkSoft">
          개인화 기준과 회의록 요약에 사용할 로컬 모델을 관리합니다.
        </p>
      </div>
      <div className="min-w-0 space-y-10">
        <UserProfileForm />
        <SettingsForm embedded />
      </div>
    </main>
  );
}
