// packages/vetobench/src/adapters.ts
// ─────────────────────────────────────────────────────────────
// The memory conditions under test. Each adapter turns (scenario,
// corpus) into the context block that condition would put in front
// of the agent. Third-party memory systems plug in by implementing
// MemoryAdapter — see the README's "Adding a memory system".
//
// The four built-ins isolate two variables:
//   none        → no memory at all (floor)
//   conventions → choices recorded, vetoes absent (what a typical
//                 CLAUDE.md / conventions file actually contains)
//   flatfile    → everything dumped flat, vetoes included, no
//                 retrieval (a diligent-but-unranked notes file)
//   robrain     → top-k retrieval via the 5-signal composite score,
//                 vetoes rendered as first-class warnings
//
// conventions-vs-flatfile isolates the value of *storing vetoes*;
// flatfile-vs-robrain isolates the value of *retrieval + ranking*
// (which matters more as the corpus outgrows the context window).
// ─────────────────────────────────────────────────────────────

import { cosine, hashEmbedder, type Embedder } from './embedder.js'
import { compositeScore } from './scoring.js'
import type { CorpusDecision, MemoryAdapter, Scenario } from './types.js'

export const RETRIEVAL_K = 5

export interface RenderOptions {
  withVetoes: boolean
  /**
   * Prefix each decision with its date. Off for the default suite (keeps the
   * published corpus rendering byte-identical); ON for the lifecycle suite,
   * where a real decision log would carry dates — so `conventions` and
   * `flatfile` get every recency signal a human reader would have, and any
   * remaining gap is attributable to explicit lifecycle, not missing dates.
   */
  withDates?: boolean
}

function renderDecision(d: CorpusDecision, opts: RenderOptions): string {
  const date = opts.withDates ? `[${d.created_at.slice(0, 10)}] ` : ''
  const lines = [`- ${date}${d.decision} — ${d.rationale}`]
  if (opts.withVetoes) {
    for (const r of d.rejected) {
      const provenance = r.inherited_from
        ? ` (still-standing rejection carried from a superseded decision${r.inherited_date ? `, ${r.inherited_date.slice(0, 10)}` : ''})`
        : ''
      lines.push(`  - REJECTED${provenance}: ${r.option} — ${r.reason}`)
    }
  }
  return lines.join('\n')
}

/**
 * Active decisions, each carrying the vetoes recorded on the decision it replaced.
 *
 * A decision's *choice* and its *rejections* have different lifetimes: "we cache
 * sessions in Redis" can be superseded while "an in-process cache breaks under
 * multiple API instances" stays true forever. RoBrain's retrieval currently drops
 * the whole superseded row (every GET /decisions branch filters
 * `invalidated_at IS NULL`), taking still-valid vetoes with it — VetoBench's
 * lifecycle suite caught exactly that, and a dumb flat dump beat retrieval because
 * of it.
 *
 * Inherited vetoes are marked with their provenance rather than merged silently:
 * a supersession sometimes *adopts* what the old decision vetoed (reject ECS →
 * later migrate to ECS), and an unmarked carry-forward would then assert the
 * opposite of the current decision. Marking lets the agent weigh an inherited
 * veto against the live decision sitting next to it instead of taking it as law.
 */
function activeWithInheritedVetoes(corpus: CorpusDecision[]): CorpusDecision[] {
  const replacedBy = new Map<string, CorpusDecision[]>()
  for (const d of corpus) {
    if (d.status === 'superseded' && d.superseded_by) {
      const list = replacedBy.get(d.superseded_by) ?? []
      list.push(d)
      replacedBy.set(d.superseded_by, list)
    }
  }

  return corpus
    .filter(d => d.status !== 'superseded')
    .map(d => {
      const ancestors = replacedBy.get(d.id) ?? []
      if (ancestors.length === 0) return d
      const inherited = ancestors.flatMap(a =>
        a.rejected.map(r => ({
          ...r,
          inherited_from: a.id,
          inherited_date: a.created_at,
        })),
      )
      return { ...d, rejected: [...d.rejected, ...inherited] }
    })
}

