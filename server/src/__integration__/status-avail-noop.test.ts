/** setStatus('avail') on an already-avail participant must be a no-op: no row
 *  write, no broadcast. Every BYOA daemon posts avail at the end of every idle
 *  poll tick, so at fleet scale the redundant write + Redis fan-out was a
 *  measurable share of production DB time. Busy statuses keep writing on
 *  repeat because their status_updated_at is a lease. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { setStatus } from '../status.js'
import { ensureSchemaOnce, seedCompanyWithAgent, teardownAll } from './_helpers.js'

async function statusRow(agentId: string): Promise<{ status: string; at: string }> {
  const { rows } = await pool.query<{ status: string; at: string }>(
    `SELECT status, status_updated_at::text AS at FROM participants WHERE id = $1`, [agentId],
  )
  return rows[0]
}

before(async () => { await ensureSchemaOnce() })
after(async () => { await teardownAll() })

test('[integration] re-asserting avail on an avail participant does not touch the row', async () => {
  const { agentId } = await seedCompanyWithAgent()
  await setStatus(agentId, 'avail')
  await pool.query(`UPDATE participants SET status_updated_at = NOW() - interval '1 hour' WHERE id = $1`, [agentId])
  const initial = await statusRow(agentId)
  assert.equal(initial.status, 'avail')

  await setStatus(agentId, 'avail')
  assert.deepEqual(await statusRow(agentId), initial, 'avail → avail wrote the row')
})

test('[integration] a real transition to avail still writes and stamps the row', async () => {
  const { agentId } = await seedCompanyWithAgent()
  await setStatus(agentId, 'thinking')
  await pool.query(`UPDATE participants SET status_updated_at = NOW() - interval '1 hour' WHERE id = $1`, [agentId])
  const busy = await statusRow(agentId)
  assert.equal(busy.status, 'thinking')

  await setStatus(agentId, 'avail')
  const landed = await statusRow(agentId)
  assert.equal(landed.status, 'avail')
  assert.notEqual(landed.at, busy.at, 'thinking → avail did not stamp status_updated_at')
})

test('[integration] repeating a busy status renews its lease', async () => {
  const { agentId } = await seedCompanyWithAgent()
  await setStatus(agentId, 'working')
  await pool.query(`UPDATE participants SET status_updated_at = NOW() - interval '1 hour' WHERE id = $1`, [agentId])
  const stale = await statusRow(agentId)

  await setStatus(agentId, 'working')
  const renewed = await statusRow(agentId)
  assert.equal(renewed.status, 'working')
  assert.notEqual(renewed.at, stale.at, 'working → working must renew the lease')
})
