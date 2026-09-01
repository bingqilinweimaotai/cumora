import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

const OWNER_ID = 'u-workspace-owner'
const TARGET_ID = 'u-workspace-target'
let ownerServer: Server
let targetServer: Server
let ownerBase = ''
let targetBase = ''

async function listenFor(userId: string): Promise<{ server: Server; base: string }> {
  const app = await buildApiTestApp(userId)
  return new Promise((resolve) => {
    const server = createServer(app).listen(0, () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve({ server, base: `http://127.0.0.1:${address.port}` })
    })
  })
}

before(async () => {
  await ensureSchemaOnce()
  const owner = await listenFor(OWNER_ID)
  ownerServer = owner.server
  ownerBase = owner.base
  const target = await listenFor(TARGET_ID)
  targetServer = target.server
  targetBase = target.base
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  if (ownerServer?.listening) await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  await teardownAll(targetServer)
})

async function seedUser(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, $3, 'pro')`,
    [userId, `${userId}@test.local`, userId],
  )
}

async function seedCompany(companyId: string, ownerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, $2, $3, $4)`,
    [companyId, `Workspace ${companyId}`, companyId, ownerId],
  )
}

async function seedMember(
  companyId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])
  if (!exists.rows[0]) await seedUser(userId)
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3)`,
    [companyId, userId, role],
  )
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, NULL, $4, '#abcdef', 'avail')`,
    [userId, companyId, userId, userId.charAt(0).toUpperCase()],
  )
}

async function seedOwnedWorkspace(companyId = 'co-managed'): Promise<void> {
  await seedUser(OWNER_ID)
  await seedCompany(companyId, OWNER_ID)
  await seedMember(companyId, OWNER_ID, 'owner')
}

function companyHeaders(companyId: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-company-id': companyId }
}

test('[integration] owner lists members and changes a member role', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')

  const list = await fetch(`${ownerBase}/api/companies/co-managed/members`, {
    headers: companyHeaders('co-managed'),
  })
  assert.equal(list.status, 200)
  const members = await list.json() as Array<{ id: string; role: string; email: string }>
  assert.deepEqual(members.map((row) => [row.id, row.role]), [
    [OWNER_ID, 'owner'],
    [TARGET_ID, 'member'],
  ])
  assert.equal(members[1].email, `${TARGET_ID}@test.local`)

  const update = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-managed'), body: JSON.stringify({ role: 'admin' }),
  })
  assert.equal(update.status, 200)
  const stored = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = 'co-managed' AND user_id = $1`,
    [TARGET_ID],
  )
  assert.equal(stored.rows[0].role, 'admin')
})

test('[integration] admin cannot change roles or remove another admin', async () => {
  const realOwner = 'u-real-owner'
  await seedUser(realOwner)
  await seedCompany('co-admin', realOwner)
  await seedMember('co-admin', realOwner, 'owner')
  await seedMember('co-admin', OWNER_ID, 'admin')
  await seedMember('co-admin', TARGET_ID, 'admin')

  const update = await fetch(`${ownerBase}/api/companies/co-admin/members/${TARGET_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-admin'), body: JSON.stringify({ role: 'member' }),
  })
  assert.equal(update.status, 403)

  const remove = await fetch(`${ownerBase}/api/companies/co-admin/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-admin'),
  })
  assert.equal(remove.status, 403)
})

test('[integration] removing a member revokes tenant and conversation access atomically', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ('room-managed', 'group', 'Managed room', $1::jsonb, 'co-managed')`,
    [JSON.stringify([OWNER_ID, TARGET_ID])],
  )

  const remove = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 200)

  const membership = await pool.query(
    `SELECT 1 FROM company_members WHERE company_id = 'co-managed' AND user_id = $1`, [TARGET_ID],
  )
  assert.equal(membership.rowCount, 0)
  const participant = await pool.query<{ departed_at: Date | null }>(
    `SELECT departed_at FROM participants WHERE company_id = 'co-managed' AND id = $1`, [TARGET_ID],
  )
  assert.ok(participant.rows[0].departed_at)
  const conversation = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'room-managed'`,
  )
  assert.deepEqual(conversation.rows[0].members, [OWNER_ID])

  const denied = await fetch(`${targetBase}/api/participants`, {
    headers: companyHeaders('co-managed'),
  })
  assert.equal(denied.status, 403)
})

test('[integration] a removed member can accept a new invite and becomes active again', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')
  const remove = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 200)

  const rawToken = 'workspace-reinvite-token'
  const tokenHash = createHash('sha256').update(rawToken).digest('base64url')
  await pool.query(
    `INSERT INTO company_invitations
       (token_hash, company_id, invited_by, email, role, max_uses, expires_at)
     VALUES ($1, 'co-managed', $2, $3, 'member', 1, NOW() + INTERVAL '1 day')`,
    [tokenHash, OWNER_ID, `${TARGET_ID}@test.local`],
  )

  const accept = await fetch(`${targetBase}/api/invitations/${rawToken}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(accept.status, 200)
  const participant = await pool.query<{ departed_at: Date | null; status: string }>(
    `SELECT departed_at, status FROM participants WHERE company_id = 'co-managed' AND id = $1`,
    [TARGET_ID],
  )
  assert.equal(participant.rows[0].departed_at, null)
  assert.equal(participant.rows[0].status, 'avail')
})

