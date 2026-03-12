import { appendFile } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";

export interface WarrenEvent {
  timestamp: string;
  type: string;
  session_id: string;
  data: Record<string, unknown>;
}

// Event types that get immediate fsync (high-value, crash-resilient)
const FSYNC_EVENT_TYPES = new Set([
  "session_start",
  "ask_user_question",
  "turn_policy",
  "error",
  "session_end",
]);

export class EventRecorder {
  private filePath: string;
  private sessionId: string;

  constructor(filePath: string, sessionId: string) {
    this.filePath = filePath;
    this.sessionId = sessionId;
  }

  async writeEvent(type: string, data: Record<string, unknown>): Promise<void> {
    const event: WarrenEvent = {
      timestamp: new Date().toISOString(),
      type,
      session_id: this.sessionId,
      data,
    };

    const line = JSON.stringify(event) + "\n";

    if (FSYNC_EVENT_TYPES.has(type)) {
      // High-value events: write + fsync for crash resilience
      const fd = openSync(this.filePath, "a");
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      // Low-value events (agent_stderr): append without fsync
      await appendFile(this.filePath, line);
    }
  }
}
