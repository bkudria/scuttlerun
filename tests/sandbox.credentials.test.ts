import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkOauthCredentialIntoSandbox, sandboxCredentialWarning } from '../src/sandbox.js';

describe('linkOauthCredentialIntoSandbox', () => {
  let realHome: string;
  let sandboxHome: string;

  beforeEach(() => {
    realHome = mkdtempSync(join(tmpdir(), 'scuttlerun-creds-real-'));
    sandboxHome = mkdtempSync(join(tmpdir(), 'scuttlerun-creds-sandbox-'));
  });

  afterEach(() => {
    rmSync(realHome, { recursive: true, force: true });
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  function writeRealCredentials(content = '{"token":"oauth-fake"}') {
    const claudeDir = join(realHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const path = join(claudeDir, '.credentials.json');
    writeFileSync(path, content);
    return path;
  }

  it('returns {linked: false} when ANTHROPIC_API_KEY is set', () => {
    writeRealCredentials();
    const result = linkOauthCredentialIntoSandbox({
      realHome,
      sandboxHome,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect(result.linked).toBe(false);
  });

  it('returns {linked: false} when source credentials file does not exist', () => {
    // realHome is an empty tmpdir — no .claude/.credentials.json
    const result = linkOauthCredentialIntoSandbox({
      realHome,
      sandboxHome,
      env: {},
    });
    expect(result.linked).toBe(false);
  });

  it('creates symlink and returns linked=true when no key and source exists', () => {
    const source = writeRealCredentials('{"token":"oauth-happy-path"}');
    const result = linkOauthCredentialIntoSandbox({
      realHome,
      sandboxHome,
      env: {},
    });
    const expectedLink = join(sandboxHome, '.claude', '.credentials.json');
    expect(result).toEqual({ linked: true, source, link: expectedLink });
    expect(lstatSync(expectedLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(expectedLink)).toBe(source);
  });

  it('is idempotent when link already exists pointing to same source', () => {
    const source = writeRealCredentials();
    const args = { realHome, sandboxHome, env: {} };
    const first = linkOauthCredentialIntoSandbox(args);
    expect(first.linked).toBe(true);
    const second = linkOauthCredentialIntoSandbox(args);
    expect(second).toEqual({
      linked: true,
      source,
      link: join(sandboxHome, '.claude', '.credentials.json'),
    });
  });

  it('throws when an existing symlink points to a different target', () => {
    writeRealCredentials();
    const otherSource = join(realHome, 'other.json');
    writeFileSync(otherSource, '{"token":"other"}');
    mkdirSync(join(sandboxHome, '.claude'), { recursive: true });
    symlinkSync(otherSource, join(sandboxHome, '.claude', '.credentials.json'));
    expect(() => linkOauthCredentialIntoSandbox({ realHome, sandboxHome, env: {} })).toThrow(
      /already exists/,
    );
  });

  it('throws when link path exists as a regular file', () => {
    writeRealCredentials();
    mkdirSync(join(sandboxHome, '.claude'), { recursive: true });
    writeFileSync(join(sandboxHome, '.claude', '.credentials.json'), '{}');
    expect(() => linkOauthCredentialIntoSandbox({ realHome, sandboxHome, env: {} })).toThrow(
      /already exists/,
    );
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('treats %s ANTHROPIC_API_KEY as unset and proceeds', (_label, key) => {
    writeRealCredentials();
    const result = linkOauthCredentialIntoSandbox({
      realHome,
      sandboxHome,
      env: { ANTHROPIC_API_KEY: key },
    });
    expect(result.linked).toBe(true);
  });
});

describe('sandboxCredentialWarning', () => {
  const noCreds = { sandboxEnabled: true, credentialLinked: false };

  it('warns when sandbox is enabled with no key, no token, and nothing linked', () => {
    const warning = sandboxCredentialWarning({ ...noCreds, env: {} });
    expect(warning).toBeDefined();
    // Actionable remediation must name the documented headless OAuth path.
    expect(warning).toContain('CLAUDE_SDK_OAUTH_TOKEN');
    expect(warning).toMatch(/WARNING/);
  });

  it('returns undefined when the sandbox is disabled', () => {
    expect(
      sandboxCredentialWarning({ sandboxEnabled: false, credentialLinked: false, env: {} }),
    ).toBeUndefined();
  });

  it('returns undefined when ANTHROPIC_API_KEY is set', () => {
    expect(
      sandboxCredentialWarning({ ...noCreds, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }),
    ).toBeUndefined();
  });

  it('returns undefined when CLAUDE_SDK_OAUTH_TOKEN is set', () => {
    expect(
      sandboxCredentialWarning({ ...noCreds, env: { CLAUDE_SDK_OAUTH_TOKEN: 'oauth-token' } }),
    ).toBeUndefined();
  });

  it('still warns when only CLAUDE_CODE_OAUTH_TOKEN is set (scuttlerun never forwards it)', () => {
    expect(
      sandboxCredentialWarning({ ...noCreds, env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' } }),
    ).toBeDefined();
  });

  it('returns undefined when a credentials file was linked', () => {
    expect(
      sandboxCredentialWarning({ sandboxEnabled: true, credentialLinked: true, env: {} }),
    ).toBeUndefined();
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('treats %s ANTHROPIC_API_KEY as unset and warns', (_label, key) => {
    expect(sandboxCredentialWarning({ ...noCreds, env: { ANTHROPIC_API_KEY: key } })).toBeDefined();
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('treats %s CLAUDE_SDK_OAUTH_TOKEN as unset and warns', (_label, token) => {
    expect(
      sandboxCredentialWarning({ ...noCreds, env: { CLAUDE_SDK_OAUTH_TOKEN: token } }),
    ).toBeDefined();
  });
});
