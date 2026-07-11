import { describe, expect, it } from "vitest";

import {
  AUDIO_MIME_CANDIDATES,
  formatDuration,
  pickAudioMime,
  recorderPhaseAnnouncement,
  rms,
} from "@/lib/recorder";

describe("pickAudioMime", () => {
  it("prefers webm/opus when supported", () => {
    expect(pickAudioMime(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to audio/webm when the opus profile is unsupported", () => {
    expect(pickAudioMime((m) => m === "audio/webm")).toBe("audio/webm");
  });

  it("falls back to audio/mp4 on Safari (no webm)", () => {
    const safari = (m: string) => m === "audio/mp4" || m.startsWith("audio/ogg");
    expect(pickAudioMime(safari)).toBe("audio/mp4");
  });

  it("returns an empty string when nothing is supported", () => {
    expect(pickAudioMime(() => false)).toBe("");
  });

  it("only offers webm/mp4/ogg family candidates", () => {
    expect(AUDIO_MIME_CANDIDATES.every((m) => /^audio\/(webm|mp4|ogg)/.test(m))).toBe(true);
  });
});

describe("rms", () => {
  it("is 0 for silence", () => {
    expect(rms(new Float32Array(1024))).toBe(0);
  });

  it("is 0 for an empty buffer", () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("equals the amplitude of a constant signal", () => {
    expect(rms([0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 10);
  });

  it("computes sqrt(mean(square))", () => {
    expect(rms([-1, 1])).toBeCloseTo(1, 10);
    expect(rms([3, 4])).toBeCloseTo(Math.sqrt(12.5), 10);
  });
});

describe("formatDuration", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(5000)).toBe("00:05");
    expect(formatDuration(65000)).toBe("01:05");
    expect(formatDuration(600000)).toBe("10:00");
  });

  it("does not cap minutes at 60", () => {
    expect(formatDuration(75 * 60 * 1000)).toBe("75:00");
  });

  it("clamps negatives and NaN to 00:00", () => {
    expect(formatDuration(-1000)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });
});

describe("recorderPhaseAnnouncement", () => {
  it("maps each lifecycle phase to a short, phase-only label", () => {
    expect(recorderPhaseAnnouncement("requesting_permission")).toBe("권한 확인");
    expect(recorderPhaseAnnouncement("recording")).toBe("기록 시작");
    expect(recorderPhaseAnnouncement("stopping")).toBe("정리");
    expect(recorderPhaseAnnouncement("captured")).toBe("정리");
    expect(recorderPhaseAnnouncement("uploading")).toBe("저장");
    expect(recorderPhaseAnnouncement("saved")).toBe("저장 완료");
    expect(recorderPhaseAnnouncement("finalize_ambiguous")).toBe("저장 상태 확인 필요");
    expect(recorderPhaseAnnouncement("failed")).toBe("실패");
  });

  it("is empty for idle so nothing is announced at rest", () => {
    expect(recorderPhaseAnnouncement("idle")).toBe("");
  });

  it("never carries the ticking mm:ss timer into the announcement", () => {
    for (const phase of [
      "requesting_permission",
      "recording",
      "stopping",
      "captured",
      "uploading",
      "saved",
      "finalize_ambiguous",
      "failed",
    ]) {
      expect(recorderPhaseAnnouncement(phase)).not.toMatch(/\d\d:\d\d/);
    }
  });
});
