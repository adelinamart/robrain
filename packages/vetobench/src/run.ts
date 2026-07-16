// packages/vetobench/src/run.ts
// ─────────────────────────────────────────────────────────────
// VetoBench — does memory keep an agent from re-proposing what
// the team already rejected?
//
// Two layers:
//
//   Retrieval (default, offline, deterministic) — for every
//   scenario, rank the corpus with the 5-signal composite score
//   and report where the veto decision lands. Metric: veto
//   recall@K. Exits nonzero below the threshold so CI can gate.
//
//   Behavioral (--live, needs an LLM key) — for every memory
//   condition × scenario, put that condition's context in front
//   of the agent, ask for a proposal, and deterministically check
//   whether it re-proposes the rejected approach. Metrics:
//   violation rate and acknowledgement rate per condition.
//
//   pnpm --filter @robrain/vetobench bench          # retrieval only
//   pnpm --filter @robrain/vetobench bench:live     # + behavioral
// ─────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  DEFAULT_ANTHROPIC_LLM_MODEL,
  DEFAULT_OPENAI_LLM_MODEL,
  loadCliEnv,
  resolveLlmProvider,
} from '@robrain/shared'
import { builtinAdapters, RETRIEVAL_K, vetoRank } from './adapters.js'
import { askAgent } from './agent.js'
import { judgeReply, summarize } from './score.js'
import type { CorpusDecision, ScenarioFixtureFile, ScenarioVerdict } from './types.js'

/** CI gate for the offline retrieval layer. */
const MIN_VETO_RECALL_AT_K = 0.80

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T
}

function parseArgs(argv: string[]) {
  const args = {
    live: false,
    adapters: null as string[] | null,
    model: undefined as string | undefined,
    archive: undefined as string | undefined,
    suite: 'default' as 'default' | 'lifecycle',
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') args.live = true
    if (argv[i] === '--adapters' && argv[i + 1]) args.adapters = argv[++i]!.split(',').map(s => s.trim())
    if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i]
    if (argv[i] === '--archive' && argv[i + 1]) args.archive = argv[++i]
    if (argv[i] === '--suite' && argv[i + 1]) args.suite = argv[++i] as 'default' | 'lifecycle'
  }
  return args
}

function retrievalLayer(corpus: CorpusDecision[], fixture: ScenarioFixtureFile): number {
  console.log(`\nRetrieval layer — veto decision rank under 5-signal composite scoring (top-${RETRIEVAL_K} injected)`)
  console.log('"files known" = the agent is editing files the decision touched; "no files" = semantic + recency + approval only')
  console.log(`${'scenario'.padEnd(9)} ${'veto'.padEnd(6)} ${'files known'.padStart(11)} ${'no files'.padStart(9)}`)

  let hits = 0
  let hitsNoFiles = 0
  for (const s of fixture.scenarios) {
    const rank = vetoRank(s, corpus, fixture.as_of)
    const rankNoFiles = vetoRank({ ...s, files_in_scope: [] }, corpus, fixture.as_of)
    const hit = rank > 0 && rank <= RETRIEVAL_K
    const hitNoFiles = rankNoFiles > 0 && rankNoFiles <= RETRIEVAL_K
    if (hit) hits++
    if (hitNoFiles) hitsNoFiles++
    console.log(
      `${s.id.padEnd(9)} ${s.veto_decision_id.padEnd(6)} ${`${rank || '—'} ${hit ? '✓' : '✗'}`.padStart(11)} ${`${rankNoFiles || '—'} ${hitNoFiles ? '✓' : '✗'}`.padStart(9)}`,
    )
  }

  const recall = hits / fixture.scenarios.length
  const recallNoFiles = hitsNoFiles / fixture.scenarios.length
  console.log(`\nveto recall@${RETRIEVAL_K}: ${recall.toFixed(2)} with files known (gate: ≥ ${MIN_VETO_RECALL_AT_K.toFixed(2)}) · ${recallNoFiles.toFixed(2)} without`)
  return recall
}

