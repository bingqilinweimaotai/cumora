/**
 * The BYOA daemon's 20s fallback inbox drain exists for ONE reason: a wake-stream
 * can be severed silently (the server writes onto a half-dead socket and counts
 * the wake delivered), so a live wake is lost until the daemon notices. But
 * draining on every tick, on every agent, whether or not the stream is fine, is
 * a loadInbox against Postgres per agent per 20s — with thousands of idle
 * agents that alone pegged the production database.
 *
 * fallbackPollDue is the gate: drain at the old cadence only while the stream
 * is NOT provably alive (never connected, disconnected, or silent past the
 * server's `: ping` keepalive), and otherwise only as a slow double-check.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-fallback-poll.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackPollDue } from '../agents/computer/daemon.js'

const STALE = 75_000
const HEALTHY = 120_000
const base = { staleMs: STALE, healthyIntervalMs: HEALTHY }

test('fallbackPollDue: never-connected stream → every tick drains', () => {
  assert.equal(fallbackPollDue({ ...base, now: 1_000, streamLastSeenAt: null, lastInboxDrainAt: 1_000 }), true)
  assert.equal(fallbackPollDue({ ...base, now: 21_000, streamLastSeenAt: null, lastInboxDrainAt: 1_000 }), true)
})

test('fallbackPollDue: a stream that just proved alive → tick is a no-op', () => {
  const now = 1_000_000
  assert.equal(fallbackPollDue({ ...base, now, streamLastSeenAt: now - 5_000, lastInboxDrainAt: now - 20_000 }), false)
  // A ping within the stale window still counts as alive right up to the edge.
  assert.equal(fallbackPollDue({ ...base, now, streamLastSeenAt: now - (STALE - 1), lastInboxDrainAt: now - 20_000 }), false)
})

test('fallbackPollDue: silent for the stale window → drains again', () => {
  const now = 1_000_000
  assert.equal(fallbackPollDue({ ...base, now, streamLastSeenAt: now - STALE, lastInboxDrainAt: now - 20_000 }), true)
})

test('fallbackPollDue: healthy stream still gets the slow double-check', () => {
  const now = 1_000_000
  assert.equal(fallbackPollDue({ ...base, now, streamLastSeenAt: now - 1_000, lastInboxDrainAt: now - (HEALTHY - 1) }), false)
  assert.equal(fallbackPollDue({ ...base, now, streamLastSeenAt: now - 1_000, lastInboxDrainAt: now - HEALTHY }), true)
})

test('fallbackPollDue: a fresh runner (no drain yet) drains on its first healthy tick', () => {
  // lastInboxDrainAt starts at 0, so the first tick after connect is due even
  // though the stream is alive — the connect's own catch-up normally lands
  // first and moves the anchor; if it did not, this is the safety net.
  assert.equal(fallbackPollDue({ ...base, now: 200_000, streamLastSeenAt: 199_000, lastInboxDrainAt: 0 }), true)
})

test('fallbackPollDue: defaults are the production constants', () => {
  const now = 1_000_000
  // 74s of silence is still alive; 75s is not.
  assert.equal(fallbackPollDue({ now, streamLastSeenAt: now - 74_000, lastInboxDrainAt: now }), false)
  assert.equal(fallbackPollDue({ now, streamLastSeenAt: now - 75_000, lastInboxDrainAt: now }), true)
  // 119s since the last drain on a live stream is not due; 120s is.
  assert.equal(fallbackPollDue({ now, streamLastSeenAt: now, lastInboxDrainAt: now - 119_000 }), false)
  assert.equal(fallbackPollDue({ now, streamLastSeenAt: now, lastInboxDrainAt: now - 120_000 }), true)
})
