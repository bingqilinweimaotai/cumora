/**
 * Runtime engine selection must use the daemon's current PATH inventory, not
 * the snapshot captured when the process started.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  replaceEngineInventory,
  resolveAvailableEngine,
  type EngineInventory,
} from '../agents/computer/daemon.js'

test('a newly detected requested engine is selected without a daemon restart', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, ['claude', 'cursor']), true)
  assert.equal(resolveAvailableEngine('cursor', inventory.current), 'cursor')
})

test('no installed engines leaves the agent without a runnable fallback', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, []), true)
  assert.equal(resolveAvailableEngine('claude', inventory.current), null)
})

test('an unchanged scan does not replace the shared inventory', () => {
  const current = ['claude', 'codex'] as const
  const inventory: EngineInventory = { current: [...current] }
  const before = inventory.current

  assert.equal(replaceEngineInventory(inventory, current), false)
  assert.equal(inventory.current, before)
})
