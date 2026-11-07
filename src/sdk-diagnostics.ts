import type { SDKSessionWritesLostMessage } from '@anthropic-ai/claude-agent-sdk';

// Before init there is no session id to match, so any transcript loss is
// presumed to be this run's.
export function lostThisSessionsTranscript(
  message: SDKSessionWritesLostMessage,
  sessionId: string | undefined,
): boolean {
  if (!message.lost.includes('transcript')) return false;
  return sessionId === undefined || (message.transcript_session_ids ?? []).includes(sessionId);
}

export function transcriptLostWarning(
  message: SDKSessionWritesLostMessage,
  sdkSessionPath: string | undefined,
): string {
  return (
    `[scuttlerun] WARNING: the Claude Code CLI ran out of disk space or quota ` +
    `(${message.error_code}) and could not save the whole session transcript, so ` +
    `${sdkSessionPath ?? 'the SDK session JSONL'} is incomplete\n`
  );
}
