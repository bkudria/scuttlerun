import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PREFIX = "scuttlerun-project-";
const MS_PER_DAY = 86_400_000;

export const WORKSPACE_CLEANUP_AGE_DAYS = 7;

/**
 * Remove scuttlerun project directories older than maxAgeDays from $TMPDIR.
 * Best-effort: failures are silently ignored.
 * Returns count of directories removed.
 */
export async function cleanOldProjects(
  maxAgeDays: number,
  options: { verbose?: boolean } = {},
): Promise<number> {
  const tmp = tmpdir();
  const cutoff = Date.now() - maxAgeDays * MS_PER_DAY;
  let cleaned = 0;

  try {
    const entries = await readdir(tmp, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;

      const dirPath = join(tmp, entry.name);
      try {
        const info = await stat(dirPath);
        if (info.mtimeMs < cutoff) {
          await rm(dirPath, { recursive: true });
          cleaned++;
        }
      } catch (err) {
        if (options.verbose) {
          process.stderr.write(`[scuttlerun] Failed to clean ${entry.name}: ${String(err)}\n`);
        }
      }
    }
  } catch {
    // Ignore readdir errors (permission issues, etc.)
  }

  if (options.verbose && cleaned > 0) {
    process.stderr.write(`[scuttlerun] Cleaned ${cleaned} old project dir(s)\n`);
  }

  return cleaned;
}
