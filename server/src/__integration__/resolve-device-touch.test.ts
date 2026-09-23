/** resolveDevice used to UPDATE computers.last_seen_at on every device-token
 *  request — ~10% of production DB time at fleet scale for a column only read
 *  at 90s granularity. It now writes at most once per RESOLVE_DEVICE_TOUCH_MS
 *  per token and reads in between; revocation must still bite immediately. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import {
  issuePairingCode,
  pairComputer,
  resetDeviceTouches,
  resolveDevice,
  revokeComputer,
} from '../agents/computer/registry.js'
import { ensureSchemaOnce, seedCompanyWithAgent, teardownAll } from './_helpers.js'

async function lastSeen(computerId: string): Promise<string> {
  const { rows } = await pool.query<{ last_seen_at: string }>(
    `SELECT last_seen_at::text FROM computers WHERE id = $1`, [computerId],
  )
  return rows[0]?.last_seen_at ?? ''
}

async function pairFresh(): Promise<{ computerId: string; companyId: string; deviceToken: string }> {
  const { companyId } = await seedCompanyWithAgent()
  const { code } = await issuePairingCode({ companyId, ownerUserId: 'test-owner' })
  const paired = await pairComputer({ code, hostName: 'touch-test', engines: ['claude'], deferBroadcast: true })
  assert.ok(paired)
  return paired
}

before(async () => { await ensureSchemaOnce() })
after(async () => { await teardownAll() })

test('[integration] resolveDevice bumps last_seen_at once per window, not per request', async () => {
  resetDeviceTouches()
  const { computerId, companyId, deviceToken } = await pairFresh()
  // Age the row so the first resolve visibly moves it.
  await pool.query(`UPDATE computers SET last_seen_at = NOW() - interval '1 hour' WHERE id = $1`, [computerId])
  const aged = await lastSeen(computerId)

  const first = await resolveDevice(deviceToken)
  assert.deepEqual(first, { computerId, companyId })
  const afterFirst = await lastSeen(computerId)
  assert.notEqual(afterFirst, aged, 'first resolve in the window writes')

  // Age it again: a second resolve inside the window must NOT touch the row.
  await pool.query(`UPDATE computers SET last_seen_at = NOW() - interval '1 hour' WHERE id = $1`, [computerId])
  const agedAgain = await lastSeen(computerId)
  const second = await resolveDevice(deviceToken)
  assert.deepEqual(second, { computerId, companyId }, 'read path still resolves the computer')
  assert.equal(await lastSeen(computerId), agedAgain, 'second resolve in the window is a read')

  // Window expired (simulated by forgetting the memo): the next resolve writes.
  resetDeviceTouches()
  await resolveDevice(deviceToken)
  assert.notEqual(await lastSeen(computerId), agedAgain, 'resolve after the window writes again')
})

test('[integration] a revoked device is rejected on the very next request, even inside the window', async () => {
  resetDeviceTouches()
  const { computerId, companyId, deviceToken } = await pairFresh()
  assert.ok(await resolveDevice(deviceToken), 'primes the memo')
  assert.equal(await revokeComputer({ computerId, companyId }), true)
  assert.equal(await resolveDevice(deviceToken), null)
})

test('[integration] an unknown token never resolves and never writes', async () => {
  resetDeviceTouches()
  assert.equal(await resolveDevice('not-a-real-device-token'), null)
  assert.equal(await resolveDevice('not-a-real-device-token'), null)
})
