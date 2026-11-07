import { describe, it, expect } from 'vitest';
import type { SDKSessionWritesLostMessage } from '@anthropic-ai/claude-agent-sdk';
import { lostThisSessionsTranscript, transcriptLostWarning } from '../src/sdk-diagnostics.js';

function writesLost(fields: Partial<SDKSessionWritesLostMessage>): SDKSessionWritesLostMessage {
  return {
    type: 'system',
    subtype: 'session_writes_lost',
    error_code: 'ENOSPC',
    lost: ['transcript'],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 's-1',
    ...fields,
  };
}

describe('lostThisSessionsTranscript', () => {
  it('is true when this session is among those that lost transcript lines', () => {
    const message = writesLost({ transcript_session_ids: ['s-earlier', 's-1'] });
    expect(lostThisSessionsTranscript(message, 's-1')).toBe(true);
  });

  it('is false when only other sessions lost transcript lines', () => {
    const message = writesLost({ transcript_session_ids: ['s-earlier'] });
    expect(lostThisSessionsTranscript(message, 's-1')).toBe(false);
  });

  it('is false when the transcript loss names no sessions', () => {
    expect(lostThisSessionsTranscript(writesLost({}), 's-1')).toBe(false);
  });

  it('is false when only the global config was lost', () => {
    const message = writesLost({ lost: ['global_config'] });
    expect(lostThisSessionsTranscript(message, undefined)).toBe(false);
  });

  it('presumes the loss belongs to this run before the session id is known', () => {
    const message = writesLost({ transcript_session_ids: ['s-early'] });
    expect(lostThisSessionsTranscript(message, undefined)).toBe(true);
  });
});

describe('transcriptLostWarning', () => {
  it('names the error code and the announced JSONL path', () => {
    const warning = transcriptLostWarning(writesLost({ error_code: 'EDQUOT' }), '/h/s-1.jsonl');
    expect(warning).toMatch(/^\[scuttlerun\] WARNING: .*EDQUOT.*\/h\/s-1\.jsonl is incomplete\n$/);
  });

  it('falls back to a generic name when no JSONL path was announced', () => {
    const warning = transcriptLostWarning(writesLost({}), undefined);
    expect(warning).toContain('the SDK session JSONL is incomplete');
  });
});
