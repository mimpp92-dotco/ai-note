import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  normalizeUserProfile,
  type UserProfile,
} from "@/domain/userProfile";
import { atomicWriteFile } from "@/lib/atomicWrite";

export interface UserProfileDefaults {
  timezone: string;
  weekStartsOn: "monday";
}

export type UserProfileReadState =
  | { configured: false; defaults: UserProfileDefaults }
  | { configured: true; profile: UserProfile };

export type UserProfileWriteDurability = "durable" | "best_effort" | "pending";

export interface UserProfileWriteResult {
  profile: UserProfile;
  durability: UserProfileWriteDurability;
}

export function userProfilePath(): string {
  return join(process.cwd(), "data", "user-profile.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function localUserProfileDefaults(): UserProfileDefaults {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimezone(timezone)) {
      return { timezone, weekStartsOn: "monday" };
    }
  } catch {
    // UTC is the only fallback when the local runtime cannot identify a timezone.
  }
  return { timezone: "UTC", weekStartsOn: "monday" };
}

export async function readUserProfile(): Promise<UserProfileReadState> {
  let raw: string;
  try {
    raw = await readFile(userProfilePath(), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { configured: false, defaults: localUserProfileDefaults() };
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  return { configured: true, profile: normalizeUserProfile(parsed) };
}

export async function writeUserProfile(input: unknown): Promise<UserProfileWriteResult> {
  const profile = normalizeUserProfile(input);
  const commit = await atomicWriteFile(
    userProfilePath(),
    `${JSON.stringify(profile, null, 2)}\n`,
  );

  switch (commit.state) {
    case "committed_durable":
      return { profile, durability: "durable" };
    case "committed_best_effort":
      return { profile, durability: "best_effort" };
    case "committed_durability_pending":
      return { profile, durability: "pending" };
    case "not_committed":
      throw new Error("user_profile_not_committed");
  }
}
