import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const SDK_TOOL_ALIASES: Record<string, string[]> = {
  FileRead: ["Read"],
  FileWrite: ["Write"],
  FileEdit: ["Edit"],
};

const SDK_TOOL_EXTRAS = ["Skill", "Task", "EnterPlanMode"];

let cached: Set<string> | null = null;

export function getKnownSdkToolNames(): Set<string> {
  if (cached) return cached;
  const names = new Set<string>();
  try {
    const require = createRequire(import.meta.url);
    const sdkMain = require.resolve("@anthropic-ai/claude-agent-sdk");
    const toolsDtsPath = join(dirname(sdkMain), "sdk-tools.d.ts");
    const src = readFileSync(toolsDtsPath, "utf8");
    const re = /^export interface (\w+)Input\s/gm;
    for (const match of src.matchAll(re)) {
      const base = match[1];
      names.add(base);
      const aliases = SDK_TOOL_ALIASES[base];
      if (aliases) for (const a of aliases) names.add(a);
    }
    for (const extra of SDK_TOOL_EXTRAS) names.add(extra);
  } catch {
    // SDK package not found or layout changed; degrade to empty set
  }
  cached = names;
  return names;
}

export function _resetCacheForTests(): void {
  cached = null;
}
