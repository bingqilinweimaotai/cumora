import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePairingEngine } from '../agents/computer/daemon.js'
import { runnableEngineIds, type EngineId } from '../agents/computer/engine.js'

test('installed Pi is reported as policy-disabled even when Codex is runnable (#289)', () => {
  const installed: EngineId[] = ['claude', 'codex', 'pi']
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const evaluated = { runnable: runnableEngineIds(installed, {}, platform), blocked: [] }
    assert.throws(() => validatePairingEngine('pi', installed, evaluated, platform), (error: Error) => {
      assert.match(error.message, /pi is installed but cannot run/)
      assert.match(error.message, /secure BYOA default/)
      assert.match(error.message, /CUMORA_BYOA_ALLOW_UNSANDBOXED/)
      assert.doesNotMatch(error.message, /not installed|not found on PATH/)
      return true
    })
  }
})

test('policy and capability refusals show compatibility instructions for the target platform', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const id of ['pi', 'claude'] as const) {
      const blocked = id === 'claude' ? [{ id, reason: 'version below secure minimum' }] : []
      assert.throws(() => validatePairingEngine(id, [id], { runnable: [], blocked }, platform), (error: Error) => {
        if (platform === 'win32') {
          assert.match(error.message, /PowerShell:/)
          assert.ok(error.message.includes("$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'"))
          assert.match(error.message, /rerun your original Cumora command in this PowerShell session/)
          assert.doesNotMatch(error.message, /CUMORA_BYOA_ALLOW_UNSANDBOXED=1 npx/)
        } else {
          assert.match(error.message, /CUMORA_BYOA_ALLOW_UNSANDBOXED=1 npx cumora@latest agent computer/)
          assert.doesNotMatch(error.message, /PowerShell|\$env:/)
        }
        return true
      })
    }
  }
})

test('Pi is diagnosed specifically even when no engine is runnable', () => {
  assert.throws(
    () => validatePairingEngine('pi', ['pi'], { runnable: [], blocked: [] }),
    /pi is installed but cannot run/,
  )
})

test('a missing requested engine lists the raw installed inventory', () => {
  assert.throws(
    () => validatePairingEngine('pi', ['claude', 'codex'], { runnable: ['codex'], blocked: [] }),
    /pi was not found on PATH\. Installed: claude, codex\./,
  )
  assert.throws(
    () => validatePairingEngine('pi', [], { runnable: [], blocked: [] }),
    /pi was not found on PATH\. Installed: none\./,
  )
})

test('a requested engine with an incompatible version reports its own reason', () => {
  const reason = 'version 2.1.199 is older than the secure minimum 2.1.248'
  assert.throws(
    () => validatePairingEngine('claude', ['claude', 'codex'], {
      runnable: ['codex'], blocked: [{ id: 'claude', reason }],
    }),
    (error: Error) => {
      assert.match(error.message, /claude is installed but cannot run/)
      assert.ok(error.message.includes(reason))
      return true
    },
  )
})

test('an unknown engine is rejected even with an empty inventory', () => {
  assert.throws(
    () => validatePairingEngine('unknown', [], { runnable: [], blocked: [] }),
    /--engine must be one of:/,
  )
})

test('secure Codex and explicitly opted-in Pi remain valid choices', () => {
  const installed: EngineId[] = ['codex', 'pi']
  assert.doesNotThrow(() => validatePairingEngine('codex', installed, {
    runnable: runnableEngineIds(installed, {}, 'win32'), blocked: [],
  }))
  assert.doesNotThrow(() => validatePairingEngine('pi', installed, {
    runnable: runnableEngineIds(installed, { CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }, 'win32'), blocked: [],
  }))
})