test('[integration] owner cannot delete their only workspace', async () => {
  await seedOwnedWorkspace()
  const response = await fetch(`${ownerBase}/api/companies/co-managed`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
    body: JSON.stringify({ confirmation: 'Workspace co-managed' }),
  })
  assert.equal(response.status, 409)
  const company = await pool.query(`SELECT 1 FROM companies WHERE id = 'co-managed'`)
  assert.equal(company.rowCount, 1)
})

test('[integration] workspace deletion purges FK-backed and legacy soft-scoped data', async () => {
  await seedOwnedWorkspace()
  await seedCompany('co-alternative', OWNER_ID)
  await seedMember('co-alternative', OWNER_ID, 'owner')
  await seedMember('co-managed', TARGET_ID, 'member')
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ('agent-managed', 'co-managed', 'agent', 'Managed agent', 'ops', 'M', '#abcdef', 'avail', 'test')`,
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ('room-managed', 'group', 'Managed room', $1::jsonb, 'co-managed')`,
    [JSON.stringify([OWNER_ID, TARGET_ID, 'agent-managed'])],
  )
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ('msg-managed', 'room-managed', $1, 'text', 'history', 1, 'co-managed')`,
    [TARGET_ID],
  )
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ('doc-managed', 'co-managed', 'Managed doc', $1)`, [OWNER_ID],
  )
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind)
     VALUES ('computer-managed', 'co-managed', 'Managed computer', 'local')`,
  )
  await pool.query(
    `INSERT INTO agent_runs (id, agent_id, company_id)
     VALUES ('run-managed', 'agent-managed', 'co-managed')`,
  )
  await pool.query(
    `INSERT INTO boards (id, company_id, title, created_by)
     VALUES ('board-managed', 'co-managed', 'Managed board', $1)`, [OWNER_ID],
  )

  const response = await fetch(`${ownerBase}/api/companies/co-managed`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
    body: JSON.stringify({ confirmation: 'Workspace co-managed' }),
  })
  assert.equal(response.status, 200, await response.text())

  for (const [table, predicate] of [
    ['companies', `id = 'co-managed'`],
    ['company_members', `company_id = 'co-managed'`],
    ['participants', `company_id = 'co-managed'`],
    ['conversations', `company_id = 'co-managed'`],
    ['messages', `company_id = 'co-managed'`],
    ['documents', `company_id = 'co-managed'`],
    ['computers', `company_id = 'co-managed'`],
    ['agent_runs', `company_id = 'co-managed'`],
    ['boards', `company_id = 'co-managed'`],
  ] as const) {
    const remaining = await pool.query(`SELECT 1 FROM ${table} WHERE ${predicate}`)
    assert.equal(remaining.rowCount, 0, `${table} retained workspace rows`)
  }
  const alternative = await pool.query(`SELECT 1 FROM companies WHERE id = 'co-alternative'`)
  assert.equal(alternative.rowCount, 1)
})
