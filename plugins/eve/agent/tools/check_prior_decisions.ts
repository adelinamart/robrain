// Veto scan as a first-class typed tool: the model checks the team's decision
// memory before proposing an approach. Two-tier, matching the Claude Code and
// Codex hooks: deterministic POST /veto-scan (exact rejected-option match)
// merged ahead of semantic GET /decisions results.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scanForVetoes } from "../lib/robrain";

export default defineTool({
  description:
    "Check the team's decision memory for prior decisions relevant to a task, " +
    "including REJECTED alternatives and why they were rejected. Call this " +
    "before proposing any technology, architecture, or approach.",
  inputSchema: z.object({
    task: z
      .string()
      .min(4)
      .describe("Short description of the task or the approach being considered."),
  }),
  async execute({ task }) {
    const vetoes = await scanForVetoes(task);
    if (vetoes.length === 0) {
      return { relevant_decisions: [], note: "No recorded rejections relevant to this task." };
    }
    return {
      relevant_decisions: vetoes.slice(0, 5).map((d) => ({
        decision: d.decision,
        exact_match: d.exact === true,
        rejected: d.rejected.map((r) => `${r.option} — ${r.reason}`),
      })),
      note:
        "Do not re-propose a rejected option without flagging the prior rejection " +
        "and why circumstances changed.",
    };
  },
});
