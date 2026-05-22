import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/sdk-tool-names.js', () => ({
  getKnownSdkToolNames: () => new Set<string>(),
}));

import { parseSessionConfig } from '../src/config.js';

describe('parseSessionConfig — empty SDK tool set', () => {
  it('skips unknown-tool warnings when the SDK tool list is empty', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    parseSessionConfig({
      prompt: 'hi',
      tools: ['UnknownA'],
      disallowed_tools: ['UnknownB'],
    });
    const warnings = spy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('WARNING'));
    expect(warnings.length).toBe(0);
    spy.mockRestore();
  });
});
