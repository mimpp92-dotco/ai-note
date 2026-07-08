import { copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// audio.webm → play.webm remux (`ffmpeg -c copy`, no re-encode). mlx-whisper also
// shells out to ffmpeg, so we preflight it here too. Env is read lazily inside
// functions (build-green). FAKE_FFMPEG=1 skips the binary and just copies bytes —
// mirrors FAKE_WHISPER so route tests stay hermetic (no ffmpeg install needed).

const execFileAsync = promisify(execFile);
const FFMPEG_FALLBACK = "/opt/homebrew/bin/ffmpeg";

export function ffmpegPath(): string | null {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(FFMPEG_FALLBACK)) return FFMPEG_FALLBACK;
  return null;
}

export async function remuxToPlay(audioPath: string, playPath: string): Promise<void> {
  // Atomic: build at a temp path (kept .webm so ffmpeg's muxer detection works),
  // then rename over playPath so a crash never leaves a partial play.webm.
  const tmpPath = `${playPath}.${process.pid}.tmp.webm`;
  try {
    if (process.env.FAKE_FFMPEG === "1") {
      await copyFile(audioPath, tmpPath);
    } else {
      const bin = ffmpegPath();
      if (!bin) {
        throw new Error(
          "ffmpeg not found. Install it (`brew install ffmpeg`) — it is required to remux the recording.",
        );
      }
      // -c copy: container remux only, no re-encode. -y: overwrite the temp.
      await execFileAsync(bin, ["-y", "-i", audioPath, "-c", "copy", tmpPath]);
    }
    await rename(tmpPath, playPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
