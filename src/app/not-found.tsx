import Link from "next/link";

// Global 404 for unknown routes. Rendered inside the root layout (persistent
// sidebar + skip link), so it carries id="main" to keep the skip-to-content
// target valid (WCAG 2.4.1) — matching every other view's <main id="main">.
export default function NotFound() {
  return (
    <main id="main" className="max-w-5xl px-6 py-16">
      <h1 className="text-xl font-bold text-ink">페이지를 찾을 수 없습니다</h1>
      <Link href="/" className="mt-4 inline-block text-[14px] text-accent hover:underline">
        ← 홈으로
      </Link>
    </main>
  );
}
