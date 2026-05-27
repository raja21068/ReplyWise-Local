/**
 * Scheduler — dispatches scheduled outgoing messages.
 *
 * Today, when the decision engine says "wait 30 minutes," the user has no way
 * to actually queue that reply for later. They either ignore the advice or
 * set a phone timer.
 *
 * This module closes the loop:
 *   1. User reviews a suggestion and clicks "Schedule for 30 min"
 *   2. POST /api/suggestions/:id/schedule writes { scheduled_at } to the row
 *      AND marks status = 'scheduled' (so the bridge does NOT pick it up yet)
 *   3. Every SCHEDULER_TICK_MS, this module scans the queue for
 *      `scheduled_at <= now()` and flips them to status 'queued', at which
 *      point the existing agent polling loop sends them normally
 *
 * No new agent code is required — the scheduler is a "delayed flip" mechanism
 * that respects the existing sendMessage path, including:
 *   • Per-contact reply delay (instant/normal/random)
 *   • Auto-send safety gates
 *   • Human approval requirements
 *
 * Environment variables:
 *   SCHEDULER_ENABLED=true       — master switch
 *   SCHEDULER_TICK_MS=30000      — how often to check (default 30 s)
 *   SCHEDULER_MAX_DELAY_HOURS=24 — refuse schedules longer than this
 */

'use strict';

const bus = require('../realtime/event-bus');

const ENABLED         = process.env.SCHEDULER_ENABLED !== 'false';
const TICK_MS         = Number(process.env.SCHEDULER_TICK_MS || 30_000);
const MAX_DELAY_HOURS = Number(process.env.SCHEDULER_MAX_DELAY_HOURS || 24);

let _timer  = null;
let _db     = null;

// ── Public API ────────────────────────────────────────────────

/**
 * Start the scheduler. Idempotent — safe to call multiple times.
 * Typically called once from server.js after db is wired up.
 */
function start(db) {
  _db = db;
  if (!ENABLED) {
    console.log('[scheduler] disabled via SCHEDULER_ENABLED=false');
    return;
  }
  if (_timer) return;
  _timer = setInterval(() => tick().catch((e) => {
    console.warn('[scheduler] tick error:', e.message);
  }), TICK_MS);
  // Run one immediately so schedule-then-restart works
  tick().catch(() => {});
  console.log(`[scheduler] started, tick every ${TICK_MS}ms`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Schedule an existing outgoing-queue row for future delivery.
 *
 * @param {string} queueId
 * @param {number} delayMinutes
 * @returns {Promise<{ok: boolean, scheduledAt: string}>}
 */
async function scheduleOutgoing(queueId, delayMinutes) {
  if (!_db) throw new Error('scheduler not started — call scheduler.start(db) first');
  const minutes = Math.max(0, Math.min(MAX_DELAY_HOURS * 60, Number(delayMinutes) || 0));
  const scheduledAt = new Date(Date.now() + minutes * 60_000).toISOString();

  const store = await _db._readStore();
  const row = (store.outgoing_queue || []).find((q) => q.id === queueId);
  if (!row) throw new Error(`outgoing queue item not found: ${queueId}`);

  row.scheduled_at = scheduledAt;
  row.status       = 'scheduled';
  row.updated_at   = new Date().toISOString();
  await _db._writeStore(store);

  bus.emit('schedule.created', {
    queueId, contactId: row.contact_id, scheduledAt, delayMinutes: minutes,
  });

  return { ok: true, scheduledAt, delayMinutes: minutes };
}

/**
 * Cancel a scheduled send before it fires.
 */
async function cancelScheduled(queueId) {
  if (!_db) throw new Error('scheduler not started');
  const store = await _db._readStore();
  const row = (store.outgoing_queue || []).find((q) => q.id === queueId);
  if (!row) throw new Error(`outgoing queue item not found: ${queueId}`);
  if (row.status !== 'scheduled') {
    return { ok: false, reason: `cannot cancel — status is ${row.status}` };
  }
  row.status     = 'cancelled';
  row.updated_at = new Date().toISOString();
  await _db._writeStore(store);
  bus.emit('schedule.cancelled', { queueId, contactId: row.contact_id });
  return { ok: true };
}

/**
 * List scheduled-but-not-yet-fired items, sorted by next-to-fire.
 */
async function listScheduled() {
  if (!_db) return [];
  const store = await _db._readStore();
  return (store.outgoing_queue || [])
    .filter((q) => q.status === 'scheduled' && q.scheduled_at)
    .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
}

// ── Internal: tick handler ───────────────────────────────────

async function tick() {
  if (!_db) return;
  const now = Date.now();
  const store = await _db._readStore();
  if (!Array.isArray(store.outgoing_queue)) return;

  let fired = 0;
  for (const row of store.outgoing_queue) {
    if (row.status !== 'scheduled') continue;
    if (!row.scheduled_at) continue;
    const dueAt = new Date(row.scheduled_at).getTime();
    if (Number.isNaN(dueAt) || dueAt > now) continue;

    // Fire: flip status so the agent polling loop picks it up
    row.status     = 'queued';
    row.fired_at   = new Date().toISOString();
    row.updated_at = row.fired_at;
    fired++;

    bus.emit('schedule.fired', {
      queueId: row.id,
      contactId: row.contact_id,
      scheduledAt: row.scheduled_at,
      bridge: row.bridge,
    });
  }

  if (fired > 0) {
    await _db._writeStore(store);
    console.log(`[scheduler] fired ${fired} scheduled send(s)`);
  }
}

module.exports = {
  start,
  stop,
  scheduleOutgoing,
  cancelScheduled,
  listScheduled,
};
