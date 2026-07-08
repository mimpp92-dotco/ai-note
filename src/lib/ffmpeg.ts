import { copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// audio.webm → play.webm remux (`ffmpeg -c copy`, no re-encode). mlx-whisper also
// shells out to ffmpeg, so we preflight it here too. Env is read lazily inside
// functions (build-green). FAKE_FFMPEG=1 skips the binary and just copies bytes —
// mirrors FAKE_WHISPER so route tests stay hermetic (no ffmpeg install needed).

const execFileAsync = promisify(execFile);

// Cross-platform discovery. FFMPEG_PATH wins; then known install locations; then
// the bare name resolved via PATH at exec time (covers Windows `ffmpeg.exe`).
const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg", // macOS (Apple Silicon Homebrew)
  "/usr/local/bin/ffmpeg", // macOS (Intel Homebrew) / common *nix
  "/usr/bin/ffmpeg", // Debian/Ubuntu apt
];

const FFMPEG_NOT_FOUND =
  "ffmpeg not found. Set FFMPEG_PATH or install it — " +
  "macOS: `brew install ffmpeg` · Debian/Ubuntu: `apt install ffmpeg` · " +
  "Windows: `choco install ffmpeg` (or download from ffmpeg.org). " +
  "It is required to remux the recording.";

export function ffmpegPath(): string {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return "ffmpeg"; // relies on PATH at exec time
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
      // -c copy: container remux only, no re-encode. -y: overwrite the temp.
      try {
        await execFileAsync(bin, ["-y", "-i", audioPath, "-c", "copy", tmpPath]);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(FFMPEG_NOT_FOUND);
        }
        throw err;
      }
    }
    await rename(tmpPath, playPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
