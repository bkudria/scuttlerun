import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

describe("cleanOldProjects", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = tmpdir();
  });

  async function createOldDir(name: string, daysOld: number): Promise<string> {
    const dirPath = join(tmpDir, name);
    await mkdir(dirPath, { recursive: true });
    const pastTime = new Date(Date.now() - daysOld * 86_400_000);
    await utimes(dirPath, pastTime, pastTime);
    return dirPath;
  }

  async function createFreshDir(name: string): Promise<string> {
    const dirPath = join(tmpDir, name);
    await mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  it("removes scuttlerun-project dirs older than threshold", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const oldDir = await createOldDir("scuttlerun-project-test-old-" + Date.now(), 10);

    try {
      const cleaned = await cleanOldProjects(7);
      expect(cleaned).toBeGreaterThanOrEqual(1);
      await expect(stat(oldDir)).rejects.toThrow();
    } finally {
      await rm(oldDir, { recursive: true }).catch(() => {});
    }
  });

  it("preserves scuttlerun-project dirs newer than threshold", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const freshDir = await createFreshDir("scuttlerun-project-test-fresh-" + Date.now());

    try {
      await cleanOldProjects(7);
      const info = await stat(freshDir);
      expect(info.isDirectory()).toBe(true);
    } finally {
      await rm(freshDir, { recursive: true }).catch(() => {});
    }
  });

  it("does not touch non-scuttlerun dirs", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const otherDir = await createOldDir("other-tool-test-" + Date.now(), 10);

    try {
      await cleanOldProjects(7);
      const info = await stat(otherDir);
      expect(info.isDirectory()).toBe(true);
    } finally {
      await rm(otherDir, { recursive: true }).catch(() => {});
    }
  });

  it("returns 0 when nothing to clean", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const cleaned = await cleanOldProjects(9999);
    expect(cleaned).toBe(0);
  });
});
