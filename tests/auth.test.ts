import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  parseAuthMode,
  detectSubscriptionCredentials,
  buildAuthEnv,
  applyAuthMode,
} from '../src/auth.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockExecFileSync.mockImplementation(() => {
    throw new Error('not found');
  });
});

describe('parseAuthMode', () => {
  it.each(['auto', 'subscription', 'api-key'] as const)('accepts %s', (mode) => {
    expect(parseAuthMode(mode)).toBe(mode);
  });

  it('rejects unknown modes with an error naming the valid values', () => {
    expect(() => parseAuthMode('oauth')).toThrow(/auto, subscription, or api-key/);
  });
});

describe('detectSubscriptionCredentials', () => {
  it('returns true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    expect(detectSubscriptionCredentials({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, 'linux')).toBe(true);
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(detectSubscriptionCredentials({ CLAUDE_CODE_OAUTH_TOKEN: '   ' }, 'linux')).toBe(false);
  });

  it('returns true when the credentials file contains claudeAiOauth', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));

    expect(detectSubscriptionCredentials({}, 'linux')).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith('/home/user/.claude/.credentials.json');
  });

  it('respects CLAUDE_CONFIG_DIR for the credentials file location', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));

    expect(detectSubscriptionCredentials({ CLAUDE_CONFIG_DIR: '/etc/claude' }, 'linux')).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith('/etc/claude/.credentials.json');
  });

  it('returns false when the credentials file lacks claudeAiOauth', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ somethingElse: {} }));

    expect(detectSubscriptionCredentials({}, 'linux')).toBe(false);
  });

  it('treats an unreadable or unparseable credentials file as absent', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');

    expect(detectSubscriptionCredentials({}, 'linux')).toBe(false);
  });

  it('returns true on darwin when the Keychain holds Claude Code credentials', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    expect(detectSubscriptionCredentials({}, 'darwin')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { stdio: 'ignore' },
    );
  });

  it('returns false on darwin when the Keychain lookup fails', () => {
    expect(detectSubscriptionCredentials({}, 'darwin')).toBe(false);
  });

  it('does not consult the Keychain on non-darwin platforms', () => {
    expect(detectSubscriptionCredentials({}, 'linux')).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('skips the Keychain when includeKeychain is false (sandbox cannot reach it)', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    expect(detectSubscriptionCredentials({}, 'darwin', { includeKeychain: false })).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('still detects the credentials file when includeKeychain is false', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));

    expect(detectSubscriptionCredentials({}, 'darwin', { includeKeychain: false })).toBe(true);
  });
});

describe('buildAuthEnv', () => {
  it('always unsets CLAUDECODE and does not mutate the input env', () => {
    const env = { CLAUDECODE: '1', OTHER: 'kept' };
    const result = buildAuthEnv('auto', env);

    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.OTHER).toBe('kept');
    expect(env.CLAUDECODE).toBe('1');
  });

  it('auto: strips API credentials when subscription credentials are detected', () => {
    const result = buildAuthEnv('auto', {
      ANTHROPIC_API_KEY: 'sk-ant-key',
      ANTHROPIC_AUTH_TOKEN: 'bearer',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('auto: keeps API credentials when no subscription credentials are found', () => {
    const result = buildAuthEnv('auto', { ANTHROPIC_API_KEY: 'sk-ant-key' }, 'linux');

    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-key');
  });

  it('auto: skips detection entirely when no API credentials are present', () => {
    const result = buildAuthEnv('auto', {}, 'darwin');

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('subscription: strips API credentials unconditionally, without detection', () => {
    const result = buildAuthEnv('subscription', {
      ANTHROPIC_API_KEY: 'sk-ant-key',
      ANTHROPIC_AUTH_TOKEN: 'bearer',
    });

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('api-key: strips CLAUDE_CODE_OAUTH_TOKEN and keeps the API key', () => {
    const result = buildAuthEnv('api-key', {
      ANTHROPIC_API_KEY: 'sk-ant-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });

    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-key');
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('api-key: throws when ANTHROPIC_API_KEY is unset or blank', () => {
    expect(() => buildAuthEnv('api-key', {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => buildAuthEnv('api-key', { ANTHROPIC_API_KEY: '  ' })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('applyAuthMode', () => {
  it('strips API credentials when the mode is subscription', () => {
    const env = { ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 'b', HOME: '/sb' };
    const result = applyAuthMode('subscription', env, false);

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.HOME).toBe('/sb');
    expect(env.ANTHROPIC_API_KEY).toBe('sk');
  });

  it('auto: strips API credentials only when subscription was detected', () => {
    const env = { ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };

    expect(applyAuthMode('auto', env, true).ANTHROPIC_API_KEY).toBeUndefined();
    expect(applyAuthMode('auto', env, false).ANTHROPIC_API_KEY).toBe('sk');
  });

  it('api-key: strips CLAUDE_CODE_OAUTH_TOKEN', () => {
    const env = { ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
    const result = applyAuthMode('api-key', env, false);

    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBe('sk');
  });
});
