import { describe, expect, it } from "vitest";

import type { LibraryDocument } from "@/domain/library";
import {
  resolveMeetingDetailSource,
  resolvePostMoveDetailSource,
} from "@/lib/detailSource";

const DEFAULT = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const FOLDER = "30000000-0000-4000-8000-000000000003";
const NOW = "2026-07-10T00:00:00.000Z";
const document: LibraryDocument = {
  schemaVersion: 1,
  libraryId: "90000000-0000-4000-8000-000000000009",
  revision: 1,
  defaultWorkspaceId: DEFAULT,
  workspaces: [
    { id: DEFAULT, name: "기본", order: 0, createdAt: NOW, updatedAt: NOW },
    { id: OTHER, name: "업무", order: 1, createdAt: NOW, updatedAt: NOW },
  ],
  folders: [{
    id: FOLDER,
    workspaceId: OTHER,
    parentFolderId: null,
    name: "프로젝트",
    color: "sage",
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  placements: [{ meetingId: "m1", workspaceId: OTHER, folderId: FOLDER }],
};

describe("structured meeting detail source", () => {
  it("preserves valid All/unfiled/folder source IDs", () => {
    expect(resolveMeetingDetailSource({
      meetingId: "m1",
      search: new URLSearchParams(`sourceWorkspace=${OTHER}&sourceView=folder&sourceFolder=${FOLDER}`),
      document,
      placements: document.placements,
    })).toMatchObject({
      source: { kind: "folder", workspaceId: OTHER, folderId: FOLDER },
      backHref: `/?workspace=${OTHER}&folder=${FOLDER}`,
      sourceAccepted: true,
    });
  });

  it("falls back to the current effective workspace All for invalid/cross-workspace source", () => {
    const result = resolveMeetingDetailSource({
      meetingId: "m1",
      search: new URLSearchParams(`sourceWorkspace=${DEFAULT}&sourceView=folder&sourceFolder=${FOLDER}`),
      document,
      placements: document.placements,
    });
    expect(result).toMatchObject({
      source: { kind: "workspace", workspaceId: OTHER },
      backHref: `/?workspace=${OTHER}`,
      canonicalDetailHref: `/meetings/m1?sourceWorkspace=${OTHER}&sourceView=all`,
      sourceAccepted: false,
    });
  });

  it("ignores raw return/open-redirect input and uses safe default All without placement", () => {
    const result = resolveMeetingDetailSource({
      meetingId: "unknown",
      search: new URLSearchParams("returnTo=https://evil.example/&sourceWorkspace=bad&sourceView=all"),
      document,
      placements: document.placements,
    });
    expect(result.backHref).toBe(`/?workspace=${DEFAULT}`);
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });
});

describe("post-move detail source", () => {
  it("keeps a valid workspace All source after a same-workspace folder move", () => {
    const result = resolvePostMoveDetailSource({
      meetingId: "m1",
      source: { kind: "workspace", workspaceId: OTHER },
      actual: { workspaceId: OTHER, folderId: FOLDER },
      attentionAfter: "opaque-attention",
    });
    expect(result.sourceChanged).toBe(false);
    expect(result.backHref).toBe(`/?workspace=${OTHER}`);
    expect(result.detailHref).toContain("sourceView=all");
    expect(result.detailHref).toContain("attentionAfter=opaque-attention");
  });

  it("switches filtered and cross-workspace sources to the exact actual destination", () => {
    const filtered = resolvePostMoveDetailSource({
      meetingId: "m1",
      source: { kind: "unfiled", workspaceId: OTHER },
      actual: { workspaceId: OTHER, folderId: FOLDER },
    });
    expect(filtered).toMatchObject({
      sourceChanged: true,
      source: { kind: "folder", workspaceId: OTHER, folderId: FOLDER },
      backHref: `/?workspace=${OTHER}&folder=${FOLDER}`,
    });
    expect(filtered.detailHref).toContain(`sourceFolder=${FOLDER}`);

    const crossWorkspace = resolvePostMoveDetailSource({
      meetingId: "m1",
      source: { kind: "workspace", workspaceId: OTHER },
      actual: { workspaceId: DEFAULT, folderId: null },
    });
    expect(crossWorkspace).toMatchObject({
      sourceChanged: true,
      source: { kind: "unfiled", workspaceId: DEFAULT },
      backHref: `/?workspace=${DEFAULT}&view=unfiled`,
    });
  });
});
