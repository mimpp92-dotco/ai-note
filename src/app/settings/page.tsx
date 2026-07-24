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
          요약 모델을 먼저 준비하고 선택적인 내 정보를 관리합니다. 내 정보가 없어도 녹음·전사·일반 검색을 사용할 수 있습니다.
        </p>
      </div>
      <div className="min-w-0 space-y-10">
        <SettingsForm embedded />
        <UserProfileForm />
      </div>
    </main>
  );
}
