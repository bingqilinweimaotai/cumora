import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

after(async () => { await teardownAll() })

test('[integration] reset clears related rows and preserves migration history', async () => {
  await resetAllTables()
  await seedCompanyWithAgent()
  const migrations = await pool.query('SELECT * FROM schema_migrations ORDER BY version')

  await resetAllTables()

  for (const table of ['companies', 'participants']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${table}`)
    assert.equal(rows[0].count, 0)
  }
  assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows, migrations.rows)
})

test('[integration] reset tolerates missing tables in partial schemas', async () => {
  await resetAllTables()
  await seedCompanyWithAgent()
  await pool.query('ALTER TABLE shipping_regressions RENAME TO harness_reset_saved_regressions')
  try {
    await resetAllTables()
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM companies')
    assert.equal(rows[0].count, 0)
  } finally {
    await pool.query('ALTER TABLE harness_reset_saved_regressions RENAME TO shipping_regressions')
  }
})

test('[integration] reset propagates cleanup errors instead of leaving stale data silently', async (t) => {
  const originalQuery = pool.query.bind(pool)
  const failure = new Error('simulated cleanup failure')
  t.mock.method(pool, 'query', (...args: Parameters<typeof pool.query>) => {
    if (typeof args[0] === 'string' && args[0].startsWith('TRUNCATE TABLE')) throw failure
    return originalQuery(...args)
  })
  await assert.rejects(resetAllTables(), failure)
})
