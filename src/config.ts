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
  files: z.record(z.string(), z.string()).optional(),
  git_init: z.boolean().default(false),
});

const UserConfigSchema = z.object({
  persona: z.string().optional(),
  oracle_model: z.string().default("claude-haiku-4-5"),
  max_turns: z.number().int().min(0).default(0),
});

const SandboxNetworkConfigSchema = z.object({
  allowed_domains: z.array(z.string()).default([]),
  allow_local_binding: z.boolean().default(false),
});

const SandboxFilesystemConfigSchema = z.object({
  deny_read: z
    .array(z.string())
    .default(["~/.ssh", "~/.aws", "~/.config/gcloud"]),
  allow_write: z.array(z.string()).default([]),
  deny_write: z.array(z.string()).default([".env"]),
});

const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  network: SandboxNetworkConfigSchema.optional(),
  filesystem: SandboxFilesystemConfigSchema.optional(),
});

const SettingSourceSchema = z.enum(["user", "project", "local"]);

const SystemPromptPresetSchema = z.object({
  preset: z.literal("claude_code"),
  append: z.string().optional(),
});

const SystemPromptSchema = z.union([z.string(), SystemPromptPresetSchema]);

// MCP Server Config schemas matching Agent SDK types (v0.2.72)
// .passthrough() allows unknown fields for forward compatibility
const McpStdioServerConfigSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();

const McpSSEServerConfigSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
}).passthrough();

const McpHttpServerConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
}).passthrough();

const McpSdkServerConfigSchema = z.object({
  type: z.literal("sdk"),
  name: z.string(),
}).passthrough();

// Union: try SSE/HTTP/SDK first (they require type), fall back to stdio (type optional)
const McpServerConfigSchema = z.union([
  McpSSEServerConfigSchema,
  McpHttpServerConfigSchema,
  McpSdkServerConfigSchema,
  McpStdioServerConfigSchema,
]);

const AgentMcpServerSpecSchema = z.union([
  z.string(),
  z.record(z.string(), McpServerConfigSchema),
]);

const AgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.enum(["sonnet", "opus", "haiku", "inherit"]).optional(),
  mcpServers: z.array(AgentMcpServerSpecSchema).optional(),
  criticalSystemReminder_EXPERIMENTAL: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).optional(),
}).passthrough();

const SdkConfigSchema = z.object({
  system_prompt: SystemPromptSchema.default({ preset: "claude_code" }),
  thinking: ThinkingConfigSchema.optional(),
  mcp_servers: z.record(z.string(), McpServerConfigSchema).optional(),
  agents: z.record(z.string(), AgentDefinitionSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  setting_sources: z.array(SettingSourceSchema).optional(),
});

// Top-level schema uses .optional() for nested objects — we re-parse
// them in parseSessionConfig to apply inner field defaults correctly.
// (Zod v4's .default({}) does not trigger inner defaults.)
const SessionConfigRawSchema = z.object({
  version: z.string().optional(),
  prompt: z.string(),
  model: z.string().default("claude-haiku-4-5"),
  max_turns: z.number().int().min(1).default(50),
  max_budget_usd: z.number().positive().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).default("high"),
  tools: z
    .array(z.string())
    .default(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion", "Skill"]),
  disallowed_tools: z.array(z.string()).optional(),
  project: ProjectConfigSchema.optional(),
  permission_mode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
    .default("bypassPermissions"),
  user: z.unknown().optional(),
  sdk: z.unknown().optional(),
  sandbox: z.unknown().optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type SystemPromptConfig = z.infer<typeof SystemPromptSchema>;
export type SdkConfig = z.infer<typeof SdkConfigSchema> & {
  setting_sources: z.infer<typeof SettingSourceSchema>[];
};
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type SandboxNetworkConfig = z.infer<typeof SandboxNetworkConfigSchema>;
export type SandboxFilesystemConfig = z.infer<
  typeof SandboxFilesystemConfigSchema
>;
export interface SandboxConfig {
  enabled: boolean;
  network: SandboxNetworkConfig;
  filesystem: SandboxFilesystemConfig;
}

export interface SessionConfig {
  version?: string;
  prompt: string;
  model: string;
  max_turns: number;
  max_budget_usd?: number;
  effort: "low" | "medium" | "high" | "max";
  tools: string[];
  disallowed_tools?: string[];
  project?: ProjectConfig;
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  user: UserConfig;
  sdk: SdkConfig;
  sandbox: SandboxConfig;
}

export function parseSessionConfig(raw: unknown): SessionConfig {
  const parsed = SessionConfigRawSchema.parse(raw);

  // Re-parse nested objects through their schemas to apply inner defaults
  const user = UserConfigSchema.parse(parsed.user ?? {});
  const sdkRaw = SdkConfigSchema.parse(parsed.sdk ?? {});
  const sandboxRaw = SandboxConfigSchema.parse(parsed.sandbox ?? {});
  const sandboxNetwork = SandboxNetworkConfigSchema.parse(
    sandboxRaw.network ?? {},
  );
  const sandboxFilesystem = SandboxFilesystemConfigSchema.parse(
    sandboxRaw.filesystem ?? {},
  );

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
    sandbox: {
      enabled: sandboxRaw.enabled,
      network: sandboxNetwork,
      filesystem: sandboxFilesystem,
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
