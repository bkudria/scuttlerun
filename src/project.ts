import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ScaffoldResult {
  projectPath: string;
}

export async function createProjectDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "scuttlerun-project-"));
}

export async function scaffoldProject(
  config: ProjectConfig,
  _configDir: string,
): Promise<ScaffoldResult> {
  const projectPath = await fs.mkdtemp(join(tmpdir(), "scuttlerun-project-"));

  // Write CLAUDE.md
  if (config.claude_md) {
    await fs.writeFile(join(projectPath, "CLAUDE.md"), config.claude_md);
  }

  // Symlink skills (validate all paths before creating anything)
  if (config.skills && config.skills.length > 0) {
    const resolvedSkills: Array<{ original: string; resolved: string }> = [];
    for (const skillPath of config.skills) {
      const resolved = resolveSkillPath(skillPath, _configDir);
      await validateSkillPath(skillPath, resolved);
      resolvedSkills.push({ original: skillPath, resolved });
    }

    const skillsDir = join(projectPath, ".claude", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    for (const { resolved } of resolvedSkills) {
      const name = basename(resolved);
      await fs.symlink(resolved, join(skillsDir, name));
    }
  }

  // Write settings.json
  if (config.settings) {
    const claudeDir = join(projectPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify(config.settings, null, 2),
    );
  }

  // Write project files
  if (config.files) {
    // Resolve the project path once via realpath (handles symlinks in tmpdir, e.g. macOS /tmp → /private/tmp)
    const realProjectPath = await fs.realpath(projectPath);
    for (const [filePath, content] of Object.entries(config.files)) {
      const fullPath = join(projectPath, filePath);
      // Use resolve() for the file path since it may not exist yet (realpath requires existence)
      const realFullPath = resolve(realProjectPath, filePath);
      if (
        !realFullPath.startsWith(realProjectPath + "/") &&
        realFullPath !== realProjectPath
      ) {
        throw new Error(`File path escapes project directory: "${filePath}"`);
      }
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
  }

  // Git init
  if (config.git_init) {
    await execFileAsync("git", ["init"], { cwd: projectPath });
  }

  return { projectPath };
}

async function validateSkillPath(
  originalPath: string,
  resolvedPath: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(
      `Skill path does not exist: "${originalPath}" (resolved to ${resolvedPath})`,
    );
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `Skill path is not a directory: "${originalPath}" (resolved to ${resolvedPath})`,
    );
  }

  try {
    await fs.access(join(resolvedPath, "SKILL.md"));
  } catch {
    throw new Error(
      `Skill directory is missing SKILL.md: "${originalPath}" (resolved to ${resolvedPath})`,
    );
  }
}

function resolveSkillPath(skillPath: string, configDir: string): string {
  // Expand tilde
  if (skillPath.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return join(home, skillPath.slice(2));
  }
  // Resolve relative paths from config file directory
  return resolve(configDir, skillPath);
}
