/**
 * A synthetic wake that reached nobody is not a wake that happened.
 *
 * `message.new` is backed by the message row: an offline runtime finds it on
 * its next drain, so reporting success for an undelivered one is honest. Every
 * other reason carries its whole content in the wake payload — the scanner's
 * brief, an idle nudge, a manual poke — and that payload exists nowhere else.
 *
 * The scanner is built on this distinction already: on `false` it declines to
 * spend the activity fingerprint so the next pass can retry. When wakeOne
 * reported `true` for a BYOA daemon that was asleep, the scan was logged as
 * queued, the fingerprint was claimed, and the brief was never sent — and never
 * regenerated, because the fingerprint of that same activity is now spent.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { wakeAgent } from '../agents/scheduler.js'
import { _resetBackgroundScannerForTests, runBackgroundScans } from '../agents/scanner.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables(); await _resetBackgroundScannerForTests() })
after(async () => { await _resetBackgroundScannerForTests(); await teardownAll() })

/** A workspace whose scanner-capable agent has no runtime subscribed — the
 *  ordinary state of a BYOA agent whose laptop is asleep. */
async function seedSleepingScannerAgent(): Promise<{ companyId: string; agentId: string }> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const humanA = `u-${randomUUID().slice(0, 8)}`
  const humanB = `u-${randomUUID().slice(0, 8)}`
  const conversationId = `group-${randomUUID().slice(0, 8)}`

  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `Test ${companyId}`, companyId, humanA],
  )
  for (const userId of [humanA, humanB]) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, $3, 'free')`,
      [userId, `${userId}@test.local`, userId],
    )
    await pool.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'member')`,
      [companyId, userId],
    )
    await pool.query(
      `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'member', 'X', '#abcdef', 'avail')`,
      [userId, companyId, userId],
    )
  }
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, bio, tools, system_prompt)
     VALUES ($1, $2, 'agent', 'Scanner', 'Strategist', 'S', '#abcdef', 'avail', 'I watch.', $3::jsonb, 'You are Scanner.')`,
    [agentId, companyId, JSON.stringify(['bash', 'background.scan'])],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
     VALUES ($1, 'group', 'Campaign planning', $2::jsonb, 'team', $3)`,
    [conversationId, JSON.stringify([humanA, humanB]), companyId],
  )
  for (let i = 1; i <= 8; i++) {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [`m-${randomUUID()}`, conversationId, i % 2 === 0 ? humanA : humanB, `campaign note ${i}`, i, companyId],
    )
  }
  return { companyId, agentId }
}

test('[integration] an undelivered synthetic wake reports failure, an undelivered message wake does not', async () => {
  const { agentId } = await seedSleepingScannerAgent()

  const scan = await wakeAgent(agentId, 'background_scan', null, null, {
    backgroundBrief: { source: 'background_scanner', title: 'Recent company activity scan', body: 'the brief' },
  })
  assert.equal(scan, false, 'a scanner brief that reached no subscriber was reported as delivered')

  const idle = await wakeAgent(agentId, 'idle', null, null, { idleReason: 'nothing to do' })
  assert.equal(idle, false, 'an idle nudge that reached no subscriber was reported as delivered')

  // The message wake is genuinely durable: the row is in the inbox and the
  // daemon reads it on reconnect. This must keep reporting success, or every
  // offline BYOA agent starts looking like a delivery failure.
  const message = await wakeAgent(agentId, 'message.new', null)
  assert.equal(message, true, 'a message wake is durable in the inbox and must still report success')
})

test('[integration] the scanner keeps the scan for when the daemon is back', async () => {
  const { agentId } = await seedSleepingScannerAgent()

  await runBackgroundScans()

  const logged = await pool.query<{ body: string }>(
    `SELECT body FROM agent_log WHERE agent_id = $1`, [agentId],
  )
  assert.equal(
    logged.rowCount, 0,
    `the scan was recorded as queued although nothing received it: ${JSON.stringify(logged.rows)}`,
  )

  // And it is still owed: the fingerprint was not spent, so the very next pass
  // over the same activity tries again. Before the fix this second pass was a
  // no-op and the brief was gone for good.
  const wakes: string[] = []
  const { __setBackgroundScannerWakeForTesting } = await import('../agents/scanner.js')
  __setBackgroundScannerWakeForTesting(async (id) => { wakes.push(id); return true })
  await runBackgroundScans()

  assert.deepEqual(wakes, [agentId], 'the scan was not retried once a runtime was listening')
  const after = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_log WHERE agent_id = $1`, [agentId],
  )
  assert.equal(after.rows[0].n, 1, 'the delivered scan should be recorded exactly once')
})
