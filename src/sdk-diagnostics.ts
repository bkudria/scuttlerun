import type {
  SDKSessionWritesLostMessage,
  SDKStartupFailureReason,
} from '@anthropic-ai/claude-agent-sdk';

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

export function startupFailureHint(
  reason: SDKStartupFailureReason | undefined,
): string | undefined {
  if (reason !== 'sandbox_required_unavailable') return undefined;
  return (
    `[scuttlerun] The sandbox is enabled but cannot run here. Install its OS ` +
    `dependencies (on Linux, bubblewrap and socat; see the Claude Code sandboxing ` +
    `docs), or set sandbox.enabled: false in the session config to run without it.\n`
  );
}
