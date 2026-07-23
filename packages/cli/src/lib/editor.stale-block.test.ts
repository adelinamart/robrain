import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roBrainBlockReferencesRemovedTools, REMOVED_CONTROL_TOOLS } from './editor.js'

const MARK_START = '<!-- robrain -->'
const MARK_END   = '<!-- /robrain -->'

test('flags a marked block that names a removed Control tool', () => {
  const content = `# AGENTS.md
${MARK_START}
## RoBrain
control_get_session_context(project_id="x", session_id="y")
${MARK_END}
`
  assert.equal(roBrainBlockReferencesRemovedTools(content), true)
})

test('current block (real tools only) is not flagged', () => {
  const content = `${MARK_START}
control_get_context(project_id="x", task_description="t", session_id="s")
control_check_task(project_id="x", proposed_approach="p")
control_record_correction(decision_id="d", action="approve")
control_report_reply(session_id="s", sequence=1, reply_text="r")
${MARK_END}
`
  assert.equal(roBrainBlockReferencesRemovedTools(content), false)
})

test('a removed-tool mention OUTSIDE the marked block is not a false positive', () => {
  const content = `# Changelog
- Removed control_add_rule and control_end_session in 2.4.5.

${MARK_START}
control_get_context(project_id="x", task_description="t")
${MARK_END}
`
  assert.equal(roBrainBlockReferencesRemovedTools(content), false)
})

test('start marker without end still flags removed tools in the truncated block', () => {
  const content = `# AGENTS.md
${MARK_START}
## RoBrain
control_inject_context(project_id="x")
`
  assert.equal(roBrainBlockReferencesRemovedTools(content), true)
})

test('start marker without end does not flag when only current tools remain', () => {
  const content = `${MARK_START}
control_get_context(project_id="x", task_description="t")
`
  assert.equal(roBrainBlockReferencesRemovedTools(content), false)
})

test('unmarked legacy instruction file naming a removed tool is flagged', () => {
  // Pre-marker AGENTS.md / CLAUDE.md blocks — doctor only runs this on those files.
  assert.equal(
    roBrainBlockReferencesRemovedTools('## RoBrain\ncontrol_get_session_context(project_id="x")\n'),
    true,
  )
})

test('unrelated text with no removed tool names is not flagged', () => {
  assert.equal(roBrainBlockReferencesRemovedTools('nothing relevant here'), false)
})

test('all four removed tool names are detected', () => {
  for (const tool of REMOVED_CONTROL_TOOLS) {
    assert.equal(
      roBrainBlockReferencesRemovedTools(`${MARK_START}\n${tool}(...)\n${MARK_END}`),
      true,
      `expected ${tool} to be flagged`,
    )
  }
})
