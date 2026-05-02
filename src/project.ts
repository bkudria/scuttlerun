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
  // Validate every input before any filesystem mutation. A failure
  // here rejects the whole scaffold and leaves no workspace behind.
  const resolvedSkills = await validateSkills(config.skills, _configDir);
  validateFilePaths(config.files);

  const projectPath = await fs.mkdtemp(join(tmpdir(), "scuttlerun-project-"));

  if (config.claude_md) {
    await fs.writeFile(join(projectPath, "CLAUDE.md"), config.claude_md);
  }

  if (resolvedSkills.length > 0) {
    const skillsDir = join(projectPath, ".claude", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    for (const { resolved } of resolvedSkills) {
      await fs.symlink(resolved, join(skillsDir, basename(resolved)));
    }
  }

  if (config.settings) {
    const claudeDir = join(projectPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(join(claudeDir, "settings.json"), JSON.stringify(config.settings, null, 2));
  }

  // Git init before file writes so that files cannot create malicious .git/hooks/
  if (config.git_init) {
    await execFileAsync("git", ["init"], { cwd: projectPath });
  }

  if (config.files) {
    for (const [filePath, content] of Object.entries(config.files)) {
      const fullPath = join(projectPath, filePath);
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
  }

  return { projectPath };
}

async function validateSkills(
  skills: string[] | undefined,
  configDir: string,
): Promise<Array<{ original: string; resolved: string }>> {
  if (!skills || skills.length === 0) return [];
  const resolved: Array<{ original: string; resolved: string }> = [];
  for (const skillPath of skills) {
    const resolvedPath = resolveSkillPath(skillPath, configDir);
    await validateSkillPath(skillPath, resolvedPath);
    resolved.push({ original: skillPath, resolved: resolvedPath });
  }
  return resolved;
}

// Synthetic absolute base used to detect path traversal without
// depending on the project directory existing yet. Any prefix-comparable
// absolute path works; pick something unlikely to collide with real
// content.
const VALIDATION_BASE = "/__scuttlerun_validation__";

function validateFilePaths(files: Record<string, string> | undefined): void {
  if (!files) return;
  for (const filePath of Object.keys(files)) {
    if (filePath === ".git" || filePath.startsWith(".git/")) {
      throw new Error(`File path targets .git/ directory: "${filePath}"`);
    }
    const resolved = resolve(VALIDATION_BASE, filePath);
    if (!resolved.startsWith(VALIDATION_BASE + "/") && resolved !== VALIDATION_BASE) {
      throw new Error(`File path escapes project directory: "${filePath}"`);
    }
  }
}

async function validateSkillPath(originalPath: string, resolvedPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`Skill path does not exist: "${originalPath}" (resolved to ${resolvedPath})`);
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

export function resolveSkillPath(skillPath: string, configDir: string): string {
  // Expand tilde
  if (skillPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(
        `Cannot expand "${skillPath}": HOME is not set. scuttlerun requires HOME to resolve tilde-prefixed paths.`,
      );
    }
    return join(home, skillPath.slice(2));
  }
  // Resolve relative paths from config file directory
  return resolve(configDir, skillPath);
}