export const noneAdapter: MemoryAdapter = {
  name: 'none',
  description: 'No memory context at all.',
  buildContext: () => '',
}

export function makeConventionsAdapter(withDates = false): MemoryAdapter {
  return {
    name: 'conventions',
    description: 'All recorded choices, no rejected alternatives — what a typical conventions file contains.',
    // Renders every decision, superseded ones included: this models the file
    // nobody went back to clean up, which is the realistic failure mode. A
    // curated file would be the row-4 condition wearing a row-2 costume.
    buildContext: (_scenario, corpus) =>
      `Project conventions and prior decisions:\n${corpus.map(d => renderDecision(d, { withVetoes: false, withDates })).join('\n')}`,
  }
}

export function makeFlatfileAdapter(withDates = false): MemoryAdapter {
  return {
    name: 'flatfile',
    description: 'Every decision including rejected alternatives, dumped flat with no retrieval or ranking.',
    buildContext: (_scenario, corpus) =>
      `Project decision log:\n${corpus.map(d => renderDecision(d, { withVetoes: true, withDates })).join('\n')}`,
  }
}

export const conventionsAdapter: MemoryAdapter = makeConventionsAdapter()
export const flatfileAdapter: MemoryAdapter = makeFlatfileAdapter()

/**
 * RoBrain condition: rank the corpus with the same 5-signal composite
 * scoring Perception uses for GET /decisions?query=…, inject the top-k
 * with rejected[] rendered as explicit warnings — the shape `npx robrain
 * inject` produces.
 */
export function makeRobrainAdapter(
  embed: Embedder = hashEmbedder,
  k: number = RETRIEVAL_K,
  withDates = false,
): MemoryAdapter {
  return {
    name: 'robrain',
    description: `Top-${k} active decisions by 5-signal composite score, rejected alternatives rendered as warnings.`,
    buildContext: (scenario, fullCorpus, asOf) => {
      // Superseded rows don't enter retrieval, but their still-standing vetoes
      // ride along on the decision that replaced them — no-op on the default
      // corpus (no status field), load-bearing on the lifecycle suite.
      const corpus = activeWithInheritedVetoes(fullCorpus)
      const queryEmbedding = embed(scenario.task)
      const ranked = corpus
        .map(d => ({
          d,
          score: compositeScore(
            d,
            cosine(queryEmbedding, embed(`${d.decision} ${d.rationale}`)),
            scenario.files_in_scope,
            asOf,
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(r => r.d)

      return `Relevant prior decisions for this task (from team memory):\n${ranked.map(d => renderDecision(d, { withVetoes: true, withDates })).join('\n')}`
    },
  }
}

/** Retrieval-layer measurement: rank the corpus and report where the veto decision lands. */
export function vetoRank(
  scenario: Scenario,
  fullCorpus: CorpusDecision[],
  asOf: string,
  embed: Embedder = hashEmbedder,
): number {
  const corpus = activeWithInheritedVetoes(fullCorpus)
  const queryEmbedding = embed(scenario.task)
  const ranked = corpus
    .map(d => ({
      id: d.id,
      score: compositeScore(
        d,
        cosine(queryEmbedding, embed(`${d.decision} ${d.rationale}`)),
        scenario.files_in_scope,
        asOf,
      ),
    }))
    .sort((a, b) => b.score - a.score)

  return ranked.findIndex(r => r.id === scenario.veto_decision_id) + 1   // 1-based; 0 = not found
}

export function builtinAdapters(embed: Embedder = hashEmbedder, withDates = false): MemoryAdapter[] {
  return [
    noneAdapter,
    makeConventionsAdapter(withDates),
    makeFlatfileAdapter(withDates),
    makeRobrainAdapter(embed, RETRIEVAL_K, withDates),
  ]
}
