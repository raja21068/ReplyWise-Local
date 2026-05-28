require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const db = require('./db');
const ai = require('./ai');
const { evaluateAutopilot } = require('./brain/autopilot-engine');
const { assertHumanApproval, cleanSuggestionText, isSystemInstructionText } = require('./safety/guardrails');
const plugins = require('./plugins');
const memory   = require('./memory');
const { callTools } = require('./ai/tool-caller');
const { normalizeMediaType } = require('./brain/decision-engine');

// ── v6 additions ──────────────────────────────────────────────
const bus               = require('./realtime/event-bus');
const preferenceLearner = require('./learning/preference-learner');
const scheduler         = require('./schedule/scheduler');
const transcribe        = require('./media/transcribe');

const app = express();
const port = Number(process.env.PORT || 3000);

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function screenshotsEnabled() {
  return boolEnv('SCREENSHOT_ON_ERROR', false) || boolEnv('ENABLE_LIVE_SCREENSHOTS', false);
}

function dashboardChannels(envValue = process.env.ENABLED_AGENTS || 'whatsapp,telegram') {
  const raw = String(envValue || 'whatsapp,telegram').split(',').map(s => s.trim()).filter(Boolean);
  const normalized = raw.map(ch => {
    try { return db.normalizeChannel(ch); } catch { return String(ch || '').toLowerCase(); }
  });
  const set = new Set(['whatsapp', 'telegram']);
  for (const ch of normalized) {
    if (['whatsapp', 'telegram', 'wechat'].includes(ch)) set.add(ch);
  }
  // Keep WeChat visible when the package supports it, but treat it as experimental.
  if (boolEnv('SHOW_EXPERIMENTAL_WECHAT', true)) set.add('wechat');
  return [...set];
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));

// ═══════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════

app.get('/', async (req, res, next) => {
  try {
    const state = await buildDashboardState(req.query.contactId);
    res.send(renderDashboard(state));
  } catch (err) { next(err); }
});

app.get('/api/dashboard/state', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await buildDashboardState(req.query.contactId)) });
  } catch (err) { next(err); }
});

