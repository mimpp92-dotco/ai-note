import type { Summary } from "@/domain/summary";

function textBlock(heading: string, value: string): string | null {
  return value.length === 0 ? null : `${heading}\n${value}`;
}

function listBlock(heading: string, values: string[]): string | null {
  return values.length === 0
    ? null
    : `${heading}\n${values.map((value) => `- ${value}`).join("\n")}`;
}

export function summaryBodyFromSummary(summary: Summary): string {
  if (summary.body !== undefined) return summary.body;

  const blocks: string[] = [];
  const overview = [
    ...(summary.oneLine.length === 0 ? [] : [summary.oneLine]),
    ...summary.highlights.map((highlight) => `- ${highlight}`),
  ];
  if (overview.length > 0) blocks.push(`요약\n${overview.join("\n")}`);

  const purpose = textBlock("목적", summary.purpose);
  if (purpose !== null) blocks.push(purpose);

  const discussion = listBlock("논의 내용", summary.discussion);
  if (discussion !== null) blocks.push(discussion);

  const decisions = listBlock("결정 사항", summary.decisions);
  if (decisions !== null) blocks.push(decisions);

  if (summary.actionItems.length > 0) {
    blocks.push([
      "액션 아이템",
      ...summary.actionItems.map(
        ({ owner, task, due }) => `- ${owner} — ${task} (기한: ${due})`,
      ),
    ].join("\n"));
  }

  const risks = listBlock("리스크", summary.risks);
  if (risks !== null) blocks.push(risks);

  const followups = listBlock("후속 확인", summary.followups);
  if (followups !== null) blocks.push(followups);

  return blocks.join("\n\n");
}

export function normalizeManualSummaryBody(input: string): string | null {
  const normalized = input.replace(/\r\n/gu, "\n");
  return normalized.trim().length === 0 ? null : normalized;
}
