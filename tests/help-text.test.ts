import { describe, it, expect } from 'vitest';
import { HELP_TEXT } from '../src/help-text.js';
import { RESULT_RECORDED_TOOLS } from '../src/transcript.js';

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

  it('says allowed_domains limits shell commands, not the web tools', () => {
    expect(HELP_TEXT).toMatch(/allowed_domains:[^\n]*Domains Bash commands can reach/);
    expect(HELP_TEXT).toMatch(/WebFetch and WebSearch[^\n]*not limited/);
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

  it('names every tool whose every result the transcript records', () => {
    const named = /tool results \(errors, and every ([^)]*) result\)/
      .exec(HELP_TEXT.replace(/\s+/g, ' '))?.[1]
      .split(/, | and /);
    expect(named).toEqual(RESULT_RECORDED_TOOLS);
  });
});

describe('HELP_TEXT turns', () => {
  it('says max_turns caps each agent turn, not the session', () => {
    expect(HELP_TEXT).toMatch(/max_turns: 50 +# Max model turns per agent turn/);
  });

  it("says the summary's turns add up every agent turn", () => {
    expect(HELP_TEXT.replace(/\s+/g, ' ')).toContain('turns (summed over every agent turn)');
  });
});
