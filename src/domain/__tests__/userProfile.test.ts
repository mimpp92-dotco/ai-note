import { describe, expect, it } from "vitest";

import { normalizeUserProfile, parseUserProfileState } from "@/domain/userProfile";

describe("user profile contract", () => {
  it("normalizes empty and duplicate aliases while preserving displayName separately", () => {
    expect(normalizeUserProfile({
      schemaVersion: 1,
      displayName: " Dylan ",
      aliases: [" 딜런 ", "", "딜런", "D"],
      timezone: "Asia/Seoul",
      weekStartsOn: "monday",
    })).toEqual({
      schemaVersion: 1,
      displayName: "Dylan",
      aliases: ["딜런", "D"],
      timezone: "Asia/Seoul",
      weekStartsOn: "monday",
    });
  });

  it("does not implicitly add displayName to aliases", () => {
    expect(normalizeUserProfile({
      schemaVersion: 1,
      displayName: "Dylan",
      aliases: ["딜런"],
      timezone: "Asia/Seoul",
      weekStartsOn: "sunday",
    }).aliases).toEqual(["딜런"]);
  });

  it("rejects invalid timezone and weekStartsOn", () => {
    expect(() => normalizeUserProfile({ schemaVersion: 1, displayName: "D", aliases: [], timezone: "Mars/Base", weekStartsOn: "monday" })).toThrow();
    expect(() => normalizeUserProfile({ schemaVersion: 1, displayName: "D", aliases: [], timezone: "UTC", weekStartsOn: "friday" })).toThrow();
  });

  it("distinguishes a missing profile from an invalid configured profile", () => {
    expect(parseUserProfileState(undefined)).toEqual({ configured: false });
    expect(() => parseUserProfileState({ schemaVersion: 1 })).toThrow();
  });
});
