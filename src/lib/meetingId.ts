// Meeting ids become path segments under data/meetings/, so they must never allow
// path traversal. Accept only UUIDs / safe slugs: a leading alphanumeric followed
// by alphanumerics, `-`, or `_`. This rejects `..`, `/`, `\`, absolute paths, and
// leading dots.

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_ID_LENGTH = 128;

export function isSafeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH &&
    SAFE_ID_RE.test(id)
  );
}

export function assertSafeId(id: unknown): string {
  if (!isSafeId(id)) {
    throw new Error(`Unsafe meeting id: ${JSON.stringify(id)}`);
  }
  return id;
}
