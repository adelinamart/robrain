// Deterministic turn capture: the eve analog of the Claude Code plugin's Stop
// hook. Observe-only stream hook; ships completed turns to Perception as
// needs_classification signals. Perception classifies/dedups server-side, so
// this stays a dumb, fail-open pipe.
//
// Event choice (verified live, eve 0.82.0): message.completed carries the full
// assistant text in data.message. It fires once per assistant text block, so a
// turn with interim narration before tool calls fires it multiple times; some
// eve versions have also emitted it with message: null on tool-call-only steps
// (0.82.0 emits none there). We keep the LAST non-empty message and flush
// exactly once on turn.completed — robust across all of those variants.
// Note for older eve: 0.24.x carried a cumulative messageSoFar on
// message.appended; 0.82.0 removed it (deltas only), so don't rely on it.
//
// Hooks are at-least-once (a replayed step re-emits events), so a turn can be
// shipped twice with slightly different text; Perception's server-side
// near-duplicate dedup absorbs that.
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
    async "message.completed"(event: any, ctx) {
      try {
        const s = ensure(ctx.session.id);
        const text = event?.data?.message;
        // null guard: tool-call-only steps complete with message: null
        if (typeof text === "string" && text.trim()) s.reply = text;
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
