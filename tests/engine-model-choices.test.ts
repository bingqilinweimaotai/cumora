import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineModelChoices } from '../src/lib/engine-model-choices.ts'

const labels = { follow: 'Follow engine default', recommended: 'Recommended' }

const catalog = {
  models: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', recommendedFor: ['big' as const] },
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', recommendedFor: ['small' as const] },
  ],
  defaultModel: 'claude-sonnet-4-5',
  defaultFastModel: 'claude-haiku-4-5',
}

test('first row is the empty value, hinted with the tier default it falls back to', () => {
  const big = engineModelChoices(catalog, 'big', labels)
  const small = engineModelChoices(catalog, 'small', labels)
  assert.deepEqual(big[0], { value: '', label: 'Follow engine default', hint: 'claude-sonnet-4-5' })
  assert.deepEqual(small[0], { value: '', label: 'Follow engine default', hint: 'claude-haiku-4-5' })
})

test('catalog models follow the follow row, with the id as hint only when the label differs', () => {
  const options = engineModelChoices(catalog, 'big', labels)
  assert.deepEqual(options.slice(1), [
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: 'claude-sonnet-4-5 · Recommended' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', hint: undefined },
  ])
})

test('recommended marker follows the tier being configured', () => {
  const small = engineModelChoices(catalog, 'small', labels)
  assert.equal(small[2].hint, 'Recommended')
  assert.equal(small[1].hint, 'claude-sonnet-4-5')
})

test('no catalog still yields the follow row so the picker can offer custom ids', () => {
  assert.deepEqual(engineModelChoices(undefined, 'big', labels), [
    { value: '', label: 'Follow engine default', hint: undefined },
  ])
})
