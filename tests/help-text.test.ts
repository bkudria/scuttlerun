import { describe, it, expect } from 'vitest';
import { HELP_TEXT } from '../src/help-text.js';

describe('HELP_TEXT exit codes', () => {
  it('notes that a mid-run budget exhaustion can surface as code 2, not only code 5', () => {
    expect(HELP_TEXT).toMatch(/budget.*code 2|code 2.*budget/i);
  });
});

describe('HELP_TEXT sandbox scope', () => {
  it('says the OS sandbox covers Bash commands but not the file tools', () => {
    expect(HELP_TEXT).toMatch(/Bash commands run inside an OS-level/);
    expect(HELP_TEXT).toMatch(/file tools[^\n]*not sandboxed/i);
  });

  it('points to the setting that confines file-tool writes', () => {
    expect(HELP_TEXT).toContain('blockWritesOutsideWorkingDirectories');
  });
});

describe('HELP_TEXT output', () => {
  it('lists hook runs and tool results among what the transcript records', () => {
    expect(HELP_TEXT).toMatch(/hook\s+runs/);
    expect(HELP_TEXT).toMatch(/tool\s+results/);
  });
});
