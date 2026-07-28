// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GENERATED_SUMMARY_JSON_SCHEMA } from "@/domain/generatedSummaryJsonSchema";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  maxItems?: number;
};

function accepts(schema: JsonSchema, value: unknown): boolean {
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "array") {
    return Array.isArray(value)
      && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && value.every((item) => schema.items === undefined || accepts(schema.items, item));
  }
  if (schema.type !== "object") return false;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  if (schema.required?.some((key) => !(key in record))) return false;
  if (
    schema.additionalProperties === false
    && Object.keys(record).some((key) => !(key in properties))
  ) return false;
  return Object.entries(record).every(([key, field]) => (
    properties[key] === undefined || accepts(properties[key], field)
  ));
}

const GENERATED = {
  title: "회의 제목",
  topicSlug: "meeting-topic",
  oneLine: "한 줄 요약",
  purpose: "회의 목적",
  participants: [],
  highlights: ["핵심"],
  discussion: ["논의"],
  decisions: ["결정"],
  actionItems: [{ owner: "TODO", task: "후속 작업", due: "미정" }],
  risks: [],
  followups: [],
};

describe("GENERATED_SUMMARY_JSON_SCHEMA", () => {
  it("accepts the complete generated structured shape", () => {
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, GENERATED)).toBe(true);
    expect(GENERATED_SUMMARY_JSON_SCHEMA.type).toBe("object");
    expect(GENERATED_SUMMARY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(GENERATED_SUMMARY_JSON_SCHEMA.required).toEqual(Object.keys(GENERATED));
  });

  it.each(Object.keys(GENERATED))("requires %s", (field) => {
    const candidate = Object.fromEntries(
      Object.entries(GENERATED).filter(([key]) => key !== field),
    );
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, candidate)).toBe(false);
  });

  it("rejects wrong field types and additional properties at every object boundary", () => {
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      title: 42,
    })).toBe(false);
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      unknown: "not allowed",
    })).toBe(false);
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      actionItems: [{ ...GENERATED.actionItems[0], extra: "not allowed" }],
    })).toBe(false);
  });

  it("does not allow manual body or status-owned metadata in generated output", () => {
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      body: "수동 편집 본문",
    })).toBe(false);
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      titleOverride: "사용자 제목",
    })).toBe(false);
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      review: { participants: ["사용자 검토 참석자"] },
    })).toBe(false);
  });

  it("requires the model participant field to stay empty because status.review owns attendees", () => {
    expect(accepts(GENERATED_SUMMARY_JSON_SCHEMA, {
      ...GENERATED,
      participants: ["모델이 추정한 참석자"],
    })).toBe(false);
    expect(GENERATED_SUMMARY_JSON_SCHEMA.properties.participants).toMatchObject({
      type: "array",
      maxItems: 0,
    });
  });
});
