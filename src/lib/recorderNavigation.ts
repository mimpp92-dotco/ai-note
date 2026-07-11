const SCOPE_QUERY_KEYS = new Set([
  "workspace",
  "folder",
  "view",
  // Pre-activation/internal compatibility while Phase 13 switches the URL.
  "workspaceId",
  "folderId",
  "sourceWorkspace",
  "sourceView",
  "sourceFolder",
]);

function comparableEntries(url: URL): Array<[string, string]> {
  return [...url.searchParams.entries()]
    .filter(([key]) => !SCOPE_QUERY_KEYS.has(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey, "en") || leftValue.localeCompare(rightValue, "en")
    ));
}

export function isScopeOnlyNavigation(
  current: string,
  destination: string,
  base = "http://127.0.0.1:3000",
): boolean {
  try {
    const from = new URL(current, base);
    const to = new URL(destination, from);
    if (from.origin !== to.origin || from.pathname !== to.pathname) return false;
    return JSON.stringify(comparableEntries(from)) === JSON.stringify(comparableEntries(to));
  } catch {
    return false;
  }
}
