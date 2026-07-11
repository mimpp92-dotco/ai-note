import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const BASE_URL = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/u;
const SAFE_RESPONSE_CODES = new Set([
  "meeting_conflict",
  "meeting_not_found",
  "invalid_request",
  "no_summarize_candidate",
  "internal_error",
]);

export function normalizeAppBaseUrl(input) {
  const value = String(input).trim();
  const match = BASE_URL.exec(value);
  if (!match) throw new Error("unsafe_app_base_url");
  const portText = match[2];
  const port = Number(portText);
  if (
    (portText.length > 1 && portText.startsWith("0"))
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) throw new Error("unsafe_app_base_url");
  return `http://${match[1]}:${port}`;
}

function normalizeMeetingId(input) {
  const id = String(input ?? "").trim() || "latest";
  if (id !== "latest" && !SAFE_ID.test(id)) throw new Error("invalid_meeting_id");
  return id;
}

export async function triggerMeetingSummarize({
  id = "latest",
  baseUrl = process.env.AI_NOTE_BASE_URL ?? DEFAULT_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const normalizedBase = normalizeAppBaseUrl(baseUrl);
  const meetingId = normalizeMeetingId(id);
  let response;
  try {
    response = await fetchImpl(`${normalizedBase}/api/summarize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: normalizedBase,
      },
      body: JSON.stringify({ id: meetingId }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("app_unavailable");
  }
  if (response.status === 202) return { accepted: true };
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // A non-contract response is deliberately not printed or retained.
  }
  const candidate = payload?.error?.code;
  const code = typeof candidate === "string" && SAFE_RESPONSE_CODES.has(candidate)
    ? candidate
    : "request_failed";
  return { accepted: false, code };
}

async function main() {
  const id = process.argv[2] || "latest";
  try {
    const result = await triggerMeetingSummarize({ id });
    if (result.accepted) {
      console.log("요약 작업을 앱에 요청했습니다. 앱에서 진행 상태를 확인해 주세요.");
      return;
    }
    console.error(`요약 요청을 시작하지 못했습니다 (${result.code}). 앱 상태를 확인해 주세요.`);
    process.exitCode = 1;
  } catch (error) {
    const code = error instanceof Error ? error.message : "request_failed";
    const safeCode = ["unsafe_app_base_url", "invalid_meeting_id", "app_unavailable"].includes(code)
      ? code
      : "request_failed";
    console.error(`요약 요청을 시작하지 못했습니다 (${safeCode}). AI NOTE 앱과 AI_NOTE_BASE_URL을 확인해 주세요.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
