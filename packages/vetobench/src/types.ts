// packages/vetobench/src/types.ts
// ─────────────────────────────────────────────────────────────
// VetoBench fixture and adapter types.
//
// A scenario is a task that naturally invites an approach the
// fixture team has already rejected (recorded in the corpus as a
// decision with a populated rejected[]). A memory condition is
// judged on whether the agent, given that condition's context,
// re-proposes the rejected approach.
// ─────────────────────────────────────────────────────────────

export interface Veto {
  option: string
  reason: string
  /** Set when this veto was recorded on a decision that has since been superseded. */
  inherited_from?: string
  inherited_date?: string
}

export interface CorpusDecision {
  id: string
  decision: string
  rationale: string
  rejected: Veto[]
  files_affected: string[]
  created_at: string
  reviewed_at?: string | null
  historical_relevance: number
  /** Lifecycle (lifecycle suite only; absent in the default corpus). */
  status?: 'active' | 'superseded'
  /** Id of the decision that replaced this one. */
  superseded_by?: string
}

/**
 * direct   — the task asks for the rejected thing outright
 * implicit — the task merely invites it
 * stale-named   — the task invites a SUPERSEDED choice; the newer decision names what it replaced
 * stale-unnamed — same, but the newer decision never mentions its predecessor, so only
 *                 the lifecycle metadata distinguishes them (dates aside)
 */
export type TrapKind = 'direct' | 'implicit' | 'stale-named' | 'stale-unnamed'

export interface Scenario {
  id: string
  /** Corpus decision whose rejected[] contains the trap. */
  veto_decision_id: string
  /** direct = the task asks for the rejected thing; implicit = the task merely invites it. */
  trap: TrapKind
  task: string
  files_in_scope: string[]
  /** Canonical name of the rejected option, matched against the agent's key_technologies. */
  rejected_option: string
  /** Case-insensitive regexes matched against the agent's proposal prose. */
  rejected_markers: string[]
  /** Case-insensitive regexes indicating the recorded (accepted) approach. */
  accepted_markers: string[]
}

export interface ScenarioFixtureFile {
  as_of: string
  scenarios: Scenario[]
}

/**
 * A memory condition under test. Given a scenario and the full corpus,
 * it returns the context block that condition would put in front of the
 * agent (empty string = no memory).
 *
 * Third-party systems with their own ingestion pipeline implement `init`
 * — it runs once per benchmark run, before any scenario, and is where the
 * corpus gets fed through that system's real ingestion (LLM extraction,
 * embedding, whatever it does in production).
 */
export interface MemoryAdapter {
  name: string
  description: string
  init?(corpus: CorpusDecision[], asOf: string): Promise<void>
  buildContext(scenario: Scenario, corpus: CorpusDecision[], asOf: string): string | Promise<string>
  /** Optional JSON-serializable evidence from init (e.g. what survived extraction) — archived when --archive is set. */
  report?(): unknown
}

/** Structured reply the agent is instructed to produce in live mode. */
export interface AgentReply {
  proposal: string
  key_technologies: string[]
  acknowledged_rejections: string[]
}

export interface ScenarioVerdict {
  scenarioId: string
  adapter: string
  trap: TrapKind
  /** Agent re-proposed the rejected approach. */
  violation: boolean
  /** Agent named the prior rejection (regardless of whether it then violated). */
  acknowledged: boolean
  /** Which marker or technology entry triggered the violation, for the report. */
  matchedOn?: string
}
