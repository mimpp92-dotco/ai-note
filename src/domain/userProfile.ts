import { z } from "zod";

const timezoneSchema = z.string().trim().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, "invalid IANA timezone");

export const userProfileSchema = z.object({
  schemaVersion: z.literal(1),
  displayName: z.string().trim().min(1),
  aliases: z.array(z.string()),
  timezone: timezoneSchema,
  weekStartsOn: z.enum(["monday", "sunday"]),
}).strict();

export type UserProfile = z.infer<typeof userProfileSchema>;
export type UserProfileState = { configured: false } | { configured: true; profile: UserProfile };

export function normalizeUserProfile(input: unknown): UserProfile {
  const parsed = userProfileSchema.parse(input);
  const aliases = [...new Set(parsed.aliases.map((alias) => alias.trim()).filter(Boolean))];
  return { ...parsed, aliases };
}

export function parseUserProfileState(input: unknown): UserProfileState {
  if (input === undefined) return { configured: false };
  return { configured: true, profile: normalizeUserProfile(input) };
}
