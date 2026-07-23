import type { Summary } from "@/domain/summary";

// Render a summary as Markdown for copy / download / hand-off. Pure (no node
// imports) so it runs client-side too. Empty sections are omitted. `participants`
// comes from status.review (summary.participants is always [] by contract).

function section(heading: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `## ${heading}\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

export interface SummaryMarkdownOptions {
  summaryOutdated?: boolean;
}

const OUTDATED_SUMMARY_WARNING =
  "> ⚠️ 현재 스크립트 변경 후 회의록 요약이 갱신되지 않음";

export function formatSummaryMarkdown(
  summary: Summary,
  participants: string[] = [],
  options: SummaryMarkdownOptions = {},
): string {
  const parts: string[] = [`# ${summary.title}`];

  if (options.summaryOutdated === true) parts.push(OUTDATED_SUMMARY_WARNING);
  if (summary.body !== undefined) {
    if (participants.length) parts.push(`**참석자:** ${participants.join(", ")}`);
    parts.push(summary.body);
    const markdown = parts.join("\n\n");
    return summary.body.endsWith("\n") ? markdown : `${markdown}\n`;
  }
  if (summary.oneLine) parts.push(`> ${summary.oneLine}`);

  const meta: string[] = [];
  if (summary.purpose) meta.push(`**목적:** ${summary.purpose}`);
  if (participants.length) meta.push(`**참석자:** ${participants.join(", ")}`);
  if (meta.length) parts.push(meta.join("\n"));

  parts.push(section("핵심", summary.highlights));
  parts.push(section("논의", summary.discussion));
  parts.push(section("결정사항", summary.decisions));

  if (summary.actionItems.length) {
    const items = summary.actionItems.map(
      (a) => `- [ ] ${a.task} — ${a.owner} (${a.due})`,
    );
    parts.push(`## 액션 아이템\n${items.join("\n")}\n`);
  }

  parts.push(section("리스크", summary.risks));
  parts.push(section("후속", summary.followups));

  return parts.filter(Boolean).join("\n\n").trimEnd() + "\n";
}

// Combined meeting doc: the summary followed by the corrected transcript.
export function formatMeetingMarkdown(
  summary: Summary,
  transcript: string,
  participants: string[] = [],
  options: SummaryMarkdownOptions = {},
): string {
  return (
    formatSummaryMarkdown(summary, participants, options) +
    `\n## 전체 전사\n\n${transcript.trim()}\n`
  );
}
