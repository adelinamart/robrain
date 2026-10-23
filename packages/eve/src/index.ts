// @robrain/eve — RoBrain memory provider for eve agents.
//
//   import { robrainMemory } from "@robrain/eve";
//   import { defineMemory } from "eve/memory";
//
//   export default defineMemory({
//     description: "The team's engineering decisions, including rejected alternatives.",
//     provider: robrainMemory({ apiKey: () => process.env.ROBRAIN_API_KEY }),
//     scope: "team",
//   });

export { robrainMemory } from "./provider.js";
export type { RobrainMemoryOptions, ProjectResolverContext } from "./config.js";
export type { VetoDecision, RejectedOption, ContextMemory } from "./client.js";
