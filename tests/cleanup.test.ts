import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs/promises with passthrough so we can override readdir/rm for specific tests
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const mockReaddir = vi.fn<typeof actualFs.readdir>(actualFs.readdir);
const mockRm = vi.fn<typeof actualFs.rm>(actualFs.rm);
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readdir: mockReaddir, rm: mockRm };
});

const { mkdir, rm: actualRm, stat, utimes } = actualFs;

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
      await actualRm(oldDir, { recursive: true }).catch(() => {});
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
      await actualRm(freshDir, { recursive: true }).catch(() => {});
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
      await actualRm(otherDir, { recursive: true }).catch(() => {});
    }
  });

  it("returns 0 when nothing to clean", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const cleaned = await cleanOldProjects(9999);
    expect(cleaned).toBe(0);
  });

  it("logs to stderr when verbose is true and dirs are cleaned", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const oldDir = await createOldDir("scuttlerun-project-test-verbose-" + Date.now(), 10);
    let stderrOutput = "";
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      await cleanOldProjects(7, { verbose: true });
      expect(stderrOutput).toContain("[scuttlerun] Cleaned");
    } finally {
      process.stderr.write = origWrite;
      await actualRm(oldDir, { recursive: true }).catch(() => {});
    }
  });

  it("logs per-directory errors to stderr when verbose is true", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const oldDir = await createOldDir("scuttlerun-project-test-rmerr-" + Date.now(), 10);

    // Make rm throw for this directory
    mockRm.mockRejectedValueOnce(new Error("EBUSY: resource busy"));

    let stderrOutput = "";
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      const cleaned = await cleanOldProjects(7, { verbose: true });
      // rm failed so the dir wasn't cleaned
      expect(cleaned).toBe(0);
      expect(stderrOutput).toContain("[scuttlerun] Failed to clean");
      expect(stderrOutput).toContain("EBUSY");
    } finally {
      process.stderr.write = origWrite;
      await actualRm(oldDir, { recursive: true }).catch(() => {});
    }
  });

  it("silently swallows per-directory errors when verbose is false", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    const oldDir = await createOldDir("scuttlerun-project-test-silent-" + Date.now(), 10);

    mockRm.mockRejectedValueOnce(new Error("EBUSY: resource busy"));

    let stderrOutput = "";
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      const cleaned = await cleanOldProjects(7);
      expect(cleaned).toBe(0);
      expect(stderrOutput).toBe("");
    } finally {
      process.stderr.write = origWrite;
      await actualRm(oldDir, { recursive: true }).catch(() => {});
    }
  });

  it("returns 0 when readdir throws", async () => {
    const { cleanOldProjects } = await import("../src/cleanup.js");
    mockReaddir.mockRejectedValueOnce(new Error("EPERM"));
    const cleaned = await cleanOldProjects(7);
    expect(cleaned).toBe(0);
  });
});
