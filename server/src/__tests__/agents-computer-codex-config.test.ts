/**
 * What Cumora sends codex as its sandbox profile, and what it says when the
 * installed codex refuses it.
 *
 * On 2026-09-01 every codex turn in 103 workspaces (299 agents) failed for six
 * hours. Production carried two distinct rejections:
 *   78,445 × unknown configuration field `projects."<agent home>"`
 *    8,372 × invalid type: string "{:minimal=read,:workspace_roots={.=write}}",
 *            expected struct FilesystemPermissionsToml in `permissions`
 * The first is a field codex does not have; it aborted codex before startup, so
 * it never restricted anything and is gone. The second was cmd.exe eating the
 * quotes inside an inline TOML table and is fixed separately (resolveCodexSpawn).
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-codex-config.test.ts
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const {
  noteCodexConfigRejection, codexProfileIsRejected, resetCodexProfileRejection,
} = await import('../agents/computer/engine.js')

afterEach(() => { resetCodexProfileRejection() })

test('the exact production rejections are recognised', () => {
  const seen: string[] = []
  const real = 'local codex failed (exit 1): process exited with code 1 Error loading config.toml: unknown configuration field `projects."<agent home>"` in -c/--config override'
  assert.equal(noteCodexConfigRejection(real, (l) => seen.push(l)), true)
  assert.equal(codexProfileIsRejected(), true)
  // Name Cumora as the author — the raw codex error never does, which is why
  // this took six hours to reach.
  assert.match(seen[0] ?? '', /Cumora passes via -c/)
  // Give the operator a way out, not just a diagnosis.
  assert.match(seen[0] ?? '', /CUMORA_BYOA_ALLOW_UNSANDBOXED=1/)
  // And keep what codex actually said, or there is nothing to report upstream.
  assert.match(seen[0] ?? '', /unknown configuration field/)
})

test('the inline-table type error is recognised too', () => {
  const real = 'Error loading config.toml: invalid type: string "{:minimal=read,:workspace_roots={.=write}}", expected struct FilesystemPermissionsToml in `permissions`'
  assert.equal(noteCodexConfigRejection(real, () => {}), true)
})

test('it says this once per daemon, not once per failed turn', () => {
  const seen: string[] = []
  const err = 'Error loading config.toml: unknown configuration field `projects."x"`'
  assert.equal(noteCodexConfigRejection(err, (l) => seen.push(l)), true)
  assert.equal(noteCodexConfigRejection(err, (l) => seen.push(l)), false)
  assert.equal(seen.length, 1, 'a 20k-failures-per-hour loop must not log 20k times')
})

test('ordinary engine failures are left alone', () => {
  for (const err of [
    undefined,
    '',
    'local codex failed (exit 1): Not logged in · Please run /login',
    'local codex failed (exit 126): No version is set for command codex',
    'engine turn error (error_during_execution): see log',
  ]) {
    assert.equal(noteCodexConfigRejection(err, () => {}), false, `should ignore: ${err}`)
    assert.equal(codexProfileIsRejected(), false)
  }
})
