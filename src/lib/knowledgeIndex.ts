import { createHash } from "node:crypto";

import type { MeetingStatus, StatusJson } from "@/domain/meeting";
import {
  corpusMapSchema,
  deriveMentionedPeople,
  knowledgeCardSchema,
  type CorpusMap,
  type KnowledgeCard,
} from "@/domain/knowledge";
import { summarySchema } from "@/domain/summarySchema";
import { assertSafeId } from "@/lib/meetingId";

export interface KnowledgeSourcePair {
  transcript: Uint8Array;
  summary: Uint8Array;
}

export interface KnowledgeSourceHashes {
  transcript: string;
  summary: string;
}

export interface BuildKnowledgeCardInput {
  meetingId: string;
  source: KnowledgeSourcePair;
  status: StatusJson;
}

const CORPUS_LIMITS = {
  oneLineCharacters: 500,
  purposeCharacters: 1_000,
  highlightCount: 8,
  highlightCharacters: 500,
  mentionedPeopleCount: 32,
  mentionedPersonCharacters: 100,
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function truncateCharacters(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(0, limit).join("");
}

function copyStrings(values: readonly string[]): string[] {
  return values.map((value) => value);
}

export function hashKnowledgeSourcePair(source: KnowledgeSourcePair): KnowledgeSourceHashes {
  return {
    transcript: sha256(source.transcript),
    summary: sha256(source.summary),
  };
}

export function buildKnowledgeCard(input: BuildKnowledgeCardInput): KnowledgeCard {
  const meetingId = assertSafeId(input.meetingId);
  if (input.status.id !== meetingId) throw new Error("knowledge_status_meeting_id_mismatch");
  const summary = summarySchema.parse(decodeJson(input.source.summary));
  const actionItems = summary.actionItems.map((item) => {
    const owner = item.owner.trim();
    const task = item.task.trim();
    const due = item.due.trim();
    return {
      owner,
      task,
      due,
      searchText: [owner, task, due].filter((value) => value !== "").join(" "),
    };
  });

  return knowledgeCardSchema.parse({
    schemaVersion: 1,
    meetingId,
    sourceHashes: hashKnowledgeSourcePair(input.source),
    content: {
      oneLine: summary.oneLine,
      purpose: summary.purpose,
      highlights: copyStrings(summary.highlights),
      discussion: copyStrings(summary.discussion),
      decisions: copyStrings(summary.decisions),
      risks: copyStrings(summary.risks),
      followups: copyStrings(summary.followups),
    },
    actionItems,
    reviewParticipants: copyStrings(input.status.review.participants),
    mentionedPeople: deriveMentionedPeople(actionItems),
  });
}

export function isKnowledgeCardStale(
  card: KnowledgeCard,
  current: KnowledgeSourceHashes,
): boolean {
  return card.sourceHashes.transcript !== current.transcript
    || card.sourceHashes.summary !== current.summary;
}

export function buildCorpusMap(cards: readonly KnowledgeCard[]): CorpusMap {
  const meetingIds = new Set<string>();
  const projections = [...cards]
    .sort((left, right) => left.meetingId.localeCompare(right.meetingId, "en"))
    .map((card) => {
      if (meetingIds.has(card.meetingId)) throw new Error("duplicate_knowledge_card");
      meetingIds.add(card.meetingId);
      return {
        meetingId: card.meetingId,
        oneLine: truncateCharacters(card.content.oneLine, CORPUS_LIMITS.oneLineCharacters),
        purpose: truncateCharacters(card.content.purpose, CORPUS_LIMITS.purposeCharacters),
        highlights: card.content.highlights
          .slice(0, CORPUS_LIMITS.highlightCount)
          .map((value) => truncateCharacters(value, CORPUS_LIMITS.highlightCharacters)),
        mentionedPeople: card.mentionedPeople
          .slice(0, CORPUS_LIMITS.mentionedPeopleCount)
          .map((value) => truncateCharacters(value, CORPUS_LIMITS.mentionedPersonCharacters)),
      };
    });
  return corpusMapSchema.parse({ schemaVersion: 1, cards: projections });
}

export interface LiveKnowledgeMetadata<Location> {
  title: string;
  status: MeetingStatus;
  location: Location;
  reviewParticipants: readonly string[];
}

export interface KnowledgeCardWithLiveMetadata<Location> {
  meetingId: string;
  sourceHashes: KnowledgeSourceHashes;
  content: KnowledgeCard["content"];
  actionItems: KnowledgeCard["actionItems"];
  mentionedPeople: string[];
  title: string;
  status: MeetingStatus;
  location: Location;
  reviewParticipants: string[];
}

export function projectKnowledgeCardWithLiveMetadata<Location>(
  card: KnowledgeCard,
  live: LiveKnowledgeMetadata<Location>,
): KnowledgeCardWithLiveMetadata<Location> {
  return {
    meetingId: card.meetingId,
    sourceHashes: { ...card.sourceHashes },
    content: {
      oneLine: card.content.oneLine,
      purpose: card.content.purpose,
      highlights: copyStrings(card.content.highlights),
      discussion: copyStrings(card.content.discussion),
      decisions: copyStrings(card.content.decisions),
      risks: copyStrings(card.content.risks),
      followups: copyStrings(card.content.followups),
    },
    actionItems: card.actionItems.map((item) => ({ ...item })),
    mentionedPeople: copyStrings(card.mentionedPeople),
    title: live.title,
    status: live.status,
    location: live.location,
    reviewParticipants: copyStrings(live.reviewParticipants),
  };
}
