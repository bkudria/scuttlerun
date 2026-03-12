import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ScaffoldResult {
  projectPath: string;
}

export async function createProjectDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "warren-project-"));
}

export async function scaffoldProject(
  config: ProjectConfig,
  _configDir: string,
): Promise<ScaffoldResult> {
  const projectPath = await fs.mkdtemp(join(tmpdir(), "warren-project-"));

  // Write CLAUDE.md
  if (config.claude_md) {
    await fs.writeFile(join(projectPath, "CLAUDE.md"), config.claude_md);
  }

  // Symlink skills
  if (config.skills && config.skills.length > 0) {
    const skillsDir = join(projectPath, ".claude", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    for (const skillPath of config.skills) {
      const resolved = resolveSkillPath(skillPath, _configDir);
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

  // Git init
  if (config.git_init) {
    await execFileAsync("git", ["init"], { cwd: projectPath });
  }

  return { projectPath };
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
