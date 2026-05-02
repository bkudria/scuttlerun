import { describe, it, expect } from "vitest";
import { buildSandboxEnv, SAFE_ENV_VARS, SAFE_ENV_PREFIXES } from "../src/runner.js";

describe("buildSandboxEnv", () => {
  it("includes safe individual vars", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp", SHELL: "/bin/zsh" },
      undefined,
      "/sandbox/home",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.SHELL).toBe("/bin/zsh");
  });

  it("includes safe prefix vars", () => {
    const env = buildSandboxEnv(
      { npm_config_registry: "https://registry.npmjs.org", LC_CTYPE: "UTF-8" },
      undefined,
      "/sandbox/home",
    );
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org");
    expect(env.LC_CTYPE).toBe("UTF-8");
  });

  it("excludes dangerous vars", () => {
    const env = buildSandboxEnv(
      {
        PATH: "/usr/bin",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "ghp_fake",
        NPM_TOKEN: "npm_fake",
        SSH_AUTH_SOCK: "/tmp/ssh-agent",
        GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
        DATABASE_URL: "postgres://user:pass@host/db",
      },
      undefined,
      "/sandbox/home",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("always includes ANTHROPIC_API_KEY", () => {
    const env = buildSandboxEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }, undefined, "/sandbox/home");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("excludes other ANTHROPIC_ vars", () => {
    const env = buildSandboxEnv(
      { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_ADMIN_KEY: "admin-secret" },
      undefined,
      "/sandbox/home",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_ADMIN_KEY).toBeUndefined();
  });

  it("merges user env on top", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin" },
      { CUSTOM_VAR: "custom", PATH: "/custom/bin" },
      "/sandbox/home",
    );
    expect(env.CUSTOM_VAR).toBe("custom");
    expect(env.PATH).toBe("/custom/bin");
  });

  it("always forces HOME to sandboxHome", () => {
    const env = buildSandboxEnv(
      { HOME: "/original/home" },
      { HOME: "/user/override" },
      "/sandbox/home",
    );
    expect(env.HOME).toBe("/sandbox/home");
  });

  it("strips undefined values", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", LANG: undefined } as Record<string, string | undefined>,
      undefined,
      "/sandbox/home",
    );
    expect("LANG" in env).toBe(false);
  });

  it("returns only HOME for empty inputs", () => {
    const env = buildSandboxEnv({}, undefined, "/sandbox/home");
    expect(env).toEqual({ HOME: "/sandbox/home" });
  });

  it("SAFE_ENV_VARS includes ANTHROPIC_API_KEY", () => {
    expect(SAFE_ENV_VARS.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("SAFE_ENV_PREFIXES includes LC_", () => {
    expect(SAFE_ENV_PREFIXES).toContain("LC_");
  });
});
