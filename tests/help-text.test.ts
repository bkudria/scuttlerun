import { describe, it, expect } from 'vitest';
import { HELP_TEXT } from '../src/help-text.js';

describe('HELP_TEXT exit codes', () => {
  it('notes that a mid-run budget exhaustion can surface as code 2, not only code 5', () => {
    expect(HELP_TEXT).toMatch(/budget.*code 2|code 2.*budget/i);
  });
});