app.get('/api/contacts/:id/messages', async (req, res, next) => {
  try {
    res.json({ ok: true, messages: await db.getRecentMessages(req.params.id, Number(req.query.limit || 80)) });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Ingest API — browser agents POST incoming text here
// ═══════════════════════════════════════════════════════════

app.post('/api/ingest/:channel', async (req, res, next) => {
  try {
    const result = await processIncomingMessageQueued({
      channel: req.params.channel,
      externalContactId: req.body.from || req.body.externalContactId || req.body.contactId,
      displayName: req.body.displayName,
      body: req.body.body,
      timestamp: req.body.timestamp,
      media_type: req.body.media_type,
      media_summary: req.body.media_summary,
      is_group: req.body.is_group || false,
      author: req.body.author || null,
      mentioned_me: req.body.mentioned_me || req.body.mentions_me || false,
      reply_to_me: req.body.reply_to_me || req.body.quoted_from_me || false,
      is_forwarded: req.body.is_forwarded || false,
      is_starred: req.body.is_starred || false,
      local_media_path: req.body.local_media_path || null,
      metadata: { source: `${req.params.channel}-browser-agent`, raw: req.body },
    });
    res.json({ ok: true, suggestionId: result.suggestion.id, decision: result.result.decision, automation: result.result.automation, autoSent: result.autoSent || false });
  } catch (err) { next(err); }
});

// Local sandbox test. No real agent required.
app.post('/api/sandbox/:channel/incoming', async (req, res, next) => {
  try {
    const channel = db.assertSupportedChannel(req.params.channel);
    const result = await processIncomingMessageQueued({
      channel,
      externalContactId: req.body.externalContactId || req.body.contactId,
      displayName: req.body.displayName,
      body: req.body.body,
      media_type: req.body.media_type,
      media_summary: req.body.media_summary,
      is_group: req.body.is_group || false,
      author: req.body.author || null,
      mentioned_me: req.body.mentioned_me || false,
      reply_to_me: req.body.reply_to_me || false,
      metadata: { source: `${channel}_sandbox_ui` },
    });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, suggestionId: result.suggestion.id, decision: result.result.decision, automation: result.result.automation, autoSent: result.autoSent || false });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Suggestion actions — send, wait, skip
// ═══════════════════════════════════════════════════════════

app.post('/api/suggestions/:id/approve', async (req, res, next) => {
  try {
    assertHumanApproval();
    const chosenText = cleanSuggestionText(req.body.chosenText);
    if (!chosenText) throw new Error('chosenText is required');
    if (isSystemInstructionText(chosenText)) throw new Error('This option is an instruction, not a message. Choose Wait/Skip instead.');

    // Fetch the suggestion BEFORE approval so we have the options list for feedback
    const before = await db.getSuggestionById(req.params.id);

    await db.approveSuggestion({ suggestionId: req.params.id, chosenText, bridge: req.body.bridge });

    // ── v6: record feedback for the preference learner ─────────
    if (before?.contactId || before?.contact_id) {
      preferenceLearner.recordFeedback(db, {
        contactId:    before.contactId || before.contact_id,
        suggestionId: req.params.id,
        suggestion:   before,
        chosenText,
        source:       'manual_approval',
      }).catch(() => {});
    }

    bus.emit('suggestion.approved', { suggestionId: req.params.id, chosenText });

    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/suggestions/:id/send-auto-choice', async (req, res, next) => {
  try {
    assertHumanApproval();
    const suggestion = await db.getSuggestionById(req.params.id);
    const chosenText = cleanSuggestionText(suggestion?.recommendedText || suggestion?.recommended_text);
    if (!chosenText) throw new Error('No auto-chosen reply is available for this suggestion.');
    if (isSystemInstructionText(chosenText)) throw new Error('Auto-chosen item is an instruction, not a sendable message.');
    await db.approveSuggestion({
      suggestionId: req.params.id,
      chosenText,
      bridge: req.body.bridge,
      source: 'manual_send_auto_choice',
      status: 'approved',
    });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, chosenText });
  } catch (err) { next(err); }
});

app.post('/api/suggestions/:id/wait', async (req, res, next) => {
  try {
    await db.waitSuggestion(req.params.id, Number(req.body.waitMinutes || 30));
    bus.emit('suggestion.skipped', { suggestionId: req.params.id, kind: 'wait' });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/suggestions/:id/skip', async (req, res, next) => {
  try {
    await db.skipSuggestion(req.params.id);
    bus.emit('suggestion.skipped', { suggestionId: req.params.id, kind: 'skip' });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/contacts/:id/autopilot', async (req, res, next) => {
  try {
    const mode = ['manual', 'auto_choose', 'auto_send_safe'].includes(req.body.autopilotMode)
      ? req.body.autopilotMode
      : 'manual';
    await db.updateContactRules(req.params.id, {
      autopilot_mode: mode,
      auto_send_whitelisted: req.body.autoSendWhitelisted === 'on' || req.body.autoSendWhitelisted === true,
    });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/contacts/:id/persona', async (req, res, next) => {
  try {
    const customPersona = String(req.body.customPersona || '').trim().slice(0, 2000);
    await db.updateContactRules(req.params.id, { custom_persona: customPersona });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, custom_persona: customPersona });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Browser-agent outgoing queue
// ═══════════════════════════════════════════════════════════

app.get('/api/bridge/pending-outgoing', async (req, res, next) => {
  try {
    const rows = await db.getPendingOutgoing({ channel: req.query.channel || null, limit: Number(req.query.limit || 5) });
    res.json({ ok: true, outgoing: rows });
  } catch (err) { next(err); }
});

app.post('/api/bridge/outgoing/:id/sent', async (req, res, next) => {
  try { await db.markOutgoingSent(req.params.id); res.json({ ok: true }); } catch (err) { next(err); }
});

app.post('/api/bridge/outgoing/:id/failed', async (req, res, next) => {
  try { await db.markOutgoingFailed(req.params.id, req.body.error || 'Unknown error'); res.json({ ok: true }); } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Agent status and re-auth
// ═══════════════════════════════════════════════════════════

app.post('/api/agents/:channel/status', async (req, res, next) => {
  try {
    await db.updateAgentStatus(req.params.channel, req.body.status, req.body.errorLog);
    bus.emit('agent.status', { channel: req.params.channel, status: req.body.status, errorLog: req.body.errorLog || null });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/agents/status', async (req, res, next) => {
  try { res.json({ ok: true, agents: await db.getAgentStatuses() }); } catch (err) { next(err); }
});

app.get('/reauth/:channel', (req, res) => {
  const channel = db.assertSupportedChannel(req.params.channel);
  res.send(renderReauthPage(channel));
});

app.get('/api/screenshots/:channel/latest', (req, res) => {
  if (!screenshotsEnabled()) return res.status(404).send('Screenshots are disabled in free-cost mode.');
  const fs = require('fs');
  const path = require('path');
  const channel = db.normalizeChannel(req.params.channel);
  const dir = path.resolve(process.env.SCREENSHOT_DIR || './data/screenshots');
  if (!fs.existsSync(dir)) return res.status(404).send('No screenshots yet');
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`${channel}-`) && f.endsWith('.png'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) return res.status(404).send('No screenshots yet');
  res.type('png').send(fs.readFileSync(path.join(dir, files[0].f)));
});

// ═══════════════════════════════════════════════════════════
// Profile refresh
// ═══════════════════════════════════════════════════════════

app.post('/api/profile-refresh/run', async (req, res, next) => {
  try {
    const refreshed = await runProfileRefreshJob();
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, refreshed });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Core pipeline
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// Per-contact auto-reply toggle (merged from LLM-for-Whatsapp)
// ═══════════════════════════════════════════════════════════

// Toggle by internal contact id
app.post('/api/contacts/:id/auto-reply', async (req, res, next) => {
  try {
    const enabled = req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 'on';
    const contact = await db.toggleContactAutoReply(req.params.id, enabled);
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, auto_reply_enabled: contact.contactRules?.auto_reply_enabled });
  } catch (err) { next(err); }
});

// Toggle by external contact id (used by the WhatsApp agent)
app.post('/api/contacts/by-external/:externalId/auto-reply', async (req, res, next) => {
  try {
    const channel    = db.normalizeChannel(req.body.channel || 'whatsapp');
    const store_     = require('./db');
    const contact    = await store_.upsertContact({ channel, externalContactId: req.params.externalId });
    const enabled    = req.body.enabled === true || req.body.enabled === 'true';
    const updated    = await db.toggleContactAutoReply(contact.id, enabled);
    res.json({ ok: true, contactId: contact.id, auto_reply_enabled: updated.contactRules?.auto_reply_enabled });
  } catch (err) { next(err); }
});

// Per-contact reply delay config
app.post('/api/contacts/:id/reply-delay', async (req, res, next) => {
  try {
    await db.setContactReplyDelay(req.params.id, {
      mode:    req.body.mode,
      seconds: req.body.seconds,
    });
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// WhatsApp logout + session cleanup
app.post('/api/agents/whatsapp/logout', async (req, res, next) => {
  try {
    // agentManager is only available if agents are running in-process
    const manager = global._agentManager;
    const wa = manager?.agents?.get('whatsapp')?.instance;
    if (wa && typeof wa.logoutAndCleanup === 'function') {
      await wa.logoutAndCleanup();
      res.json({ ok: true, message: 'Logged out and session cleared. Restart agents to re-scan QR.' });
    } else {
      res.json({ ok: false, message: 'WhatsApp agent not running in-process. Stop the agent process and delete data/sessions/whatsapp manually.' });
    }
  } catch (err) { next(err); }
});

// LLM backend connectivity test (merged from LLM-for-Whatsapp settings test button)
app.post('/api/ai/test', async (req, res, next) => {
  try {
    const result = await ai.testCurrentProvider();
    res.json(result);
  } catch (err) { next(err); }
});

app.get('/api/ai/status', (req, res) => {
  res.json({ ok: true, status: typeof ai.getProviderStatus === 'function' ? ai.getProviderStatus() : null });
});

// ═══════════════════════════════════════════════════════════
// Memory / RAG API
// ═══════════════════════════════════════════════════════════

app.get('/api/memory/:contactId/stats', (req, res) => {
  res.json({ ok: true, stats: memory.stats(req.params.contactId) });
});

app.get('/api/memory/stats', (req, res) => {
  res.json({ ok: true, stats: memory.stats(null) });
});

// Manually trigger bulk index for a contact (runs during profile refresh automatically too)
app.post('/api/memory/:contactId/reindex', async (req, res, next) => {
  try {
    const msgs = await db.getRecentMessages(req.params.contactId, 200);
    await memory.bulkIndex(req.params.contactId, msgs);
    res.json({ ok: true, indexed: msgs.length });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Realtime push (Server-Sent Events) — v6
// ═══════════════════════════════════════════════════════════
// Replaces dashboard's 20s reload. EventSource clients receive named events
// (suggestion.created, agent.status, schedule.fired, ...) as they happen.

app.get('/api/events/stream', bus.sseHandler());

app.get('/api/events/stats', (req, res) => {
  res.json({ ok: true, bus: bus.stats() });
});

// ═══════════════════════════════════════════════════════════
// Scheduled sends — v6
// ═══════════════════════════════════════════════════════════
// Defer an approved outgoing message for N minutes. The scheduler tick
// flips status back to 'queued' when the time arrives — agents pick it up
// via the existing polling loop, no agent code changes needed.

app.post('/api/outgoing/:queueId/schedule', async (req, res, next) => {
  try {
    const minutes = Number(req.body.minutes || req.body.waitMinutes || 0);
    if (!minutes || minutes <= 0) throw new Error('minutes is required and must be > 0');
    const result = await scheduler.scheduleOutgoing(req.params.queueId, minutes);
    if (req.accepts('html')) return res.redirect('/');
    res.json(result);
  } catch (err) { next(err); }
});

app.post('/api/outgoing/:queueId/cancel-schedule', async (req, res, next) => {
  try {
    const result = await scheduler.cancelScheduled(req.params.queueId);
    if (req.accepts('html')) return res.redirect('/');
    res.json(result);
  } catch (err) { next(err); }
});

app.get('/api/schedule/list', async (req, res, next) => {
  try {
    const items = await scheduler.listScheduled();
    res.json({ ok: true, scheduled: items });
  } catch (err) { next(err); }
});

// One-step: approve a suggestion AND schedule it for later in a single click
app.post('/api/suggestions/:id/approve-and-schedule', async (req, res, next) => {
  try {
    assertHumanApproval();
    const chosenText = cleanSuggestionText(req.body.chosenText);
    const minutes    = Number(req.body.minutes || 30);
    if (!chosenText) throw new Error('chosenText is required');
    if (isSystemInstructionText(chosenText)) throw new Error('Cannot schedule a system instruction.');

    const before  = await db.getSuggestionById(req.params.id);
    const approval = await db.approveSuggestion({
      suggestionId: req.params.id, chosenText, bridge: req.body.bridge,
      source: 'manual_approval_scheduled', status: 'approved',
    });

    // Record feedback for the learner
    if (before?.contactId || before?.contact_id) {
      preferenceLearner.recordFeedback(db, {
        contactId:    before.contactId || before.contact_id,
        suggestionId: req.params.id,
        suggestion:   before,
        chosenText,
        source:       'manual_approval_scheduled',
      }).catch(() => {});
    }

    const scheduled = await scheduler.scheduleOutgoing(approval.queueId, minutes);
    bus.emit('suggestion.approved', { suggestionId: req.params.id, chosenText, scheduled: true, scheduledAt: scheduled.scheduledAt });

    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true, ...scheduled });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Plugin API
// ═══════════════════════════════════════════════════════════

app.get('/api/plugins', (req, res) => {
  res.json({ ok: true, plugins: plugins.list() });
});

app.post('/api/plugins/:name/run', async (req, res, next) => {
  try {
    const result = await plugins.run(req.params.name, req.body || {});
    res.json(result);
  } catch (err) { next(err); }
});


const contactQueues = new Map();

function queueKeyForMessage({ channel, externalContactId }) {
  const ch = (() => { try { return db.normalizeChannel(channel); } catch { return String(channel || 'manual').toLowerCase(); } })();
  return `${ch}:${String(externalContactId || '').trim()}`;
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function processIncomingMessageQueued(args) {
  const key = queueKeyForMessage(args);
  if (!args.externalContactId) throw new Error('externalContactId is required');

  const previous = contactQueues.get(key) || Promise.resolve();
  const queuedRun = previous.catch(() => {}).then(async () => {
    await db.setProcessingStatus?.({
      key,
      channel: args.channel,
      externalContactId: args.externalContactId,
      displayName: args.displayName,
      stage: 'queued',
      status: 'processing',
      detail: 'Waiting for this contact turn to finish',
    });
    await db.addSystemEvent?.({
      type: 'pipeline', status: 'info', channel: args.channel, externalContactId: args.externalContactId,
      title: 'Message queued', detail: `Nano Bot queue accepted: ${String(args.body || args.media_summary || '').slice(0, 120)}`,
    });

    const timeoutMs = Number(process.env.MESSAGE_PIPELINE_TIMEOUT_MS || 45000);
    try {
      const result = await withTimeout(processIncomingMessage(args), timeoutMs, 'message pipeline');
      await db.clearProcessingStatus?.(key, {
        status: 'done', stage: 'complete',
        detail: `Decision ${result?.result?.decision?.action || 'ready'} · autoSent ${Boolean(result?.autoSent)}`,
      });
      return result;
    } catch (err) {
      await db.clearProcessingStatus?.(key, { status: 'error', stage: 'error', detail: err.message });
      await db.addSystemEvent?.({
        type: 'error', status: 'error', channel: args.channel, externalContactId: args.externalContactId,
        title: 'Message processing failed', detail: errorDetails(err),
      });
      throw err;
    }
  });

  const trackedRun = queuedRun.finally(() => {
    if (contactQueues.get(key) === trackedRun) contactQueues.delete(key);
  });
  contactQueues.set(key, trackedRun);
  return queuedRun;
}

function errorDetails(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const serverMessage = typeof data === 'string' ? data : (data?.error?.message || data?.message || data?.error || '');
  return [status ? `HTTP ${status}` : '', err?.message || String(err), serverMessage ? `— ${String(serverMessage).slice(0, 500)}` : '']
    .filter(Boolean)
    .join(' ');
}

async function processIncomingMessage({
  channel, externalContactId, displayName, body, timestamp, metadata,
  media_type, media_summary,
  is_group = false, author = null, mentioned_me = false, reply_to_me = false,
  is_forwarded = false, is_starred = false, local_media_path = null,
}) {
  const normalizedChannel = db.assertSupportedChannel(channel);
  if (!externalContactId) throw new Error('externalContactId is required');
  const processingKey = queueKeyForMessage({ channel: normalizedChannel, externalContactId });
  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, externalContactId, displayName, stage: 'received', status: 'processing', detail: 'WhatsApp message received' });

  let workingBody = String(body || '').trim();
  let transcript = null;
  const normalizedMediaType = normalizeMediaType(media_type || (local_media_path ? 'audio' : 'text'));

  if (normalizedMediaType === 'audio' && local_media_path) {
    try {
      const result = await transcribe.transcribe(local_media_path);
      if (result?.text) {
        transcript = result;
        workingBody = result.text;
        console.log(`[transcribe] ${result.backend}${result.cached ? ' (cached)' : ''}: "${result.text.slice(0, 80)}"`);
      }
    } catch (err) {
      console.warn('[transcribe] error:', err.message);
    }
  }

  if (!workingBody) workingBody = normalizedMediaType !== 'text' ? `[${normalizedMediaType}]` : '';
  if (!workingBody) throw new Error('body is required');
  if (workingBody.length > 4000) throw new Error('body too long');

  const contact = await db.upsertContact({ channel: normalizedChannel, externalContactId: String(externalContactId).trim(), displayName });
  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, displayName: contact.displayName || displayName, stage: 'contact', status: 'processing', detail: 'Contact loaded' });
  const incoming = await db.insertMessage({
    contactId: contact.id,
    direction: 'incoming',
    body: workingBody,
    timestamp: parseTimestamp(timestamp),
    metadata: {
      channel: normalizedChannel,
      is_group: Boolean(is_group),
      author,
      mentioned_me: Boolean(mentioned_me),
      reply_to_me: Boolean(reply_to_me),
      is_forwarded: Boolean(is_forwarded),
      is_starred: Boolean(is_starred),
      original_body: workingBody !== String(body || '').trim() ? String(body || '').trim() : undefined,
      transcript: transcript ? { backend: transcript.backend, cached: transcript.cached } : undefined,
      ...metadata,
    },
    media_type: normalizedMediaType,
    media_summary: media_summary || (transcript?.text ? transcript.text.slice(0, 500) : null),
  });
  await db.addSystemEvent?.({ type: 'message', status: 'ok', channel: normalizedChannel, contactId: contact.id, externalContactId, title: 'Incoming message', detail: workingBody });
  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, stage: 'triage', status: 'processing', detail: 'Running Nano Bot triage' });
  const recentMessages = await db.getRecentMessages(contact.id, Number(process.env.MAX_RECENT_MESSAGES || 30));

  const globalPersona = await db.getSetting('user_persona');
  const contactPersona = (contact.contactRules || contact.contact_rules || {}).custom_persona;
  const userPersona = (contactPersona && contactPersona.trim()) ? contactPersona : globalPersona;

  // ── Index this message in the RAG memory store ──────────────
  // Fire-and-forget: non-blocking, safe to run before suggestion generation
  memory.indexMessage({
    contactId: contact.id,
    messageId: incoming.id,
    body: incoming.body,
    direction: 'incoming',
    timestamp: new Date(incoming.timestamp || incoming.created_at).getTime(),
  }).catch(() => {});

  // ── Retrieve relevant past context (RAG) ─────────────────────
  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, stage: 'memory', status: 'processing', detail: 'Checking contact memory' });
  const memoryBlock = await memory.buildMemoryBlock({
    contactId: contact.id,
    query: incoming.body,
  }).catch((err) => {
    db.addSystemEvent?.({ type: 'memory', status: 'error', channel: normalizedChannel, contactId: contact.id, externalContactId, title: 'Memory lookup failed', detail: err.message }).catch(() => {});
    return '';
  });

  // ── Agentic tool-calling (web search, datetime, calculator) ──
  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, stage: 'tools', status: 'processing', detail: 'Checking tools and context' });
  const toolResult = await callTools({
    body: incoming.body,
    contact,
    incomingMessage: incoming,
  }).catch((err) => {
    db.addSystemEvent?.({ type: 'tools', status: 'error', channel: normalizedChannel, contactId: contact.id, externalContactId, title: 'Tool call failed', detail: err.message }).catch(() => {});
    return { called: false, contextBlock: '', dashboardHtml: '' };
  });

  // ── v6: User preference profile (learns from past approvals) ──
  const preferenceProfile = await preferenceLearner
    .getPreferenceProfile(db, contact.id)
    .catch(() => ({ promptBlock: '', topTones: [], avoidTones: [] }));

  // ── Attach media context + memory + tool results + preferences ──
  const enrichedIncoming = {
    ...incoming,
    media_type:   normalizedMediaType,
    media_summary: media_summary || (transcript?.text ? transcript.text.slice(0, 500) : null),
    _memoryBlock:  memoryBlock  || null,
    _toolContext:  toolResult.contextBlock || null,
    _toolHtml:     toolResult.dashboardHtml || null,
    _preferenceBlock: preferenceProfile.promptBlock || null,
    is_group: Boolean(is_group),
    author,
    mentioned_me: Boolean(mentioned_me),
    reply_to_me: Boolean(reply_to_me),
    is_forwarded: Boolean(is_forwarded),
    _transcript: transcript,
    _userDisplayName: process.env.USER_DISPLAY_NAME || extractFirstName(globalPersona),
  };

  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, stage: 'reply', status: 'processing', detail: 'Reply Bot generating answer' });
  const result = await ai.generateSuggestions({ contact, recentMessages, incomingMessage: enrichedIncoming, userPersona });
  if (result.provider_error) {
    await db.addSystemEvent?.({ type: 'ai', status: 'warning', channel: normalizedChannel, contactId: contact.id, externalContactId, title: 'Cloud AI fallback used', detail: result.provider_error });
  }

  // Surface tool results in the suggestion for the dashboard
  if (toolResult.called && toolResult.dashboardHtml) {
    result._toolHtml = toolResult.dashboardHtml;
    result._toolsUsed = toolResult.tools?.map(t => t.label) || [];
  }
  if (memoryBlock) {
    result._memoryUsed = true;
  }

  // ── v6: Re-rank options by learned tone preferences ──────────
  if (preferenceProfile.topTones?.length || preferenceProfile.avoidTones?.length) {
    result.options = preferenceLearner.reorderOptionsByPreference(result.options || [], preferenceProfile);
    result._preferenceApplied = {
      topTones:   preferenceProfile.topTones,
      avoidTones: preferenceProfile.avoidTones,
      sampleSize: preferenceProfile.sampleSize,
    };
  }

  await db.setProcessingStatus?.({ key: processingKey, channel: normalizedChannel, contactId: contact.id, externalContactId, stage: 'safety', status: 'processing', detail: 'Safety Bot checking autopilot rules' });
  const autoSendsToday = await db.countAutoSendsToday();
  result.automation = evaluateAutopilot({ contact, decision: result.decision, stats: result.stats, options: result.options, incomingMessage: enrichedIncoming, recentMessages, autoSendsToday });

  const suggestion = await db.createSuggestion({ contactId: contact.id, incomingMessageId: incoming.id, result });
  await db.addSystemEvent?.({ type: 'decision', status: 'ok', channel: normalizedChannel, contactId: contact.id, externalContactId, title: `Decision: ${result.decision?.action || 'yes'}`, detail: result.decision?.reason || 'Suggestion ready', meta: { confidence: result.decision?.confidence, suggestionId: suggestion.id } });

  let autoSent = false;
  if (result.automation?.auto_send?.allowed && result.automation.recommended_text) {
    await db.approveSuggestion({
      suggestionId: suggestion.id,
      chosenText: result.automation.recommended_text,
      source: 'smart_autopilot_auto_send',
      status: 'auto_sent',
    });
    autoSent = true;
    await db.addSystemEvent?.({ type: 'send', status: 'ok', channel: normalizedChannel, contactId: contact.id, externalContactId, title: 'Auto-send queued', detail: result.automation.recommended_text });
  }

  // ── v6: Push the new suggestion to all connected dashboards via SSE ──
  bus.emit('suggestion.created', {
    suggestionId:   suggestion.id,
    contactId:      contact.id,
    contactName:    contact.displayName || contact.display_name || externalContactId,
    channel:        normalizedChannel,
    incomingBody:   String(workingBody).slice(0, 200),
    decisionAction: result.decision?.action || 'yes',
    confidence:     result.decision?.confidence || 70,
    autoSent,
    mediaType:      enrichedIncoming.media_type,
    timestamp:      new Date().toISOString(),
  });

  return { contact, incoming, suggestion, result, autoSent };
}

function extractFirstName(persona) {
  if (!persona) return null;
  const patterns = [
    /(?:my name is|i'?m called|i am called|call me)\s+([A-Z][a-z]+)/i,
    /i'?m\s+([A-Z][a-z]+)(?:[,\.\s]|$)/i,
    /i am\s+([A-Z][a-z]+)(?:[,\.\s]|$)/i,
  ];
  for (const p of patterns) {
    const m = String(persona).match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}


async function buildDashboardState(selectedContactId = null) {
  const [contacts, pendingSuggestions, outgoingQueue, agentStatuses, costSummary, systemEvents, processingStatuses] = await Promise.all([
    db.listContacts(),
    db.listPendingSuggestions(),
    db.listOutgoingQueue(),
    db.getAgentStatuses(),
    db.getCostSummary(),
    typeof db.listSystemEvents === 'function' ? db.listSystemEvents(90) : [],
    typeof db.listProcessingStatuses === 'function' ? db.listProcessingStatuses(90) : [],
  ]);

  const providerStatus = typeof ai.getProviderStatus === 'function' ? ai.getProviderStatus() : null;
  const selected = selectedContactId || pendingSuggestions[0]?.contactId || contacts[0]?.id || null;
  const selectedMessages = selected ? await db.getRecentMessages(selected, 80) : [];
  const selectedContact = contacts.find(c => c.id === selected) || null;
  const selectedSuggestion = pendingSuggestions.find(s => s.contactId === selected) || null;

  const store = typeof db.readStore === 'function' ? await db.readStore() : null;
  const since = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const weekMessages = (store?.messages || []).filter(m => new Date(m.created_at || m.timestamp || 0).getTime() >= since);
  const weekSuggestions = (store?.suggestions || []).filter(s => new Date(s.created_at || 0).getTime() >= since);
  const sentThisWeek = (store?.outgoing_queue || []).filter(q => new Date(q.created_at || 0).getTime() >= since && ['sent', 'auto_sent', 'dry_run'].includes(q.status)).length;
  const aiHandledPct = weekSuggestions.length ? Math.round((weekSuggestions.filter(s => ['approved', 'auto_sent', 'skipped', 'waiting'].includes(s.status)).length / weekSuggestions.length) * 100) : 0;

  return {
    contacts,
    pendingSuggestions,
    outgoingQueue,
    agentStatuses,
    costSummary,
    providerStatus,
    selectedContactId: selected,
    selectedContact,
    selectedMessages,
    selectedSuggestion,
    systemEvents,
    processingStatuses,
    weekStats: {
      messages: weekMessages.length,
      aiHandledPct,
      newLeads: contacts.filter(c => new Date(c.created_at || 0).getTime() >= since).length,
      sent: sentThisWeek,
      errors: systemEvents.filter(e => e.status === 'error').length,
    },
    env: {
      aiProvider: process.env.AI_PROVIDER || 'easy',
      enabledAgents: process.env.ENABLED_AGENTS || 'whatsapp,telegram',
      screenshots: screenshotsEnabled(),
      dryRun: boolEnv('DRY_RUN_SEND', false),
      autoChoose: boolEnv('AUTO_CHOOSE_ENABLED', true),
      autoSend: boolEnv('AUTO_SEND_ENABLED', false),
      autoSendWhitelistOnly: boolEnv('AUTO_SEND_WHITELIST_ONLY', true),
      channels: dashboardChannels(process.env.ENABLED_AGENTS || 'whatsapp,telegram'),
    },
  };
}

function parseTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return new Date(n > 100000000000 ? n : n * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function runProfileRefreshJob() {
  const min = Number(process.env.PROFILE_REFRESH_MIN_NEW_MESSAGES || 25);
  const max = Number(process.env.PROFILE_REFRESH_MAX_MESSAGES || 200);
  const contacts = await db.contactsNeedingRefresh(min);
  const refreshed = [];
  for (const contact of contacts) {
    const messages = await db.getMessagesSinceLastProfile(contact.id, max);
    if (!messages.length) continue;
    const result = await ai.summarizeProfile({ contact, messages });
    // Bulk-index messages into RAG memory store after profile refresh
    memory.bulkIndex(contact.id, messages).catch(() => {});

    await db.updateContactProfile({
      contactId: contact.id,
      summary: result.summary,
      preferredLanguage: result.preferredLanguage,
      emojiStyle: result.emojiStyle,
      conversationStage: result.conversationStage,
      stats: result.stats,
    });
    refreshed.push({ contactId: contact.id, channel: contact.channel, ...result });
  }
  return refreshed;
}

// ═══════════════════════════════════════════════════════════
// HTML UI — mobile-first approval cards
// ═══════════════════════════════════════════════════════════

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDashboard({
  contacts = [], pendingSuggestions = [], outgoingQueue = [], agentStatuses = [], costSummary = {}, providerStatus = null,
  env = {}, selectedContactId = null, selectedContact = null, selectedMessages = [], selectedSuggestion = null,
  systemEvents = [], processingStatuses = [], weekStats = {},
}) {
  const active = selectedContact || contacts.find(c => c.id === selectedContactId) || contacts[0] || null;
  const activeId = active?.id || selectedContactId || null;
  const activeRules = active?.contactRules || active?.contact_rules || {};
  const activeName = active ? (active.displayName || active.display_name || active.externalContactId || 'Contact') : 'No contact yet';
  const pendingByContact = pendingSuggestions.reduce((map, s) => {
    const id = s.contactId || s.contact_id;
    map[id] = (map[id] || 0) + 1;
    return map;
  }, {});
  const liveAgent = agentStatuses.some(a => a.status === 'active');
  const fallbackActive = (systemEvents || []).some(e => e.title === 'Cloud AI fallback used' || e.status === 'warning');
  const activeProcessing = processingStatuses.find(p => (p.contact_id && p.contact_id === activeId) || (active && p.external_contact_id === active.externalContactId));
  const errors = (systemEvents || []).filter(e => e.status === 'error').slice(0, 5);

  function initials(name) {
    const raw = String(name || '??').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    if (!parts.length) return '??';
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
  }
  function timeAgo(value) {
    const t = new Date(value || Date.now()).getTime();
    const diff = Math.max(0, Date.now() - t);
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return Math.round(diff / 60_000) + 'm ago';
    if (diff < 86400_000) return Math.round(diff / 3600_000) + 'h ago';
    return Math.round(diff / 86400_000) + 'd ago';
  }
  function shortTime(value) {
    try { return new Date(value || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }
  function decisionOf(s) { return safeJson(s?.decisionJson || s?.decision_json, s?.decision_json || s?.decision || {}); }
  function optionsOf(s) { return safeJson(s?.optionsJson || s?.options_json, s?.options_json || s?.options || []); }
  function automationOf(s) { return safeJson(s?.automationJson || s?.automation_json, s?.automation_json || s?.automation || {}); }
  function statsOf(s) { return safeJson(s?.statsJson || s?.stats_json, s?.stats_json || s?.stats || {}); }

  const conversationList = contacts.slice(0, 40).map((c, index) => {
    const name = c.displayName || c.display_name || c.externalContactId || 'Contact';
    const last = c.last_message || 'No messages yet';
    const activeClass = c.id === activeId ? 'active' : '';
    const pending = pendingByContact[c.id] || 0;
    const avatarClass = ['a','b','c','d','e'][index % 5];
    return `<a class="conversation ${activeClass}" href="/?contactId=${encodeURIComponent(c.id)}">
      <div class="avatar av-${avatarClass}">${esc(initials(name))}</div>
      <div class="conversation-copy"><div class="conversation-title">${esc(name)}</div><div class="conversation-last">${esc(last).slice(0, 72)}</div></div>
      <div class="conversation-side"><span>${esc(timeAgo(c.updated_at || c.last_updated || c.created_at))}</span>${pending ? `<b>${pending}</b>` : ''}</div>
    </a>`;
  }).join('') || '<div class="empty small">No conversations yet. Use the sandbox test or WhatsApp agent.</div>';

  const messagesHtml = selectedMessages.map((m) => {
    const outgoing = m.direction === 'outgoing';
    const meta = m.metadata || {};
    const ai = outgoing && (meta.source || '').includes('auto');
    const media = m.media_type && m.media_type !== 'text' ? `<span class="chip tiny">${esc(m.media_type)}</span>` : '';
    return `<div class="msg-row ${outgoing ? 'out' : 'in'}">
      <div class="bubble ${outgoing ? 'out' : 'in'}">${media}${esc(m.body || '').replace(/\n/g, '<br>')}</div>
      <div class="msg-meta">${ai ? '🤖 AI · ' : ''}${esc(shortTime(m.timestamp || m.created_at))}</div>
    </div>`;
  }).join('') || '<div class="empty">Select a contact or send a sandbox message to see the live chat.</div>';

  const decision = decisionOf(selectedSuggestion);
  const options = optionsOf(selectedSuggestion);
  const automation = automationOf(selectedSuggestion);
  const stats = statsOf(selectedSuggestion);
  const recommendedText = automation.recommended_text || selectedSuggestion?.recommendedText || selectedSuggestion?.recommended_text || options[0]?.text || '';
  const decisionPanel = selectedSuggestion ? `<div class="reply-card">
    <div class="reply-tabs"><span class="tab active">✦ AI Reply</span><span class="tab">Manual Reply</span><span class="tab">Note</span></div>
    <div class="reply-text">${esc(recommendedText || 'No safe reply generated yet.')}</div>
    <div class="reply-actions">
      <form method="POST" action="/api/suggestions/${esc(selectedSuggestion.id)}/approve" class="inline-form">
        <input type="hidden" name="chosenText" value="${esc(recommendedText)}">
        <button type="submit" class="primary">➤ Send</button>
      </form>
      <form method="POST" action="/api/suggestions/${esc(selectedSuggestion.id)}/approve-and-schedule" class="inline-form">
        <input type="hidden" name="chosenText" value="${esc(recommendedText)}">
        <select name="minutes"><option value="15">15s/m</option><option value="30" selected>30m</option><option value="60">1h</option><option value="180">3h</option></select>
        <button type="submit" class="ghost">Schedule</button>
      </form>
      <form method="POST" action="/api/suggestions/${esc(selectedSuggestion.id)}/wait" class="inline-form"><input type="hidden" name="waitMinutes" value="${esc(decision.wait_minutes || 30)}"><button class="soft" type="submit">Wait</button></form>
      <form method="POST" action="/api/suggestions/${esc(selectedSuggestion.id)}/skip" class="inline-form"><button class="danger" type="submit">Reject</button></form>
    </div>
    <form method="POST" action="/api/suggestions/${esc(selectedSuggestion.id)}/approve" class="edit-form">
      <input name="chosenText" value="${esc(recommendedText)}" placeholder="Edit the AI reply before sending">
      <button type="submit" class="ghost">Send edited</button>
    </form>
  </div>` : `<div class="reply-card empty-compose">
    <div class="reply-tabs"><span class="tab active">✦ AI Reply</span><span class="tab">Manual Reply</span><span class="tab">Note</span></div>
    <div class="reply-text muted">No pending reply for this contact. Incoming messages will appear here for approval.</div>
  </div>`;

  const optionChips = options.slice(0, 4).map((o, i) => `<span class="chip">${i + 1}. ${esc(o.tone || 'reply')} · ${esc(o.score || 75)}/100 · ${esc(o.risk || 'low')}</span>`).join('');

  const agentsHtml = (env.channels || ['whatsapp','telegram','wechat']).map(ch => {
    const a = agentStatuses.find(x => x.channel === ch) || { channel: ch, status: 'not_started' };
    const ok = a.status === 'active';
    const idle = a.status === 'not_started' || a.status === 'stopped';
    return `<div class="agent-line"><span class="dot ${ok ? 'ok' : idle ? '' : 'warn'}"></span><strong>${esc(ch[0].toUpperCase() + ch.slice(1))} agent</strong><em>${esc(a.status)}</em>${a.status === 'login_required' ? `<a href="/reauth/${esc(ch)}">Re-auth</a>` : ''}</div>`;
  }).join('');

  const botSteps = [
    ['receiver', 'Receiver Bot', 'captures WhatsApp message'],
    ['triage', 'Triage Bot', 'reply / wait / skip decision'],
    ['memory', 'Memory Bot', 'contact memory + preferences'],
    ['reply', 'Reply Bot', 'writes suggested response'],
    ['safety', 'Safety Bot', 'risk and auto-send rules'],
    ['send', 'Sender Bot', 'queue / scheduled / sent'],
  ];
  const currentStage = activeProcessing?.stage || (selectedSuggestion ? 'safety' : 'receiver');
  const pipelineHtml = botSteps.map(([key, label, desc]) => {
    const current = key === currentStage;
    const doneIndex = botSteps.findIndex(x => x[0] === currentStage);
    const thisIndex = botSteps.findIndex(x => x[0] === key);
    const done = selectedSuggestion ? thisIndex <= 4 : thisIndex < doneIndex;
    return `<div class="bot-step ${current ? 'current' : done ? 'done' : ''}"><span>${done ? '✓' : current ? '●' : '○'}</span><div><strong>${esc(label)}</strong><small>${esc(desc)}</small></div></div>`;
  }).join('');

  const eventsHtml = (systemEvents || []).slice(0, 7).map(e => `<div class="event ${e.status === 'error' ? 'bad' : e.status === 'warning' ? 'warn' : ''}"><span>${esc(shortTime(e.created_at))}</span><div><strong>${esc(e.title || e.type)}</strong><small>${esc(e.detail || '').slice(0, 160)}</small></div></div>`).join('') || '<div class="empty small">No system events yet.</div>';
  const errorsHtml = errors.map(e => `<div class="error-line"><strong>${esc(e.title || e.type)}</strong><small>${esc(e.detail || '').slice(0, 180)}</small></div>`).join('') || '<div class="muted small-pad">No recent errors.</div>';
  const queueHtml = outgoingQueue.slice(0, 5).map(q => `<div class="queue-line"><span class="chip tiny">${esc(q.status)}</span><div>${esc(q.body || '').slice(0, 85)}</div></div>`).join('') || '<div class="muted small-pad">No outgoing queue.</div>';

  const activeRulesForm = active ? `<form method="POST" action="/api/contacts/${esc(active.id)}/autopilot" class="control-stack">
    <label>Autopilot mode<select name="autopilotMode"><option value="manual" ${activeRules.autopilot_mode === 'manual' ? 'selected' : ''}>Manual approval</option><option value="auto_choose" ${activeRules.autopilot_mode === 'auto_choose' ? 'selected' : ''}>Auto choose draft</option><option value="auto_send_safe" ${activeRules.autopilot_mode === 'auto_send_safe' ? 'selected' : ''}>Auto-send safe</option></select></label>
    <label class="toggle-line"><input type="checkbox" name="autoSendWhitelisted" ${activeRules.auto_send_whitelisted ? 'checked' : ''}> Whitelist safe auto-send</label>
    <button class="ghost" type="submit">Save rules</button>
  </form>
  <form method="POST" action="/api/contacts/${esc(active.id)}/auto-reply" class="toggle-line-form">
    <input type="hidden" name="enabled" value="false"><label class="switch-label"><span>Auto reply</span><input type="checkbox" name="enabled" value="true" ${activeRules.auto_reply_enabled ? 'checked' : ''} onchange="this.form.submit()"><i></i></label>
  </form>` : '<div class="muted small-pad">No active contact.</div>';

  return `<!doctype html><html><head><title>ReplyWise CRM Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{--bg:#f7f6f1;--panel:#fff;--panel2:#faf9f5;--line:#e9e6de;--text:#202124;--muted:#6b6f76;--green:#22c55e;--green2:#e8f9ee;--green3:#d7f7e1;--blue:#e9f2ff;--red:#fee2e2;--amber:#fff3cd;--shadow:0 12px 32px rgba(17,24,39,.06)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px}.app{height:100vh;display:grid;grid-template-columns:240px minmax(500px,1fr) 360px;overflow:hidden}.sidebar,.rightbar{background:rgba(255,255,255,.72);border-right:1px solid var(--line);overflow:auto}.rightbar{border-right:0;border-left:1px solid var(--line);padding:14px}.brand{height:64px;display:flex;align-items:center;gap:10px;padding:0 18px;font-size:20px;font-weight:800}.wa-icon{width:24px;height:24px;border-radius:50%;background:var(--green);color:#fff;display:grid;place-items:center}.nav{padding:4px 12px}.nav a,.nav div{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;color:#29323a;text-decoration:none}.nav .active{background:var(--green2);color:#08733f;font-weight:700}.section-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8a8f98;padding:18px 16px 8px}.conversation{display:grid;grid-template-columns:40px 1fr auto;gap:10px;align-items:center;margin:3px 10px;padding:10px;border-radius:16px;color:inherit;text-decoration:none}.conversation:hover,.conversation.active{background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.04)}.avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-weight:800}.av-a{background:#e2f7ee;color:#07704c}.av-b{background:#e5f0ff;color:#185fa5}.av-c{background:#fff0d8;color:#986000}.av-d{background:#f1eaff;color:#6d42be}.av-e{background:#ffe8ed;color:#b42355}.conversation-title{font-weight:800}.conversation-last{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:145px}.conversation-side{text-align:right;font-size:11px;color:var(--muted)}.conversation-side b{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-top:6px;background:var(--green);color:white;border-radius:999px;font-size:11px}.main{display:flex;flex-direction:column;overflow:hidden}.topbar{height:64px;background:rgba(255,255,255,.82);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 20px}.contact-head{display:flex;align-items:center;gap:12px}.name{font-size:18px;font-weight:850}.sub{font-size:12px;color:var(--muted)}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px}.top-actions{display:flex;gap:10px}.button,.top-actions button,button{border:1px solid var(--line);background:white;color:#111827;border-radius:12px;padding:10px 12px;font-weight:800;cursor:pointer}.primary{background:var(--green);border-color:var(--green);color:white}.ghost{background:white}.soft{background:var(--green2);color:#0f7a47}.danger{background:var(--red);color:#991b1b}.content{flex:1;display:grid;grid-template-rows:1fr auto;overflow:hidden;background:#fcfbf8}.chat{overflow:auto;padding:22px;background-image:radial-gradient(#e8e5dc 1px, transparent 1px);background-size:22px 22px}.msg-row{display:flex;flex-direction:column;margin:10px 0}.msg-row.out{align-items:flex-end}.bubble{max-width:min(72%,680px);padding:12px 14px;border-radius:18px;line-height:1.45;box-shadow:0 1px 0 rgba(0,0,0,.04)}.bubble.in{background:white;border-bottom-left-radius:6px}.bubble.out{background:var(--green3);border-bottom-right-radius:6px}.msg-meta{font-size:11px;color:var(--muted);margin-top:4px}.composer{background:white;border-top:1px solid var(--line);padding:14px 18px}.ai-strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.chip{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;background:#f2f4f7;border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:750}.tiny{font-size:10px;padding:3px 7px}.reply-card{border:1px solid var(--line);border-radius:18px;background:#fff;box-shadow:var(--shadow);padding:12px}.reply-tabs{display:flex;gap:8px;border-bottom:1px solid var(--line);margin:-2px -2px 12px;padding:0 2px 8px}.tab{padding:8px 10px;border-radius:10px;color:var(--muted);font-weight:800}.tab.active{background:var(--green2);color:#08733f}.reply-text{font-size:16px;line-height:1.45;padding:5px 2px 12px}.reply-actions{display:flex;gap:8px;flex-wrap:wrap}.inline-form{display:inline-flex;gap:6px}.inline-form select,.edit-form input,.control-stack select,.sandbox input,.sandbox select{border:1px solid var(--line);background:#fff;border-radius:10px;padding:9px}.edit-form{margin-top:10px;display:flex;gap:8px}.edit-form input{flex:1}.card{background:white;border:1px solid var(--line);border-radius:18px;padding:14px;margin-bottom:12px;box-shadow:0 1px 0 rgba(0,0,0,.03)}.card h3{margin:0 0 12px;font-size:15px}.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.stat{background:var(--panel2);border-radius:14px;padding:12px}.stat strong{display:block;font-size:23px}.stat span{font-size:12px;color:var(--muted)}.agent-line{display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:13px;padding:10px;margin:8px 0}.agent-line strong{flex:1}.agent-line em{font-style:normal;color:var(--muted);font-size:12px}.dot{width:9px;height:9px;border-radius:50%;background:#c8cdd3}.dot.ok{background:var(--green)}.dot.warn{background:#f59e0b}.control-stack{display:grid;gap:8px}.control-stack label{display:grid;gap:5px;color:var(--muted);font-size:12px}.toggle-line{display:flex!important;align-items:center!important;gap:8px!important}.toggle-line-form{margin-top:12px}.switch-label{display:flex;align-items:center;justify-content:space-between;gap:10px}.switch-label input{display:none}.switch-label i{position:relative;width:44px;height:24px;border-radius:99px;background:#ddd}.switch-label i:before{content:"";position:absolute;width:18px;height:18px;background:white;border-radius:50%;left:3px;top:3px;transition:.2s}.switch-label input:checked+i{background:var(--green)}.switch-label input:checked+i:before{transform:translateX(20px)}.bot-step{display:flex;gap:10px;border-left:2px solid #e5e7eb;padding:8px 0 8px 12px;color:var(--muted)}.bot-step span{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#f2f4f7;font-size:11px}.bot-step.done{border-left-color:var(--green);color:#1f2937}.bot-step.done span{background:var(--green2);color:#06733e}.bot-step.current{border-left-color:#2563eb;color:#1f2937}.bot-step small{display:block;color:var(--muted);margin-top:2px}.event{display:grid;grid-template-columns:45px 1fr;gap:8px;border-top:1px solid var(--line);padding:9px 0}.event:first-child{border-top:0}.event span,.event small{color:var(--muted);font-size:11px}.event strong{font-size:12px}.event.bad strong{color:#b91c1c}.event.warn strong{color:#b45309}.error-line{background:#fff5f5;border:1px solid #fecaca;border-radius:12px;padding:9px;margin:7px 0}.error-line small{display:block;color:#7f1d1d;margin-top:3px}.queue-line{display:flex;gap:8px;border-top:1px solid var(--line);padding:8px 0}.queue-line:first-child{border-top:0}.empty{border:1px dashed #cfd3d9;border-radius:16px;padding:20px;text-align:center;color:var(--muted);background:rgba(255,255,255,.65)}.empty.small{padding:12px;font-size:12px}.small-pad{padding:8px;font-size:12px}.muted{color:var(--muted)}.sandbox{display:grid;gap:8px}.sandbox button{width:100%}.badge-live{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;background:white;padding:8px 11px;font-weight:800}.badge-live.live{color:#08733f}.badge-live.warn{color:#b45309}@media(max-width:1100px){.app{grid-template-columns:210px 1fr}.rightbar{display:none}}@media(max-width:760px){.app{display:block;height:auto}.sidebar{height:auto}.main{height:80vh}.topbar{position:sticky;top:0;z-index:2}.conversation-last{max-width:220px}}
  </style></head><body><div class="app">
    <aside class="sidebar"><div class="brand"><span class="wa-icon">↗</span>ReplyWise</div><nav class="nav"><a class="active" href="/">⌂ Dashboard</a><div>💬 All Chats <b style="margin-left:auto">${contacts.length}</b></div><div>⏳ Manual Approval <b style="margin-left:auto">${pendingSuggestions.length}</b></div><div>🤖 Nano Bots</div><div>⚙ Settings</div></nav><div class="section-label">Conversations</div>${conversationList}</aside>
    <main class="main"><header class="topbar"><div class="contact-head"><div class="avatar av-a">${esc(initials(activeName))}</div><div><div class="name">${esc(activeName)}</div><div class="sub"><span class="status-dot"></span>${active ? esc(active.channel || 'whatsapp') : 'waiting'} · ${activeProcessing?.status === 'processing' ? 'Nano Bots processing' : 'ready'}</div></div></div><div class="top-actions"><span id="live-indicator" class="badge-live ${liveAgent ? 'live' : 'warn'}">${liveAgent ? '● Live system' : '● Demo / agent offline'}</span><button onclick="location.reload()">Refresh</button></div></header>
      <section class="content"><div class="chat">${messagesHtml}</div><div class="composer"><div class="ai-strip"><span class="chip">Decision: ${esc(decision.action || 'none')}</span><span class="chip">Confidence ${esc(decision.confidence || 0)}%</span><span class="chip">Warmth ${esc(stats.warmthScore || active?.stats?.warmthScore || 0)}/100</span><span class="chip">Mode ${esc(activeRules.autopilot_mode || 'manual')}</span>${fallbackActive ? '<span class="chip">Nano fallback active</span>' : ''}${optionChips}</div>${decisionPanel}</div></section>
    </main>
    <aside class="rightbar"><div class="card"><h3>This Week Overview</h3><div class="stats-grid"><div class="stat"><strong>${esc(weekStats.messages || 0)}</strong><span>Messages</span></div><div class="stat"><strong>${esc(weekStats.aiHandledPct || 0)}%</strong><span>AI handled</span></div><div class="stat"><strong>${esc(weekStats.newLeads || 0)}</strong><span>New leads</span></div><div class="stat"><strong>$${Number(costSummary.estimatedCostUsd || 0).toFixed(2)}</strong><span>Est. cost</span></div></div></div>
      <div class="card"><h3>AI Agents</h3>${agentsHtml}</div>
      <div class="card"><h3>Contact Control</h3><div class="sub" style="margin-bottom:10px">Stage: ${esc(active?.conversationStage || active?.conversation_stage || 'initial')} · Messages: ${esc(active?.message_count || 0)}</div>${activeRulesForm}</div>
      <div class="card"><h3>Nano Bot Pipeline</h3>${pipelineHtml}<div class="sub" style="margin-top:8px">${esc(activeProcessing?.detail || 'Pipeline is idle.')}</div></div>
      <div class="card"><h3>System Events</h3>${eventsHtml}</div>
      <div class="card"><h3>Error Monitor</h3>${errorsHtml}</div>
      <div class="card"><h3>Outgoing Queue</h3>${queueHtml}</div>
      <div class="card"><h3>Sandbox Test</h3><form method="POST" action="/api/sandbox/whatsapp/incoming" class="sandbox"><input name="externalContactId" placeholder="contact id, e.g. Raja" required><input name="displayName" placeholder="Display name"><input name="body" placeholder="Incoming message"><select name="media_type"><option value="text">text</option><option value="audio">audio</option><option value="image">image</option></select><button class="primary" type="submit">Analyze Message</button></form></div>
    </aside>
  </div><script>
  (function(){
    const indicator = document.getElementById('live-indicator');
    try {
      const es = new EventSource('/api/events/stream');
      es.addEventListener('hello', () => { indicator.textContent = '● Live system'; indicator.className = 'badge-live live'; });
      ['suggestion.created','suggestion.approved','suggestion.skipped','agent.status','schedule.fired'].forEach(name => es.addEventListener(name, () => setTimeout(() => location.reload(), 350)));
      es.onerror = () => { indicator.textContent = '● Reconnecting'; indicator.className = 'badge-live warn'; };
    } catch(e) { indicator.textContent = '● Offline'; indicator.className = 'badge-live warn'; }
  })();
  </script></body></html>`;
}

function renderSuggestionCard(s) {
  const options = safeJson(s.optionsJson, []);
  const decision = safeJson(s.decisionJson, {});
  const stats = safeJson(s.statsJson, {});
  const automation = safeJson(s.automationJson || s.automation_json, {});
  const incomingBody  = s.incomingMessage?.body || s.incoming_body || '';
  const contactName   = s.contact?.displayName || s.display_name || 'Unknown';
  const ch            = s.contact?.channel || s.channel || '';
  const action        = decision.action || decision.should_reply || 'yes';
  const mediaType     = s.incomingMessage?.media_type || s.media_type || 'text';
  const contextSummary = decision.context_summary || '';
  const toolHtml      = s.toolHtml || s.tool_html || '';
  const memoryUsed    = Boolean(s.memoryUsed || s.memory_used);
  const actionLabel = action === 'yes' ? '✅ Reply now' : action === 'wait' ? '⏳ Wait' : action === 'repair' ? '🔧 Repair' : action === 'no' ? '❌ Do not reply' : '🚪 End politely';
  const decisionClass = ['yes','wait','repair','no','end'].includes(action) ? action : 'yes';
  const optionBlocks = options.map((opt, idx) => {
    const text = opt.text || '';
    const systemInstruction = isSystemInstructionText(text) || opt.action === 'wait' || opt.action === 'skip';
    const sendButton = systemInstruction ? '' : `<form method="POST" action="/api/suggestions/${esc(s.id)}/approve" style="display:inline"><input type="hidden" name="chosenText" value="${esc(text)}"><button type="submit">Send</button></form>`;
    // v6: schedule-for-later option on every reply
    const scheduleButton = systemInstruction ? '' : `<form method="POST" action="/api/suggestions/${esc(s.id)}/approve-and-schedule" style="display:inline;margin-left:6px">
      <input type="hidden" name="chosenText" value="${esc(text)}">
      <select name="minutes" style="font-size:11px;padding:3px"><option value="15">+15m</option><option value="30" selected>+30m</option><option value="60">+1h</option><option value="180">+3h</option><option value="720">+12h</option></select>
      <button class="ghost" type="submit" style="font-size:11px">⏰ Schedule</button>
    </form>`;
    const chosen = Number(automation.recommended_index) === idx ? '<span class="pill yes">Auto-chosen</span>' : '';
    return `<div class="option"><div class="option-top"><strong>${esc(opt.tone || 'reply')} ${chosen}</strong><span class="score risk-${esc(opt.risk || 'low')}">${esc(opt.score || 75)}/100 · ${esc(opt.risk || 'low')}</span></div><p>${esc(text)}</p><p class="muted">Why: ${esc(opt.rationale || '')}</p><div class="actions">${sendButton}${scheduleButton}</div></div>`;
  }).join('');

  // v6: Build cadence + momentum strip
  const cadenceParts = [];
  if (stats.theirAvgResponseMin != null) cadenceParts.push(`Their avg reply: ${stats.theirAvgResponseMin}m`);
  if (stats.yourAvgResponseMin  != null) cadenceParts.push(`Your avg reply: ${stats.yourAvgResponseMin}m`);
  if (stats.cadenceTrend && stats.cadenceTrend !== 'stable') {
    const arrow = stats.cadenceTrend === 'speeding_up' ? '↗ replying faster' : '↘ replying slower';
    cadenceParts.push(arrow);
  }
  if (stats.momentumLabel && stats.momentumLabel !== 'unknown' && stats.momentumLabel !== 'steady') {
    const emoji = { growing: '📈', cooling: '📉', dying: '💤', dormant: '😴' }[stats.momentumLabel] || '';
    cadenceParts.push(`${emoji} ${stats.momentumLabel}`);
  }
  const cadenceHtml = cadenceParts.length
    ? `<div class="metric" style="background:#f8fafc;padding:4px 0">${cadenceParts.map(p => `<span class="pill" style="background:#e0e7ff">${esc(p)}</span>`).join('')}</div>`
    : '';

  // v6: Show learned preferences if any
  const prefApplied = safeJson(s.preferenceApplied || s.preference_applied, null);
  const prefHtml = prefApplied
    ? `<div class="muted" style="font-size:11px;padding:2px 8px">🎯 Learned preferences applied (${prefApplied.sampleSize} samples): prefers ${esc((prefApplied.topTones||[]).join(', ') || 'none')}${prefApplied.avoidTones?.length ? ', avoids ' + esc(prefApplied.avoidTones.join(', ')) : ''}</div>`
    : '';

  return `<div class="card">
    <div class="metric">
      <span class="pill">${esc(ch.toUpperCase())}</span>
      <span class="pill">${esc(contactName)}</span>
      <span class="pill ${decisionClass}">${esc(actionLabel)}</span>
      <span class="pill">Confidence ${esc(decision.confidence || 70)}%</span>
      <span class="pill">${esc(decision.temperature || 'neutral')}</span>
      ${mediaType !== 'text' ? `<span class="pill" style="background:#fde8ff">📎 ${esc(mediaType)}</span>` : ''}
      ${memoryUsed ? '<span class="pill" style="background:#e0f2fe" title="RAG memory context was retrieved">🧠 memory</span>' : ''}
      ${prefApplied ? '<span class="pill" style="background:#fef3c7" title="Tone preferences learned from past approvals">🎯 learned</span>' : ''}
      ${toolHtml}
    </div>
    <div class="message">${esc(incomingBody)}</div>
    ${contextSummary ? `<p class="muted" style="font-size:12px;padding:4px 8px">📌 ${esc(contextSummary)}</p>` : ''}
    <div class="decision ${decisionClass}"><h2>${esc(actionLabel)}</h2><p><strong>Why:</strong> ${esc(decision.reason || 'Analyze and match energy.')}</p><p><strong>Best move:</strong> ${esc(decision.best_move || s.nextMoveHint || '')}</p><p><strong>Avoid:</strong> ${esc(decision.avoid || 'Avoid over-investing.')}</p></div>
    <div class="metric"><span class="pill">Your/her energy: ${esc(stats.energyRatio || '1')}x</span><span class="pill">Warmth: ${esc(stats.warmthScore || 50)}/100</span><span class="pill">Avg her words: ${esc(stats.incomingAvgWords || 0)}</span><span class="pill">Avg your words: ${esc(stats.outgoingAvgWords || 0)}</span></div>
    ${cadenceHtml}
    ${prefHtml}
    <div class="mini-card"><strong>🤖 Smart Autopilot:</strong> ${esc(automation.mode || 'manual')} ${automation.auto_send?.allowed ? '· ✅ auto-send allowed' : '· manual review'}<br><span class="muted">Recommended: ${esc(automation.recommended_tone || 'none')}${automation.auto_send?.blocked_reasons?.length ? ' · Blocked: ' + esc(automation.auto_send.blocked_reasons.slice(0, 2).join('; ')) : ''}</span>${automation.recommended_text ? `<form method="POST" action="/api/suggestions/${esc(s.id)}/send-auto-choice" style="margin-top:8px"><button type="submit">Send Auto-Chosen</button></form>` : ''}</div>
    ${optionBlocks}
    <div class="actions">
      <form method="POST" action="/api/suggestions/${esc(s.id)}/wait"><input type="hidden" name="waitMinutes" value="${esc(decision.wait_minutes || 30)}"><button class="secondary" type="submit">Wait ${esc(decision.wait_minutes || 30)}m</button></form>
      <form method="POST" action="/api/suggestions/${esc(s.id)}/skip"><button class="danger" type="submit">Skip</button></form>
    </div>
    <form class="custom" method="POST" action="/api/suggestions/${esc(s.id)}/approve"><input name="chosenText" placeholder="Edit / custom reply..."><button type="submit">Send Custom</button></form>
  </div>`;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function renderReauthPage(channel) {
  return `<!DOCTYPE html><html><head><title>Re-auth: ${esc(channel)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;max-width:640px;margin:30px auto;padding:16px} .box{background:#fff;border:1px solid #ddd;border-radius:16px;padding:18px} body{background:#f7f4ed}.status{padding:12px;border-radius:12px;background:#fef3c7;margin:12px 0}a{color:#111827}</style></head><body><div class="box"><h1>Re-authenticate ${esc(channel)}</h1><div id="status" class="status">Checking status...</div>${channel === 'whatsapp' ? '<p>Open WhatsApp → Linked Devices → Link a Device, then scan the QR printed in the agent terminal.</p>' : '<p>Use the visible browser window to enter your Telegram phone number and OTP. Session persists after login.</p>'}<p><strong>Free-cost rule:</strong> screenshots are disabled by default. Use <code>BROWSER_HEADLESS=false</code> for login.</p>${screenshotsEnabled() ? `<p><a href="/api/screenshots/${esc(channel)}/latest" target="_blank">Open latest debug screenshot</a></p>` : ''}<p><a href="/">← Back</a></p></div><script>async function check(){try{const r=await fetch('/api/agents/status');const d=await r.json();const a=(d.agents||[]).find(x=>x.channel==='${esc(channel)}');document.getElementById('status').textContent=a?('Status: '+a.status+(a.errorLog?' — '+a.errorLog:'')):'Agent not running';}catch{}}check();setInterval(check,5000)</script></body></html>`;
}

app.use((err, req, res, _next) => {
  console.error(err);
  db.addSystemEvent?.({ type: 'api', status: 'error', title: `${req.method} ${req.path}`, detail: errorDetails(err) }).catch(() => {});
  if (req.accepts('html')) return res.status(400).send(`<h1>Error</h1><pre>${esc(err.message || err)}</pre><p><a href="/">Back</a></p>`);
  res.status(400).json({ ok: false, error: err.message || String(err) });
});

app.listen(port, async () => {
  const existing = await db.getSetting('user_persona');
  if (!existing) await db.setSetting('user_persona', 'I am calm, respectful, playful when appropriate, and prefer natural short replies. I do not pressure people.');

  // ── v6: start the scheduler tick loop ──────────────────────
  scheduler.start(db);

  console.log(`\nConversationOS Local running at http://localhost:${port}`);
  console.log('Killer promise: It tells you whether replying is a good idea.');
  console.log(`AI: ${process.env.AI_PROVIDER || 'local'} · Agents: ${process.env.ENABLED_AGENTS || 'whatsapp,telegram'} · Screenshots: ${screenshotsEnabled() ? 'debug only' : 'off'}`);
  console.log(`Realtime: SSE @ /api/events/stream · Scheduler: ${process.env.SCHEDULER_ENABLED !== 'false' ? 'on' : 'off'} · Feedback learning: on`);
  console.log(`Zero messaging API keys · Channels: ${process.env.ENABLED_AGENTS || 'whatsapp,telegram,wechat'} · Media: ${process.env.WHATSAPP_DOWNLOAD_MEDIA === 'true' ? 'download on' : 'metadata only'}\n`);
});

// ── v6: bus → agent status broadcast ─────────────────────────
// Hook the agent status route to also push via SSE
const _origAgentStatus = require('./db').updateAgentStatus;
// (no monkey-patch needed — the agent-manager already calls updateAgentStatus;
//  the /api/agents/:channel/status route is where statuses are posted)

module.exports = { processIncomingMessage, runProfileRefreshJob };
