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
    const [contacts, pendingSuggestions, outgoingQueue, agentStatuses, costSummary] = await Promise.all([
      db.listContacts(),
      db.listPendingSuggestions(),
      db.listOutgoingQueue(),
      db.getAgentStatuses(),
      db.getCostSummary(),
    ]);
    const providerStatus = typeof ai.getProviderStatus === 'function' ? ai.getProviderStatus() : null;
    res.send(renderDashboard({
      contacts,
      pendingSuggestions,
      outgoingQueue,
      agentStatuses,
      costSummary,
      providerStatus,
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
    }));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Ingest API — browser agents POST incoming text here
// ═══════════════════════════════════════════════════════════

app.post('/api/ingest/:channel', async (req, res, next) => {
  try {
    const result = await processIncomingMessage({
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
    const result = await processIncomingMessage({
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

async function processIncomingMessage({
  channel, externalContactId, displayName, body, timestamp, metadata,
  media_type, media_summary,
  is_group = false, author = null, mentioned_me = false, reply_to_me = false,
  is_forwarded = false, is_starred = false, local_media_path = null,
}) {
  const normalizedChannel = db.assertSupportedChannel(channel);
  if (!externalContactId) throw new Error('externalContactId is required');

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
  const memoryBlock = await memory.buildMemoryBlock({
    contactId: contact.id,
    query: incoming.body,
  }).catch(() => '');

  // ── Agentic tool-calling (web search, datetime, calculator) ──
  const toolResult = await callTools({
    body: incoming.body,
    contact,
    incomingMessage: incoming,
  }).catch(() => ({ called: false, contextBlock: '', dashboardHtml: '' }));

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

  const result = await ai.generateSuggestions({ contact, recentMessages, incomingMessage: enrichedIncoming, userPersona });

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

  const autoSendsToday = await db.countAutoSendsToday();
  result.automation = evaluateAutopilot({ contact, decision: result.decision, stats: result.stats, options: result.options, incomingMessage: enrichedIncoming, recentMessages, autoSendsToday });

  const suggestion = await db.createSuggestion({ contactId: contact.id, incomingMessageId: incoming.id, result });

  let autoSent = false;
  if (result.automation?.auto_send?.allowed && result.automation.recommended_text) {
    await db.approveSuggestion({
      suggestionId: suggestion.id,
      chosenText: result.automation.recommended_text,
      source: 'smart_autopilot_auto_send',
      status: 'auto_sent',
    });
    autoSent = true;
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

function renderDashboard({ contacts, pendingSuggestions, outgoingQueue, agentStatuses, costSummary, providerStatus, env }) {
  const contactList = contacts || [];
  const pending = pendingSuggestions || [];
  const queue = outgoingQueue || [];
  const agents = agentStatuses || [];
  const totalMessages = contactList.reduce((sum, c) => sum + Number(c.message_count || 0), 0);
  const activeSuggestion = pending[0] || null;
  const activeContact = activeSuggestion?.contact || contactList[0] || null;
  const activeRules = activeContact ? (activeContact.contactRules || activeContact.contact_rules || {}) : {};
  const activeDecision = activeSuggestion ? safeJson(activeSuggestion.decisionJson || activeSuggestion.decision_json, {}) : {};
  const activeStats = activeSuggestion ? safeJson(activeSuggestion.statsJson || activeSuggestion.stats_json, {}) : (activeContact?.stats || {});
  const activeOptions = activeSuggestion ? safeJson(activeSuggestion.optionsJson || activeSuggestion.options_json, []) : [];
  const activeIncoming = activeSuggestion?.incomingMessage?.body || activeSuggestion?.incoming_body || activeContact?.last_message || 'No incoming message selected yet.';
  const recommended = activeOptions[0]?.text || activeSuggestion?.recommendedText || activeSuggestion?.recommended_text || 'When a message arrives, ReplyWise will suggest a safe reply here.';
  const activeName = activeContact ? (activeContact.displayName || activeContact.display_name || activeContact.externalContactId || activeContact.external_contact_id || 'Unknown contact') : 'No contact yet';
  const activeChannel = activeContact ? (activeContact.channel || 'whatsapp') : 'whatsapp';
  const activeInitials = initials(activeName);
  const stage = activeContact ? (activeContact.conversationStage || activeContact.conversation_stage || 'initial') : 'not started';
  const warmth = activeStats?.warmthScore ?? activeContact?.stats?.warmthScore ?? 50;
  const leadScore = Math.max(10, Math.min(100, Math.round((Number(warmth) || 50) * 0.65 + Math.min(30, Number(activeContact?.message_count || 0)) * 0.9 + (pending.length ? 8 : 0))));
  const aiHandled = totalMessages ? Math.max(40, Math.min(99, Math.round(((queue.filter(q => ['sent', 'approved', 'auto_sent', 'queued'].includes(q.status)).length + pending.length) / Math.max(1, totalMessages)) * 100))) : 0;
  const firstAction = activeDecision?.action || activeDecision?.should_reply || 'review';
  const actionLabel = firstAction === 'yes' ? 'Reply now' : firstAction === 'wait' ? 'Wait' : firstAction === 'repair' ? 'Repair' : firstAction === 'no' ? 'Do not reply' : firstAction === 'end' ? 'End politely' : 'Review';
  const providerChain = providerStatus?.configuredChain || ['local'];
  const cloudUsage = providerStatus?.cloudUsage || {};

  const agentItems = (env.channels || ['whatsapp', 'telegram', 'wechat']).map(ch => {
    const a = agents.find(x => x.channel === ch) || { channel: ch, status: 'not_started' };
    const status = a.status || 'not_started';
    const dot = status === 'active' ? 'ok' : status === 'login_required' ? 'warn' : status === 'error' || status === 'failed' ? 'bad' : 'idle';
    return `<div class="agent-row"><span class="dot ${dot}"></span><div><strong>${esc(labelCase(ch))}</strong><small>${esc(status.replace(/_/g, ' '))}${a.errorLog ? ' · ' + esc(a.errorLog).slice(0, 80) : ''}</small></div>${status === 'login_required' ? `<a class="small-link" href="/reauth/${esc(ch)}">Re-auth</a>` : ''}</div>`;
  }).join('');

  const contactItems = contactList.slice(0, 14).map((c, index) => {
    const name = c.displayName || c.display_name || c.externalContactId || c.external_contact_id || 'Unknown';
    const rules = c.contactRules || c.contact_rules || {};
    const unread = pending.filter(s => (s.contactId || s.contact_id) === c.id).length;
    const isActive = activeContact && c.id === activeContact.id;
    const mode = rules.autopilot_mode || 'manual';
    const last = c.last_message || 'No messages yet';
    return `<div class="contact-item ${isActive ? 'active' : ''}">
      <div class="avatar tone-${index % 6}">${esc(initials(name))}</div>
      <div class="contact-copy"><strong>${esc(name)}</strong><span>${esc(last).slice(0, 58)}</span><small>${esc(c.channel || 'manual')} · ${esc(mode.replace(/_/g, ' '))}</small></div>
      ${unread ? `<b class="unread">${unread}</b>` : ''}
    </div>`;
  }).join('') || '<div class="empty slim">No contacts yet. Use the sandbox to create one.</div>';

  const decisionStrip = pending.slice(0, 3).map(s => {
    const c = s.contact || {};
    const d = safeJson(s.decisionJson || s.decision_json, {});
    const name = c.displayName || c.display_name || c.externalContactId || 'Unknown';
    const act = d.action || d.should_reply || 'review';
    return `<div class="decision-chip ${esc(act)}"><span>${esc(name)}</span><strong>${esc(act.replace(/_/g, ' '))}</strong><small>${esc(d.confidence || 70)}%</small></div>`;
  }).join('') || '<div class="empty slim">No decisions waiting.</div>';

  const suggestionCards = pending.map(renderSuggestionCard).join('') || '<div class="empty">No pending decisions. Send a sandbox message below to test the pipeline.</div>';

  const queueRows = queue.slice(0, 6).map(q => `<div class="queue-row"><span>${esc(q.channel || q.bridge || '?')}</span><strong>${esc(q.status || 'queued')}</strong><small>${esc(q.body || '').slice(0, 76)}</small></div>`).join('') || '<div class="empty slim">No outgoing messages.</div>';

  const contactControl = activeContact ? `<div class="control-card">
    <div class="panel-title">Contact AI controls</div>
    <form method="POST" action="/api/contacts/${esc(activeContact.id)}/autopilot" class="stack-form">
      <label>Decision mode</label>
      <select name="autopilotMode">
        <option value="manual" ${activeRules.autopilot_mode === 'manual' || !activeRules.autopilot_mode ? 'selected' : ''}>Manual approval</option>
        <option value="auto_choose" ${activeRules.autopilot_mode === 'auto_choose' ? 'selected' : ''}>Auto-choose best reply</option>
        <option value="auto_send_safe" ${activeRules.autopilot_mode === 'auto_send_safe' ? 'selected' : ''}>Auto-send safe replies</option>
      </select>
      <label class="check"><input type="checkbox" name="autoSendWhitelisted" ${activeRules.auto_send_whitelisted ? 'checked' : ''}> Whitelist safe auto-send</label>
      <button class="ghost" type="submit">Save mode</button>
    </form>
    <form method="POST" action="/api/contacts/${esc(activeContact.id)}/auto-reply" class="inline-control">
      <input type="hidden" name="enabled" value="false"><label class="switch"><input type="checkbox" name="enabled" value="true" ${activeRules.auto_reply_enabled ? 'checked' : ''} onchange="this.form.submit()"><span></span></label><b>Auto reply</b>
    </form>
    <form method="POST" action="/api/contacts/${esc(activeContact.id)}/reply-delay" class="stack-form">
      <label>Reply timing</label>
      <select name="mode" onchange="this.form.submit()"><option value="instant" ${activeRules.reply_delay_mode === 'instant' ? 'selected' : ''}>Instant</option><option value="normal" ${activeRules.reply_delay_mode === 'normal' || !activeRules.reply_delay_mode ? 'selected' : ''}>Natural delay</option><option value="random" ${activeRules.reply_delay_mode === 'random' ? 'selected' : ''}>Randomized</option></select>
    </form>
  </div>` : '';

  return `<!DOCTYPE html><html><head><title>ReplyWise CRM Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#f6f4ef;--panel:#fff;--soft:#f1f0eb;--line:#e5e1d8;--text:#4a4a44;--muted:#7a786f;--brand:#57c785;--brand2:#dff7e8;--dark:#2f302c;--warn:#f4b34e;--bad:#df6b62;--blue:#6ca8f7;--shadow:0 18px 60px rgba(34,31,24,.08)}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text)}
  a{color:inherit}.app{height:100vh;min-height:780px;display:grid;grid-template-columns:296px minmax(420px,1fr) 430px;overflow:hidden}.left,.right{background:#fbfaf7;border-color:var(--line)}.left{border-right:1px solid var(--line);padding:24px 18px;overflow:auto}.right{border-left:1px solid var(--line);padding:18px 14px;overflow:auto}.center{display:flex;flex-direction:column;min-width:0;background:#fff}.brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:.08em;color:#5d5d58}.brand-icon{width:28px;height:28px;border-radius:10px;background:var(--brand);color:white;display:grid;place-items:center}.section-label{margin:26px 2px 10px;color:#a09c92;font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:800}.contact-item{display:flex;align-items:center;gap:12px;padding:12px 10px;border-radius:18px;position:relative}.contact-item.active,.contact-item:hover{background:#f1f0ea}.avatar{width:43px;height:43px;border-radius:50%;display:grid;place-items:center;font-weight:900;flex:0 0 auto}.tone-0{background:#e2f8eb;color:#237a51}.tone-1{background:#e6f0ff;color:#2d63a8}.tone-2{background:#fff1d9;color:#946519}.tone-3{background:#f5e8ff;color:#71409e}.tone-4{background:#ffe7ea;color:#a04455}.tone-5{background:#e8f7f6;color:#257d80}.contact-copy{min-width:0;flex:1}.contact-copy strong{display:block;font-size:15px;color:#54544f}.contact-copy span{display:block;font-size:13px;color:#706f68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.contact-copy small{font-size:11px;color:#9d9a91}.unread{background:var(--brand);color:white;border-radius:999px;font-size:12px;min-width:24px;height:24px;display:grid;place-items:center}.topbar{height:92px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 28px;background:#fff}.identity{display:flex;gap:14px;align-items:center}.identity h1{margin:0;font-size:21px}.identity p{margin:2px 0 0;color:#77766d}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);display:inline-block;margin-right:6px}.top-actions{display:flex;gap:10px}.icon-btn,.ghost{border:1px solid var(--line);background:#fff;border-radius:14px;padding:10px 13px;font-weight:800;color:#55524b;cursor:pointer}.workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;padding:18px 22px;overflow:auto}.chat-card{border:1px solid var(--line);border-radius:26px;background:linear-gradient(180deg,#fff 0,#fbfaf6 100%);box-shadow:var(--shadow);overflow:hidden}.chat-stream{padding:24px;min-height:310px;display:flex;flex-direction:column;gap:13px}.bubble-wrap{display:flex;flex-direction:column;align-items:flex-start}.bubble-wrap.out{align-items:flex-end}.bubble{max-width:76%;padding:13px 16px;border-radius:20px;line-height:1.48;font-size:15px;box-shadow:0 1px 0 rgba(0,0,0,.04)}.bubble.in{background:#f0efea;color:#55534c;border-bottom-left-radius:7px}.bubble.ai{background:#e2f8ea;color:#427459;border-bottom-right-radius:7px}.bubble.out{background:var(--brand);color:#fff;border-bottom-right-radius:7px}.bubble-meta{font-size:11px;color:#99958b;margin-top:5px}.ai-badge{font-size:11px;color:#4fa873;font-weight:900;margin-top:5px}.composer{border-top:1px solid var(--line);padding:14px 16px;display:flex;gap:10px;background:#fff}.composer input{flex:1;border:1px solid var(--line);border-radius:999px;background:#f7f6f2;padding:13px 16px}.send{background:var(--brand);border:0;color:#fff;border-radius:50%;width:46px;height:46px;font-weight:900;cursor:pointer}.decision-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.decision-chip{background:#fff;border:1px solid var(--line);border-radius:18px;padding:12px}.decision-chip span,.decision-chip small{display:block;color:#88857c;font-size:12px}.decision-chip strong{display:block;margin:4px 0;color:#45443e}.decision-chip.yes{border-color:#b7ebc9;background:#f0fff5}.decision-chip.wait{border-color:#f5d38d;background:#fff9ea}.decision-chip.no,.decision-chip.end{border-color:#f0b0ad;background:#fff3f2}.decision-chip.repair{border-color:#bdd8ff;background:#f1f7ff}.panel{background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px;box-shadow:0 1px 0 rgba(0,0,0,.02);margin-bottom:14px}.panel-title{font-size:17px;font-weight:900;margin-bottom:12px;color:#5d5b55}.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stat{background:#f3f1ea;border-radius:17px;padding:16px}.stat strong{display:block;font-size:26px;color:#62615a;letter-spacing:-.03em}.stat span{font-size:13px;color:#77746c}.bar-chart{height:92px;display:flex;align-items:end;gap:8px;margin-top:14px}.bar-col{flex:1;text-align:center}.bar{background:var(--brand);border-radius:8px 8px 3px 3px;min-height:12px}.bar-col small{display:block;margin-top:5px;color:#97938a;font-size:11px}.agent-row{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:15px;padding:12px;margin-bottom:9px}.agent-row div{flex:1}.agent-row strong{display:block}.agent-row small{display:block;color:#77736c;margin-top:2px}.dot{width:10px;height:10px;border-radius:50%;background:#bdb8ae}.dot.ok{background:var(--brand)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.small-link{font-size:12px;font-weight:900;color:#2f8056}.info-list{display:grid;gap:10px}.info-row{display:flex;justify-content:space-between;gap:12px;font-size:14px}.info-row span{color:#77736c}.info-row strong{color:#56544e;text-align:right}.control-card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:16px;margin-bottom:14px}.stack-form{display:grid;gap:7px;margin-bottom:12px}.stack-form label{font-size:12px;color:#89857b;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.stack-form select,.stack-form textarea{width:100%;border:1px solid var(--line);border-radius:13px;padding:10px;background:#fbfaf7}.check{font-size:13px!important;color:#67645c!important;letter-spacing:0!important;text-transform:none!important}.inline-control{display:flex;align-items:center;gap:10px;margin:8px 0 14px}.switch input{display:none}.switch span{display:block;width:46px;height:26px;border-radius:999px;background:#ddd7cc;position:relative;cursor:pointer}.switch span:before{content:'';position:absolute;width:20px;height:20px;background:white;border-radius:50%;top:3px;left:3px;transition:.2s}.switch input:checked+span{background:var(--brand)}.switch input:checked+span:before{transform:translateX(20px)}.queue-row{display:grid;grid-template-columns:72px 82px 1fr;gap:8px;border-bottom:1px solid #eee9df;padding:9px 0;font-size:12px}.queue-row strong{color:#555}.empty{border:1px dashed #cac4b8;border-radius:18px;padding:18px;text-align:center;color:#88847a;background:#fff}.empty.slim{padding:12px;font-size:13px}.sandbox input,.sandbox select{width:100%;border:1px solid var(--line);border-radius:13px;padding:11px;margin:5px 0;background:#fbfaf7}.sandbox button,button{border:0;border-radius:13px;padding:11px 14px;font-weight:900;background:#2f302c;color:#fff;cursor:pointer}.secondary{background:#efede7;color:#403f3a}.danger{background:#fee2e2;color:#991b1b}.ghost{background:#fff;color:#403f3a}.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:16px;margin-bottom:14px}.metric{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.pill{display:inline-block;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:800;background:#eee}.yes{background:#ddf8e7}.wait{background:#fff1ca}.no,.end{background:#fee2e2}.repair{background:#dbeafe}.decision{border-radius:16px;padding:14px;margin:10px 0}.message{font-size:18px;line-height:1.4;background:#f9fafb;padding:12px;border-radius:14px;border:1px solid #eee}.muted{color:#77736c;font-size:13px}.option{border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0;background:#fff}.option-top{display:flex;justify-content:space-between;gap:8px;align-items:center}.risk-low{color:#15803d}.risk-medium{color:#b45309}.risk-high{color:#b91c1c}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.custom{display:flex!important;gap:8px;margin-top:8px}.custom input{flex:1;border:1px solid var(--line);border-radius:13px;padding:11px}.mobile-only{display:none}
  @media(max-width:1100px){.app{grid-template-columns:260px 1fr}.right{display:none}.mobile-only{display:block}}@media(max-width:760px){.app{display:block;height:auto;min-height:100vh}.left{border-right:0;border-bottom:1px solid var(--line)}.center{min-height:100vh}.topbar{height:auto;padding:16px;align-items:flex-start}.workspace{padding:14px}.decision-strip{grid-template-columns:1fr}.bubble{max-width:92%}.custom{flex-direction:column}.option-top{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="app">
  <aside class="left">
    <div class="brand"><div class="brand-icon">↗</div><span>REPLYWISE CRM</span></div>
    <div class="section-label">Conversations</div>${contactItems}
    <div class="section-label">AI control</div>
    ${contactControl || '<div class="empty slim">Create a contact to control AI behavior.</div>'}
    <div class="section-label">Safety</div>
    <div class="control-card"><div class="info-list"><div class="info-row"><span>Manual approval</span><strong>${env.autoSend ? 'Optional' : 'Required'}</strong></div><div class="info-row"><span>Dry run</span><strong>${env.dryRun ? 'On' : 'Off'}</strong></div><div class="info-row"><span>Screenshots</span><strong>${env.screenshots ? 'Debug only' : 'Off'}</strong></div><div class="info-row"><span>API keys</span><strong>Not required</strong></div></div></div>
  </aside>

  <main class="center">
    <div class="topbar">
      <div class="identity"><div class="avatar tone-0">${esc(activeInitials)}</div><div><h1>${esc(activeName)}</h1><p><span class="status-dot"></span>${esc(labelCase(activeChannel))} · ${esc(stage)} · ${esc(actionLabel)}</p></div></div>
      <div class="top-actions"><form method="POST" action="/api/profile-refresh/run"><button class="icon-btn" type="submit">Refresh memory</button></form><button class="icon-btn" onclick="testLLM(this)">Test AI</button></div>
    </div>
    <div class="workspace">
      <div class="decision-strip">${decisionStrip}</div>
      <div class="chat-card">
        <div class="chat-stream">
          <div class="bubble-wrap"><div class="bubble in">${esc(activeIncoming)}</div><div class="bubble-meta">Incoming · ${esc(activeChannel)}</div></div>
          <div class="bubble-wrap out"><div class="bubble ai">${esc(recommended)}</div><div class="ai-badge">🤖 Suggested by ReplyWise</div></div>
          ${activeDecision?.best_move ? `<div class="bubble-wrap out"><div class="bubble out">Best move: ${esc(activeDecision.best_move)}</div><div class="bubble-meta">Decision confidence ${esc(activeDecision.confidence || 70)}%</div></div>` : ''}
        </div>
        <div class="composer"><input placeholder="Edit a custom reply in the decision card below…"><button class="send">➤</button></div>
      </div>
      <section><div class="panel-title">Pending decisions <span id="live-indicator" class="muted" style="font-size:12px;font-weight:700">⚪ connecting…</span></div>${suggestionCards}</section>
      <section class="mobile-only"><div class="panel-title">Insights</div>${renderRightPanels()}</section>
      <section><div class="panel-title">Sandbox test</div><div class="card sandbox"><form method="POST" action="/api/sandbox/whatsapp/incoming"><select name="channel" onchange="this.form.action='/api/sandbox/'+this.value+'/incoming'"><option>whatsapp</option><option>telegram</option><option>wechat</option></select><input name="externalContactId" placeholder="contact_id e.g. customer_123" required><input name="displayName" placeholder="Display name"><input name="body" placeholder="Incoming message or leave empty for media test"><select name="media_type"><option value="text">text</option><option value="audio">audio</option><option value="image">image</option><option value="sticker">sticker</option><option value="file">file</option></select><input name="media_summary" placeholder="Optional media summary / transcript"><label class="muted" style="display:block;margin:7px 0"><input type="checkbox" name="is_group" value="true"> group chat</label><label class="muted" style="display:block;margin:7px 0"><input type="checkbox" name="mentioned_me" value="true"> directly mentioned me</label><button type="submit">Analyze message</button></form></div></section>
    </div>
  </main>

  <aside class="right">${renderRightPanels()}</aside>
</div>
<script>
  (function(){
    var indicator = document.getElementById('live-indicator');
    function connect(){
      if(!window.EventSource){ if(indicator) indicator.textContent='Live updates unavailable'; return; }
      var es = new EventSource('/api/events/stream');
      es.addEventListener('hello', function(){ if(indicator) indicator.textContent = '🟢 live'; });
      es.addEventListener('suggestion.created', function(){ if(indicator) indicator.textContent = '🔵 new message — refreshing…'; setTimeout(function(){ location.reload(); }, 450); });
      es.addEventListener('suggestion.approved', function(){ setTimeout(function(){ location.reload(); }, 600); });
      es.addEventListener('suggestion.skipped', function(){ setTimeout(function(){ location.reload(); }, 600); });
      es.addEventListener('schedule.fired', function(){ setTimeout(function(){ location.reload(); }, 600); });
      es.addEventListener('agent.status', function(e){ try{ var d = JSON.parse(e.data || '{}'); if(indicator) indicator.textContent = '🟡 ' + d.channel + ': ' + d.status; setTimeout(function(){ if(indicator) indicator.textContent='🟢 live'; }, 3000); }catch(_e){} });
      es.onerror = function(){ if(indicator) indicator.textContent = '🔴 reconnecting'; setTimeout(function(){ try{ es.close(); }catch(_e){} connect(); }, 6000); };
    }
    connect();
  })();

  async function loadScheduled(){
    var el = document.getElementById('scheduled-list');
    var count = document.getElementById('schedule-count');
    if(!el) return;
    try{
      var r = await fetch('/api/schedule/list');
      var d = await r.json();
      var list = d.scheduled || [];
      if(!list.length){ el.innerHTML = '<div class="empty slim">No scheduled sends.</div>'; if(count) count.textContent=''; return; }
      if(count) count.textContent = list.length + ' pending';
      el.innerHTML = list.map(function(q){
        var when = q.scheduled_at ? new Date(q.scheduled_at).toLocaleString() : 'soon';
        var body = String(q.body || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').slice(0,76);
        return '<div class="queue-row"><span>' + (q.bridge || '?') + '</span><strong>⏰ ' + when + '</strong><small>' + body + '</small><form method="POST" action="/api/outgoing/' + q.id + '/cancel-schedule"><button class="ghost" type="submit" style="font-size:11px">Cancel</button></form></div>';
      }).join('');
    }catch(e){ el.innerHTML = '<div class="empty slim">Could not load schedule.</div>'; }
  }
  loadScheduled(); setInterval(loadScheduled, 15000);

  async function testLLM(btn){
    var old = btn.textContent; btn.disabled = true; btn.textContent = 'Testing…';
    try{ var r = await fetch('/api/ai/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); var d = await r.json(); btn.textContent = d.ok ? 'AI connected' : 'AI failed'; setTimeout(function(){ btn.textContent = old; btn.disabled = false; }, 2500); }
    catch(e){ btn.textContent = 'AI failed'; setTimeout(function(){ btn.textContent = old; btn.disabled = false; }, 2500); }
  }
</script></body></html>`;

  function renderRightPanels() {
    const bars = [42, 64, 55, 80, 68, 96, 72].map((h, i) => `<div class="bar-col"><div class="bar" style="height:${h}px"></div><small>${['M','T','W','T','F','S','S'][i]}</small></div>`).join('');
    return `<div class="panel"><div class="panel-title">This week</div><div class="stats-grid"><div class="stat"><strong>${esc(totalMessages.toLocaleString())}</strong><span>Messages tracked</span></div><div class="stat"><strong>${esc(pending.length)}</strong><span>Need review</span></div><div class="stat"><strong>${esc(queue.length)}</strong><span>Queue items</span></div><div class="stat"><strong>${esc(aiHandled)}%</strong><span>AI assisted</span></div></div><div class="bar-chart">${bars}</div></div>
    <div class="panel"><div class="panel-title">Agents</div>${agentItems}</div>
    <div class="panel"><div class="panel-title">Contact info</div><div class="info-list"><div class="info-row"><span>Stage</span><strong>${esc(stage)}</strong></div><div class="info-row"><span>Lead / warmth score</span><strong style="color:#46ad71">${esc(leadScore)} / 100</strong></div><div class="info-row"><span>Messages</span><strong>${esc(activeContact?.message_count || 0)} total</strong></div><div class="info-row"><span>Language</span><strong>${esc(activeStats?.detectedLanguage || activeContact?.preferredLanguage || activeContact?.preferred_language || 'mixed')}</strong></div><div class="info-row"><span>Momentum</span><strong>${esc(activeStats?.momentumLabel || 'unknown')}</strong></div></div></div>
    <div class="panel"><div class="panel-title">AI provider</div><div class="info-list"><div class="info-row"><span>Mode</span><strong>${esc(env.aiProvider)}</strong></div><div class="info-row"><span>Fallback chain</span><strong>${esc(providerChain.join(' → '))}</strong></div><div class="info-row"><span>Cloud calls</span><strong>${esc(cloudUsage.totalCloudCalls || 0)} / ${esc(cloudUsage.maxCloudCallsPerDay || 0)}</strong></div><div class="info-row"><span>Cost today</span><strong>$${Number(costSummary.estimatedCostUsd || 0).toFixed(2)}</strong></div></div></div>
    <div class="panel"><div class="panel-title">Outgoing queue</div>${queueRows}</div>
    <div class="panel"><div class="panel-title">Scheduled sends <span id="schedule-count" class="muted" style="font-size:12px"></span></div><div id="scheduled-list"><div class="empty slim">Loading…</div></div></div>`;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return parts.slice(0, 2).map(p => p[0]).join('').toUpperCase();
  }

  function labelCase(value) {
    return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
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
