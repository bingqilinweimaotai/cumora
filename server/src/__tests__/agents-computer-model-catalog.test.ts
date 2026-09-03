/**
 * Generic BYOA model-catalog parsing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-model-catalog.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseListedModels } from '../agents/computer/model-catalog.js'

test('OpenCode catalog keeps provider-qualified model ids and deduplicates them', () => {
  assert.deepEqual(
    parseListedModels('anthropic/claude-sonnet-4-6\nopenai/gpt-5.5\nanthropic/claude-sonnet-4-6\n', 'provider'),
    [
      { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6', description: null, recommendedFor: undefined },
      { id: 'openai/gpt-5.5', label: 'openai/gpt-5.5', description: null, recommendedFor: undefined },
    ],
  )
})

test('pi catalog accepts provider/model output and a provider plus model table', () => {
  const out = parseListedModels(
    'Provider Model Context\nanthropic claude-sonnet-4-6 200k\nopenai/gpt-5.5:high\n',
    'pi',
  )
  assert.deepEqual(out.map((model) => model.id), [
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.5:high',
  ])
})

test('Cursor catalog accepts bullets and ignores headings', () => {
  const out = parseListedModels('Available models\n* auto\n- claude-4.6-sonnet\n  gpt-5.5\n', 'cursor')
  assert.deepEqual(out.map((model) => model.id), ['auto', 'claude-4.6-sonnet', 'gpt-5.5'])
})
