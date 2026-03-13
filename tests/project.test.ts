import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { scaffoldProject, createProjectDir } from "../src/project.js";
import type { ProjectConfig } from "../src/config.js";

describe("createProjectDir", () => {
  it("creates an empty temp directory with scuttlerun-project- prefix", async () => {
    const projectPath = await createProjectDir();
    try {
      expect(projectPath).toContain("scuttlerun-project-");
      const stat = await fs.stat(projectPath);
      expect(stat.isDirectory()).toBe(true);
      // Directory should be empty
      const contents = await fs.readdir(projectPath);
      expect(contents).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("scaffoldProject", () => {
  let tempDir: string;
  let skillDir: string;

  beforeEach(async () => {
    // Create a fake skill directory for symlink tests
    tempDir = await fs.mkdtemp(join(tmpdir(), "scuttlerun-project-test-"));
    skillDir = join(tempDir, "fake-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(join(skillDir, "SKILL.md"), "# Fake Skill");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates a temp directory with scuttlerun-project- prefix", async () => {
    const config: ProjectConfig = {};
    const result = await scaffoldProject(config, tempDir);
    try {
      expect(result.projectPath).toContain("scuttlerun-project-");
      const stat = await fs.stat(result.projectPath);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("writes CLAUDE.md when claude_md is provided", async () => {
    const config: ProjectConfig = { claude_md: "Use clear language." };
    const result = await scaffoldProject(config, tempDir);
    try {
      const content = await fs.readFile(
        join(result.projectPath, "CLAUDE.md"),
        "utf8",
      );
      expect(content).toBe("Use clear language.");
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("does not write CLAUDE.md when claude_md is absent", async () => {
    const config: ProjectConfig = {};
    const result = await scaffoldProject(config, tempDir);
    try {
      await expect(
        fs.access(join(result.projectPath, "CLAUDE.md")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("symlinks skill directories into .claude/skills/", async () => {
    const config: ProjectConfig = { skills: [skillDir] };
    const result = await scaffoldProject(config, tempDir);
    try {
      const linkPath = join(
        result.projectPath,
        ".claude",
        "skills",
        basename(skillDir),
      );
      const stat = await fs.lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await fs.readlink(linkPath);
      expect(target).toBe(skillDir);
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("writes settings.json when settings is provided", async () => {
    const config: ProjectConfig = { settings: { key: "value" } };
    const result = await scaffoldProject(config, tempDir);
    try {
      const content = await fs.readFile(
        join(result.projectPath, ".claude", "settings.json"),
        "utf8",
      );
      expect(JSON.parse(content)).toEqual({ key: "value" });
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("runs git init when git_init is true", async () => {
    const config: ProjectConfig = { git_init: true };
    const result = await scaffoldProject(config, tempDir);
    try {
      const stat = await fs.stat(join(result.projectPath, ".git"));
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("does not run git init when git_init is false", async () => {
    const config: ProjectConfig = { git_init: false };
    const result = await scaffoldProject(config, tempDir);
    try {
      await expect(
        fs.access(join(result.projectPath, ".git")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });
});