async function behavioralLayer(
  corpus: CorpusDecision[],
  fixture: ScenarioFixtureFile,
  adapterFilter: string[] | null,
  model?: string,
  archivePath?: string,
  withDates = false,
): Promise<void> {
  const adapters = builtinAdapters(undefined, withDates).filter(a => !adapterFilter || adapterFilter.includes(a.name))

  // Opt-in adapters load lazily so the offline bench never needs their deps or keys.
  if (adapterFilter?.includes('mem0')) {
    const { makeMem0Adapter } = await import('./mem0-adapter.js')
    adapters.push(makeMem0Adapter())
  }
  if (adapterFilter?.includes('robrain-e2e')) {
    const { makeRobrainE2eAdapter } = await import('./e2e-adapter.js')
    adapters.push(makeRobrainE2eAdapter())
  }

  const verdicts: ScenarioVerdict[] = []
  const archiveCells: Array<Record<string, unknown>> = []

  console.log(`\nBehavioral layer — ${adapters.map(a => a.name).join(', ')} × ${fixture.scenarios.length} scenarios`)
  console.log('(one agent call per cell; deterministic marker judging, no LLM judge)\n')

  for (const adapter of adapters) {
    if (adapter.init) {
      console.log(`${adapter.name}: ingesting ${corpus.length} decisions through its own pipeline…`)
      await adapter.init(corpus, fixture.as_of)
    }
    for (const s of fixture.scenarios) {
      const context = await adapter.buildContext(s, corpus, fixture.as_of)
      try {
        const reply = await askAgent(context, s.task, { model })
        const verdict = judgeReply(s, adapter.name, reply)
        verdicts.push(verdict)
        archiveCells.push({ adapter: adapter.name, scenario: s.id, rejected_option: s.rejected_option, context, reply, verdict })
        const flag = verdict.violation ? `VIOLATION (${verdict.matchedOn})` : verdict.acknowledged ? 'avoided + acknowledged' : 'avoided'
        console.log(`${adapter.name.padEnd(12)} ${s.id}  ${flag}`)
      } catch (err) {
        archiveCells.push({ adapter: adapter.name, scenario: s.id, rejected_option: s.rejected_option, context, error: err instanceof Error ? err.message : String(err) })
        console.error(`${adapter.name.padEnd(12)} ${s.id}  ERROR: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Pace calls to stay under free-tier rate limits (e.g. Muse Spark on the
      // Vercel AI Gateway free tier). Off by default; set VETOBENCH_THROTTLE_MS.
      const throttleMs = Number.parseInt(process.env.VETOBENCH_THROTTLE_MS ?? '', 10) || 0
      if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
    }
  }

  if (archivePath) {
    const provider = resolveLlmProvider()
    mkdirSync(dirname(archivePath), { recursive: true })
    writeFileSync(archivePath, JSON.stringify({
      run_at: new Date().toISOString(),
      agent_provider: provider,
      agent_model: model ?? process.env.VETOBENCH_MODEL
        ?? (provider === 'openai' ? DEFAULT_OPENAI_LLM_MODEL : DEFAULT_ANTHROPIC_LLM_MODEL),
      adapters: adapters.map(a => ({ name: a.name, description: a.description })),
      adapter_reports: Object.fromEntries(adapters.filter(a => a.report).map(a => [a.name, a.report!()])),
      summary: summarize(verdicts),
      cells: archiveCells,
    }, null, 2))
    console.log(`\narchived contexts + replies + verdicts → ${archivePath}`)
  }

  const summaries = summarize(verdicts)
  const trapKinds = [...new Set(fixture.scenarios.map(s => s.trap))]
  console.log(
    `\n${'condition'.padEnd(13)} ${'violation'.padStart(9)} ${'ack'.padStart(6)}   ` +
    trapKinds.map(t => t.padEnd(15)).join(''),
  )
  for (const s of summaries) {
    const cells = trapKinds.map(t => {
      const b = s.byTrap[t]
      return (b ? `${b.violations}/${b.scenarios}` : '—').padEnd(15)
    })
    console.log(
      `${s.adapter.padEnd(13)} ${(s.violationRate * 100).toFixed(0).padStart(8)}% ${(s.acknowledgedRate * 100).toFixed(0).padStart(5)}%   ` +
      cells.join(''),
    )
  }
  console.log('\nviolation = re-proposed a recorded rejected approach · ack = named the prior rejection')
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const lifecycle = args.suite === 'lifecycle'
  const corpus = loadFixture<CorpusDecision[]>(lifecycle ? 'corpus-lifecycle.json' : 'corpus.json')
  const fixture = loadFixture<ScenarioFixtureFile>(lifecycle ? 'scenarios-lifecycle.json' : 'scenarios.json')

  const superseded = corpus.filter(d => d.status === 'superseded').length
  console.log(
    `VetoBench${lifecycle ? ' — lifecycle suite' : ''} — ${corpus.length} corpus decisions ` +
    `(${corpus.filter(d => d.rejected.length > 0).length} with vetoes` +
    `${superseded ? `, ${superseded} superseded` : ''}), ${fixture.scenarios.length} scenarios`,
  )
  console.log(`as-of ${fixture.as_of} (fixed for reproducible recency)`)

  const recall = retrievalLayer(corpus, fixture)

  if (args.live) {
    loadCliEnv()
    await behavioralLayer(corpus, fixture, args.adapters, args.model, args.archive, lifecycle)
  } else {
    console.log('\n(offline run — add --live with an LLM key for the behavioral layer)')
  }

  if (recall < MIN_VETO_RECALL_AT_K) {
    console.log('\n✗ FAIL — veto retrieval below threshold')
    return 1
  }
  console.log('\n✓ PASS')
  return 0
}

process.exit(await main())
