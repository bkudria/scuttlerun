import { describe, it, expect } from 'vitest';
import { unregisteredSlashCommand } from '../src/slash-command.js';

describe('unregisteredSlashCommand', () => {
  it('flags a plugin-qualified command that is not registered', () => {
    expect(unregisteredSlashCommand('/acme:deploy infra/prod.yaml', ['deploy'])).toBe(
      'acme:deploy',
    );
  });

  it('returns null when the plugin-qualified command is registered', () => {
    expect(unregisteredSlashCommand('/acme:deploy foo', ['acme:deploy'])).toBeNull();
  });

  it('returns null for a registered bare command', () => {
    expect(unregisteredSlashCommand('/deploy infra/prod.yaml to staging', ['deploy'])).toBeNull();
  });

  it('flags an unregistered bare command at end of string', () => {
    expect(unregisteredSlashCommand('/deploy', ['acme:deploy'])).toBe('deploy');
  });

  it('returns null for a natural-language prompt (no leading slash)', () => {
    expect(unregisteredSlashCommand('Use the deploy skill to ship it', ['deploy'])).toBeNull();
  });

  it('returns null for a path-shaped leading token (not a command)', () => {
    expect(unregisteredSlashCommand('/etc/hosts is broken, please review', ['deploy'])).toBeNull();
  });

  it('returns null for a registered built-in command', () => {
    expect(unregisteredSlashCommand('/compact', ['compact', 'deploy'])).toBeNull();
  });

  it('returns null for an empty prompt', () => {
    expect(unregisteredSlashCommand('', ['deploy'])).toBeNull();
  });
});
