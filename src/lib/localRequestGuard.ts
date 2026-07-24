import {
  publicErrorResponse,
  type PublicErrorCode,
} from "@/lib/publicApi";

export const DATA_SURFACE_INVENTORY = [
  "/api/chat",
  "/api/glossary",
  "/api/folders",
  "/api/folders/[id]",
  "/api/folders/[id]/delete-preview",
  "/api/folders/[id]/parent",
  "/api/knowledge/reindex",
  "/api/library",
  "/api/library/rebuild",
  "/api/library/reveal",
  "/api/meetings",
  "/api/meetings/[id]",
  "/api/meetings/[id]/audio",
  "/api/meetings/[id]/content",
  "/api/meetings/[id]/export",
  "/api/meetings/[id]/finalize",
  "/api/meetings/[id]/location",
  "/api/meetings/[id]/reveal",
  "/api/meetings/[id]/review",
  "/api/meetings/[id]/summarize",
  "/api/meetings/[id]/summary",
  "/api/meetings/[id]/title",
  "/api/meetings/[id]/transcript",
  "/api/meetings/[id]/transcript/regenerate",
  "/api/organization-pending",
  "/api/settings/llm",
  "/api/settings/llm/health",
  "/api/settings/llm/models",
  "/api/settings/profile",
  "/api/search",
  "/api/summary-work",
  "/api/summarize",
  "/api/transcribe",
  "/api/whisper/health",
  "/api/workspaces",
  "/api/workspaces/[id]",
  "/api/workspaces/[id]/delete-preview",
  "/meetings/[id]",
] as const;

export type LocalRequestKind = "api" | "page";

export type LocalRequestValidation =
  | { ok: true }
  | { ok: false; code: PublicErrorCode; status: number };

interface ParsedHost {
  hostname: "127.0.0.1" | "localhost";
  port: string;
}

function parseRawHost(rawHost: string | null): ParsedHost | null {
  if (!rawHost || /[,\s@]/u.test(rawHost)) return null;
  const match = /^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/u.exec(rawHost);
  if (!match) return null;
  const port = match[2] ?? "";
  if (port) {
    if (port.length > 1 && port.startsWith("0")) return null;
    const numeric = Number(port);
    if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65_535) return null;
  }
  return { hostname: match[1] as ParsedHost["hostname"], port };
}

function reject(code: PublicErrorCode, status = 403): LocalRequestValidation {
  return { ok: false, code, status };
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function validateLocalRequest(
  request: Request,
  kind: LocalRequestKind,
): LocalRequestValidation {
  const url = new URL(request.url);
  const rawHost = request.headers.get("host") ?? url.host;
  const host = parseRawHost(rawHost);
  if (
    !host
    || url.protocol !== "http:"
    || url.username !== ""
    || url.password !== ""
    || url.hostname !== host.hostname
    || url.port !== host.port
  ) {
    return reject("invalid_host");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    const accepted = kind === "page"
      ? fetchSite === "same-origin" || fetchSite === "none"
      : fetchSite === "same-origin";
    if (!accepted) return reject("cross_site_request");
  }

  if (!isSafeMethod(request.method.toUpperCase())) {
    const rawOrigin = request.headers.get("origin");
    if (rawOrigin === null) return reject("missing_origin");
    if (rawOrigin === "null" || rawOrigin.includes(",")) return reject("invalid_origin");
    try {
      const origin = new URL(rawOrigin);
      if (
        rawOrigin !== origin.origin
        || origin.origin !== url.origin
        || origin.username !== ""
        || origin.password !== ""
      ) {
        return reject("invalid_origin");
      }
    } catch {
      return reject("invalid_origin");
    }
  }

  return { ok: true };
}

export function guardLocalApiRequest(request: Request): Response | null {
  const result = validateLocalRequest(request, "api");
  return result.ok ? null : publicErrorResponse(result.code, result.status);
}

export function validateLocalPageHeaders(headers: Headers): LocalRequestValidation {
  const host = headers.get("host");
  if (!host) return reject("invalid_host");
  return validateLocalRequest(new Request(`http://${host}/`, { headers }), "page");
}

export type RequestBodyErrorCode =
  | "unsupported_media_type"
  | "request_body_too_large"
  | "invalid_content_length"
  | "invalid_json";

export class RequestBodyError extends Error {
  readonly code: RequestBodyErrorCode;
  readonly status: number;

  constructor(code: RequestBodyErrorCode, status: number) {
    super(code);
    this.name = "RequestBodyError";
    this.code = code;
    this.status = status;
  }
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;

export async function parseBoundedJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new RequestBodyError("unsupported_media_type", 415);
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      throw new RequestBodyError("invalid_content_length", 400);
    }
    if (Number(declared) > maxBytes) {
      throw new RequestBodyError("request_body_too_large", 413);
    }
  }

  if (!request.body) throw new RequestBodyError("invalid_json", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RequestBodyError("request_body_too_large", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("invalid_json", 400);
  }
}

export function requestBodyErrorResponse(error: unknown): Response {
  if (error instanceof RequestBodyError) {
    return publicErrorResponse(error.code, error.status);
  }
  return publicErrorResponse("invalid_json", 400);
}
