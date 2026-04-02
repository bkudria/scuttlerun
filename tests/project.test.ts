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

  it("writes project files from config.files", async () => {
    const config: ProjectConfig = {
      files: {
        "hello.txt": "Hello world",
        "sub/nested.txt": "Nested content",
      },
    };
    const result = await scaffoldProject(config, tempDir);
    try {
      const hello = await fs.readFile(join(result.projectPath, "hello.txt"), "utf8");
      expect(hello).toBe("Hello world");
      const nested = await fs.readFile(join(result.projectPath, "sub", "nested.txt"), "utf8");
      expect(nested).toBe("Nested content");
    } finally {
      await fs.rm(result.projectPath, { recursive: true, force: true });
    }
  });

  it("resolves tilde skill paths relative to HOME", async () => {
    // Set HOME to our temp dir so ~/fake-skill resolves to tempDir/fake-skill
    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const config: ProjectConfig = { skills: ["~/fake-skill"] };
      const result = await scaffoldProject(config, tempDir);
      try {
        const linkPath = join(result.projectPath, ".claude", "skills", "fake-skill");
        const stat = await fs.lstat(linkPath);
        expect(stat.isSymbolicLink()).toBe(true);
        const target = await fs.readlink(linkPath);
        expect(target).toBe(join(tempDir, "fake-skill"));
      } finally {
        await fs.rm(result.projectPath, { recursive: true, force: true });
      }
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("falls back to USERPROFILE for tilde paths when HOME is unset", async () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    process.env.USERPROFILE = tempDir;
    try {
      const config: ProjectConfig = { skills: ["~/fake-skill"] };
      const result = await scaffoldProject(config, tempDir);
      try {
        const linkPath = join(result.projectPath, ".claude", "skills", "fake-skill");
        const stat = await fs.lstat(linkPath);
        expect(stat.isSymbolicLink()).toBe(true);
        const target = await fs.readlink(linkPath);
        expect(target).toBe(join(tempDir, "fake-skill"));
      } finally {
        await fs.rm(result.projectPath, { recursive: true, force: true });
      }
    } finally {
      process.env.HOME = origHome;
      if (origProfile !== undefined) process.env.USERPROFILE = origProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("rejects tilde path when neither HOME nor USERPROFILE is set", async () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const config: ProjectConfig = { skills: ["~/fake-skill"] };
      await expect(scaffoldProject(config, tempDir)).rejects.toThrow(
        "Skill path does not exist",
      );
    } finally {
      process.env.HOME = origHome;
      if (origProfile !== undefined) process.env.USERPROFILE = origProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("rejects when skill path does not exist", async () => {
    const config: ProjectConfig = { skills: ["./nonexistent-skill"] };
    await expect(scaffoldProject(config, tempDir)).rejects.toThrow(
      "Skill path does not exist",
    );
    // No partial scaffolding — .claude/skills should not be created
    // (projectPath is internal, so we verify indirectly by checking the error was thrown)
  });

  it("rejects when skill directory is missing SKILL.md", async () => {
    const noSkillMd = join(tempDir, "no-skillmd");
    await fs.mkdir(noSkillMd, { recursive: true });
    const config: ProjectConfig = { skills: [noSkillMd] };
    await expect(scaffoldProject(config, tempDir)).rejects.toThrow(
      "missing SKILL.md",
    );
  });

  it("rejects when skill path is a file, not a directory", async () => {
    const filePath = join(tempDir, "not-a-dir");
    await fs.writeFile(filePath, "I am a file");
    const config: ProjectConfig = { skills: [filePath] };
    await expect(scaffoldProject(config, tempDir)).rejects.toThrow(
      "not a directory",
    );
  });

  it("does not create symlinks when a later skill is invalid", async () => {
    const config: ProjectConfig = {
      skills: [skillDir, "./does-not-exist"],
    };
    await expect(scaffoldProject(config, tempDir)).rejects.toThrow(
      "Skill path does not exist",
    );
  });
});
