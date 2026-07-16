// Deterministic turn capture: the eve analog of the Claude Code plugin's Stop
// hook. Observe-only stream hook; ships completed turns to Perception as
// needs_classification signals. Perception classifies/dedups server-side, so
// this stays a dumb, fail-open pipe.
//
// Event choice (verified live, eve 0.24.4): hooks receive message.received /
// message.appended / message.completed / turn.completed. We accumulate
// messageSoFar and flush once on turn.completed rather than using
// message.completed, because message.completed fires MULTIPLE times per turn
// (interim narration before tool calls) — turn.completed gives exactly one
// capture per turn with the final text.
import { defineHook } from "eve/hooks";
import { perceptionFetch, PROJECT_ID } from "../lib/robrain";

const state = new Map<string, { user: string; reply: string; seq: number }>();

function ensure(sessionId: string) {
  let s = state.get(sessionId);
  if (!s) {
    s = { user: "", reply: "", seq: 0 };
    state.set(sessionId, s);
  }
  return s;
}

export default defineHook({
  events: {
    async "message.received"(event: any, ctx) {
      try {
        const s = ensure(ctx.session.id);
        const text = event?.data?.message;
        if (typeof text === "string" && text.trim()) s.user = text;
      } catch {
        // fail open
      }
    },
    async "message.appended"(event: any, ctx) {
      try {
        const s = ensure(ctx.session.id);
        const soFar = event?.data?.messageSoFar;
        if (typeof soFar === "string" && soFar) s.reply = soFar;
      } catch {
        // fail open
      }
    },
    async "turn.completed"(_event: any, ctx) {
      try {
        if (!PROJECT_ID) return;
        const s = ensure(ctx.session.id);
        if (!s.user.trim() || !s.reply.trim()) return;
        s.seq += 1;
        const payload = {
          signal: {
            turn: {
              session_id: `eve-${ctx.session.id}`.slice(0, 200),
              sequence: s.seq,
              user_message: s.user.slice(0, 60_000),
              claude_reply: s.reply.slice(0, 60_000),
              files_touched: [],
              timestamp: new Date().toISOString(),
            },
            decision_type: "unclassified",
            confidence: 0,
            files_affected: [],
            scope: "team",
            needs_classification: true,
          },
        };
        s.user = "";
        s.reply = "";
        await perceptionFetch(
          "/signals",
          {
            method: "POST",
            headers: { "X-Project-Id": PROJECT_ID },
            body: JSON.stringify(payload),
          },
          8000,
        );
      } catch {
        // fail open — capture is best-effort, never breaks the session
      }
    },
  },
});
