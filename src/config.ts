import { z } from "zod";

const ThinkingConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adaptive") }),
  z.object({
    type: z.literal("enabled"),
    budget_tokens: z.number().int().min(1024).optional(),
  }),
  z.object({ type: z.literal("disabled") }),
]);

const ProjectConfigSchema = z.object({
  claude_md: z.string().optional(),
  skills: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  git_init: z.boolean().default(false),
});

const UserConfigSchema = z.object({
  persona: z.string().optional(),
  oracle_model: z.string().default("claude-haiku-4-5"),
  turn_policy: z.enum(["reactive", "single"]).default("single"),
  max_user_turns: z.number().int().min(1).default(5),
});

const SettingSourceSchema = z.enum(["user", "project", "local"]);

const SdkConfigSchema = z.object({
  thinking: ThinkingConfigSchema.optional(),
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  setting_sources: z.array(SettingSourceSchema).optional(),
});

// Top-level schema uses .optional() for nested objects — we re-parse
// them in parseSessionConfig to apply inner field defaults correctly.
// (Zod v4's .default({}) does not trigger inner defaults.)
const SessionConfigRawSchema = z.object({
  version: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  max_turns: z.number().int().min(1).default(50),
  max_budget_usd: z.number().positive().optional(),
  system_prompt: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).default("high"),
  tools: z
    .array(z.string())
    .default(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion"]),
  disallowed_tools: z.array(z.string()).optional(),
  project: ProjectConfigSchema.optional(),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
    .default("bypassPermissions"),
  user: z.unknown().optional(),
  sdk: z.unknown().optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type SdkConfig = z.infer<typeof SdkConfigSchema> & {
  setting_sources: z.infer<typeof SettingSourceSchema>[];
};
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface SessionConfig {
  version?: string;
  prompt: string;
  model?: string;
  max_turns: number;
  max_budget_usd?: number;
  system_prompt?: string;
  effort: "low" | "medium" | "high" | "max";
  tools: string[];
  disallowed_tools?: string[];
  project?: ProjectConfig;
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  user: UserConfig;
  sdk: SdkConfig;
}

export function parseSessionConfig(raw: unknown): SessionConfig {
  const parsed = SessionConfigRawSchema.parse(raw);

  // Re-parse nested objects through their schemas to apply inner defaults
  const user = UserConfigSchema.parse(parsed.user ?? {});
  const sdkRaw = SdkConfigSchema.parse(parsed.sdk ?? {});

  // Auto-set setting_sources when project is present and not explicitly set
  let settingSources = sdkRaw.setting_sources;
  if (settingSources === undefined) {
    settingSources = parsed.project ? ["project"] : [];
  }

  return {
    version: parsed.version,
    prompt: parsed.prompt,
    model: parsed.model,
    max_turns: parsed.max_turns,
    max_budget_usd: parsed.max_budget_usd,
    system_prompt: parsed.system_prompt,
    effort: parsed.effort,
    tools: parsed.tools,
    disallowed_tools: parsed.disallowed_tools,
    project: parsed.project,
    permission_mode: parsed.permission_mode,
    user,
    sdk: {
      ...sdkRaw,
      setting_sources: settingSources,
    },
  };
}

/**
 * Merge raw config objects before applying defaults via parseSessionConfig.
 * Deep-merges objects, replaces arrays and scalars.
 */
export function mergeRawConfigs(
  ...raws: Record<string, unknown>[]
): Record<string, unknown> {
  if (raws.length === 0) throw new Error("At least one config is required");
  return raws.reduce((acc, override) =>
    deepMergeObjects(acc, override),
  );
}

export function mergeConfigs(...configs: SessionConfig[]): SessionConfig {
  if (configs.length === 0) {
    throw new Error("At least one config is required");
  }
  if (configs.length === 1) {
    return configs[0];
  }

  return configs.reduce((acc, override) => deepMerge(acc, override));
}

function deepMerge(base: SessionConfig, override: SessionConfig): SessionConfig {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const baseValue = (base as unknown as Record<string, unknown>)[key];

    if (Array.isArray(value)) {
      result[key] = value;
    } else if (
      value !== null &&
      typeof value === "object" &&
      baseValue !== null &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result as unknown as SessionConfig;
}

function deepMergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const baseValue = base[key];

    if (Array.isArray(value)) {
      result[key] = value;
    } else if (
      value !== null &&
      typeof value === "object" &&
      baseValue !== null &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
