// Home empty state: shown when no meetings exist yet. The recorder above is the
// "big record button"; this adds the guidance + the 3-step flow so a first user
// knows what happens (record → auto-transcribe → auto-summarize).
const STEPS = [
  { n: 1, text: "위 버튼으로 회의를 녹음합니다. 종료하면 자동으로 전사됩니다." },
  { n: 2, text: "요약 모델이 설정되어 있으면 회의록 요약이 자동으로 생성됩니다." },
  { n: 3, text: "완성된 회의록 요약을 상세 화면에서 확인합니다." },
];

export function EmptyState() {
  return (
    <div className="rounded-[16px] border border-line bg-panel px-6 py-8">
      <h2 className="text-[18px] font-bold text-ink">아직 회의록이 없습니다</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
        첫 회의를 녹음해보세요. 아래 3단계로 회의록이 만들어집니다.
      </p>
      <ol className="mt-5 space-y-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-soft font-mono text-[13px] font-semibold text-accent">
              {s.n}
            </span>
            <span className="text-[14px] leading-relaxed text-inkSoft">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
