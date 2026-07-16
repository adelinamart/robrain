// Always-on RoBrain project memory, resolved at session start from the
// self-hosted Perception service. The eve analog of the Claude Code plugin's
// SessionStart hook: deterministic injection, no reliance on the model
// remembering to fetch anything. Fails open — no Perception, no block, and
// the session proceeds without memory.
import { defineDynamic, defineInstructions } from "eve/instructions";
import { alwaysOnSummary } from "../lib/robrain";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const summary = await alwaysOnSummary();
      if (!summary) return null;
      return defineInstructions({
        markdown: [
          "## RoBrain project memory (always-on summary)",
          "Prior decisions for this project, including rejected alternatives. Respect the rejections —",
          "if a task invites a previously rejected approach, surface the rejection instead of re-proposing it.",
          "",
          summary,
        ].join("\n"),
      });
    },
  },
});
