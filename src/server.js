require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const db = require('./db');
const ai = require('./ai');
const { evaluateAutopilot } = require('./brain/autopilot-engine');
const { assertHumanApproval, cleanSuggestionText, isSystemInstructionText } = require('./safety/guardrails');

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
    res.send(renderDashboard({
      contacts,
      pendingSuggestions,
      outgoingQueue,
      agentStatuses,
      costSummary,
      env: {
        aiProvider: process.env.AI_PROVIDER || 'local',
        enabledAgents: process.env.ENABLED_AGENTS || 'whatsapp,telegram',
        screenshots: screenshotsEnabled(),
        dryRun: boolEnv('DRY_RUN_SEND', false),
        autoChoose: boolEnv('AUTO_CHOOSE_ENABLED', true),
        autoSend: boolEnv('AUTO_SEND_ENABLED', false),
        autoSendWhitelistOnly: boolEnv('AUTO_SEND_WHITELIST_ONLY', true),
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
    await db.approveSuggestion({ suggestionId: req.params.id, chosenText, bridge: req.body.bridge });
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
    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/suggestions/:id/skip', async (req, res, next) => {
  try {
    await db.skipSuggestion(req.params.id);
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
  try { await db.updateAgentStatus(req.params.channel, req.body.status, req.body.errorLog); res.json({ ok: true }); } catch (err) { next(err); }
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

async function processIncomingMessage({ channel, externalContactId, displayName, body, timestamp, metadata }) {
  const normalizedChannel = db.assertSupportedChannel(channel);
  if (!body || !String(body).trim()) throw new Error('body is required');
  if (String(body).length > 4000) throw new Error('body too long');
  if (!externalContactId) throw new Error('externalContactId is required');

  const contact = await db.upsertContact({ channel: normalizedChannel, externalContactId: String(externalContactId).trim(), displayName });
  const incoming = await db.insertMessage({
    contactId: contact.id,
    direction: 'incoming',
    body: String(body).trim(),
    timestamp: parseTimestamp(timestamp),
    metadata: { channel: normalizedChannel, ...metadata },
  });
  const recentMessages = await db.getRecentMessages(contact.id, Number(process.env.MAX_RECENT_MESSAGES || 30));
  const userPersona = await db.getSetting('user_persona');
  const result = await ai.generateSuggestions({ contact, recentMessages, incomingMessage: incoming, userPersona });
  const autoSendsToday = await db.countAutoSendsToday();
  result.automation = evaluateAutopilot({ contact, decision: result.decision, stats: result.stats, options: result.options, incomingMessage: incoming, recentMessages, autoSendsToday });

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

  return { contact, incoming, suggestion, result, autoSent };
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

function renderDashboard({ contacts, pendingSuggestions, outgoingQueue, agentStatuses, costSummary, env }) {
  const agentCards = ['whatsapp', 'telegram'].map(ch => {
    const a = (agentStatuses || []).find(x => x.channel === ch) || { channel: ch, status: 'not_started' };
    const icon = a.status === 'active' ? '🟢' : a.status === 'login_required' ? '🟡' : '⚪';
    return `<div class="mini-card"><strong>${icon} ${ch}</strong><br><span>${esc(a.status)}</span>${a.status === 'login_required' ? `<br><a href="/reauth/${ch}">Re-auth</a>` : ''}${a.errorLog ? `<p class="muted">${esc(a.errorLog)}</p>` : ''}</div>`;
  }).join('');

  const suggestionCards = (pendingSuggestions || []).map(renderSuggestionCard).join('') || '<div class="empty">No pending decisions. Send a sandbox message below.</div>';

  const contactRows = (contacts || []).slice(0, 12).map(c => {
    const rules = c.contactRules || c.contact_rules || {};
    const mode = rules.autopilot_mode || 'manual';
    const checked = rules.auto_send_whitelisted ? 'checked' : '';
    return `
    <tr><td>${esc(c.channel)}</td><td>${esc(c.displayName || c.display_name || c.externalContactId)}</td><td>${esc(c.conversationStage || c.conversation_stage || 'initial')}</td><td>${esc(c.message_count || 0)}</td><td><form method="POST" action="/api/contacts/${esc(c.id)}/autopilot"><select name="autopilotMode"><option value="manual" ${mode === 'manual' ? 'selected' : ''}>manual</option><option value="auto_choose" ${mode === 'auto_choose' ? 'selected' : ''}>auto-choose</option><option value="auto_send_safe" ${mode === 'auto_send_safe' ? 'selected' : ''}>auto-send safe</option></select><label class="muted"><input type="checkbox" name="autoSendWhitelisted" ${checked}> whitelist</label><button class="ghost" type="submit">Save</button></form></td></tr>`;
  }).join('');

  const queueRows = (outgoingQueue || []).slice(0, 8).map(q => `
    <tr><td>${esc(q.channel)}</td><td>${esc(q.status)}</td><td>${esc(q.body).slice(0, 70)}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><title>ReplyWise Local</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#f7f4ed;--card:#fff;--text:#1f2937;--muted:#6b7280;--line:#e5e7eb;--brand:#111827;--green:#DCFCE7;--yellow:#FEF3C7;--red:#FEE2E2;--blue:#DBEAFE}
  *{box-sizing:border-box} body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--text)}
  .wrap{max-width:860px;margin:0 auto;padding:14px}.hero{padding:18px 2px 10px}.hero h1{margin:0;font-size:30px;letter-spacing:-.03em}.hero p{margin:6px 0;color:var(--muted)}
  .tagline{font-size:18px;font-weight:800;color:#000}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mini-card,.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px;box-shadow:0 1px 0 rgba(0,0,0,.03)}
  .metric{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.pill{display:inline-block;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:700;background:#eee}.yes{background:var(--green)}.wait{background:var(--yellow)}.no,.end{background:var(--red)}.repair{background:var(--blue)}
  .decision{border-radius:16px;padding:14px;margin:10px 0}.decision h2{margin:0 0 4px;font-size:22px}.muted{color:var(--muted);font-size:13px}.message{font-size:19px;line-height:1.4;background:#f9fafb;padding:12px;border-radius:14px;border:1px solid #eee}
  .option{border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0;background:#fff}.option-top{display:flex;justify-content:space-between;gap:8px;align-items:center}.score{font-weight:900}.risk-low{color:#15803d}.risk-medium{color:#b45309}.risk-high{color:#b91c1c}
  button{border:0;border-radius:10px;padding:10px 13px;font-weight:800;cursor:pointer;background:#111827;color:white}.secondary{background:#e5e7eb;color:#111827}.danger{background:#fee2e2;color:#991b1b}.ghost{background:transparent;color:#111827;border:1px solid var(--line)}
  form{display:inline}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.custom{display:flex;gap:8px;margin-top:8px}.custom input{flex:1;border:1px solid var(--line);border-radius:10px;padding:11px}
  section{margin:18px 0} h3{margin:0 0 8px} table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}td,th{padding:9px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}th{background:#f3f4f6}.sandbox input,.sandbox select{border:1px solid var(--line);border-radius:10px;padding:10px;margin:4px 0;width:100%}.empty{padding:18px;border:1px dashed #bbb;border-radius:16px;text-align:center;color:var(--muted)}
  @media (max-width:720px){.grid{grid-template-columns:1fr}.hero h1{font-size:26px}.custom{flex-direction:column}.option-top{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="wrap">
  <div class="hero"><h1>ReplyWise Local</h1><p class="tagline">It does not just write replies. It tells you whether replying is a good idea.</p><p>Free-cost mode · AI: ${esc(env.aiProvider)} · Agents: ${esc(env.enabledAgents)} · Screenshots: ${env.screenshots ? 'debug only' : 'off'} · Auto-choose: ${env.autoChoose ? 'on' : 'off'} · Auto-send: ${env.autoSend ? 'on' : 'off'} · Dry run: ${env.dryRun ? 'on' : 'off'}</p></div>

  <section class="grid">${agentCards}<div class="mini-card"><strong>💸 Cost today</strong><br><span>$${Number(costSummary.estimatedCostUsd || 0).toFixed(2)}</span><p class="muted">Local actions: ${esc(costSummary.localActions)} · Screenshots: 0 · Cloud AI: 0</p></div><div class="mini-card"><strong>🧠 Smart Autopilot</strong><br><span>${env.autoSend ? 'Safe auto-send enabled' : env.autoChoose ? 'Auto-choose only' : 'Manual'}</span><p class="muted">Risky messages always require review. Official messaging API keys: none.</p></div></section>

  <section><h3>Pending Decisions</h3>${suggestionCards}</section>

  <section><h3>Sandbox Test</h3><div class="card sandbox"><form method="POST" action="/api/sandbox/whatsapp/incoming"><select name="channel" onchange="this.form.action='/api/sandbox/'+this.value+'/incoming'"><option>whatsapp</option><option>telegram</option></select><input name="externalContactId" placeholder="contact_id e.g. tg_ayesha" required><input name="displayName" placeholder="Display name"><input name="body" placeholder="Incoming message" required><button type="submit">Analyze Message</button></form></div></section>

  <section><h3>Contacts</h3><table><tr><th>Channel</th><th>Name</th><th>Stage</th><th>Msgs</th><th>Autopilot</th></tr>${contactRows || '<tr><td colspan="5">No contacts yet</td></tr>'}</table></section>

  <section><h3>Outgoing Queue</h3><table><tr><th>Channel</th><th>Status</th><th>Body</th></tr>${queueRows || '<tr><td colspan="3">No outgoing messages</td></tr>'}</table></section>

  <section><form method="POST" action="/api/profile-refresh/run"><button class="secondary" type="submit">Refresh Memory</button></form></section>
</div><script>setTimeout(()=>location.reload(),20000)</script></body></html>`;
}

function renderSuggestionCard(s) {
  const options = safeJson(s.optionsJson, []);
  const decision = safeJson(s.decisionJson, {});
  const stats = safeJson(s.statsJson, {});
  const automation = safeJson(s.automationJson || s.automation_json, {});
  const incomingBody = s.incomingMessage?.body || s.incoming_body || '';
  const contactName = s.contact?.displayName || s.display_name || 'Unknown';
  const ch = s.contact?.channel || s.channel || '';
  const action = decision.action || decision.should_reply || 'yes';
  const actionLabel = action === 'yes' ? '✅ Reply now' : action === 'wait' ? '⏳ Wait' : action === 'repair' ? '🔧 Repair' : action === 'no' ? '❌ Do not reply' : '🚪 End politely';
  const decisionClass = ['yes','wait','repair','no','end'].includes(action) ? action : 'yes';
  const optionBlocks = options.map((opt, idx) => {
    const text = opt.text || '';
    const systemInstruction = isSystemInstructionText(text) || opt.action === 'wait' || opt.action === 'skip';
    const sendButton = systemInstruction ? '' : `<form method="POST" action="/api/suggestions/${esc(s.id)}/approve"><input type="hidden" name="chosenText" value="${esc(text)}"><button type="submit">Send</button></form>`;
    const chosen = Number(automation.recommended_index) === idx ? '<span class="pill yes">Auto-chosen</span>' : '';
    return `<div class="option"><div class="option-top"><strong>${esc(opt.tone || 'reply')} ${chosen}</strong><span class="score risk-${esc(opt.risk || 'low')}">${esc(opt.score || 75)}/100 · ${esc(opt.risk || 'low')}</span></div><p>${esc(text)}</p><p class="muted">Why: ${esc(opt.rationale || '')}</p><div class="actions">${sendButton}</div></div>`;
  }).join('');

  return `<div class="card">
    <div class="metric"><span class="pill">${esc(ch.toUpperCase())}</span><span class="pill">${esc(contactName)}</span><span class="pill ${decisionClass}">${esc(actionLabel)}</span><span class="pill">Confidence ${esc(decision.confidence || 70)}%</span><span class="pill">${esc(decision.temperature || 'neutral')}</span></div>
    <div class="message">${esc(incomingBody)}</div>
    <div class="decision ${decisionClass}"><h2>${esc(actionLabel)}</h2><p><strong>Why:</strong> ${esc(decision.reason || 'Analyze and match energy.')}</p><p><strong>Best move:</strong> ${esc(decision.best_move || s.nextMoveHint || '')}</p><p><strong>Avoid:</strong> ${esc(decision.avoid || 'Avoid over-investing.')}</p></div>
    <div class="metric"><span class="pill">Your/her energy: ${esc(stats.energyRatio || '1')}x</span><span class="pill">Warmth: ${esc(stats.warmthScore || 50)}/100</span><span class="pill">Avg her words: ${esc(stats.incomingAvgWords || 0)}</span><span class="pill">Avg your words: ${esc(stats.outgoingAvgWords || 0)}</span></div>
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
  console.log(`\nConversationOS Local running at http://localhost:${port}`);
  console.log('Killer promise: It tells you whether replying is a good idea.');
  console.log(`AI: ${process.env.AI_PROVIDER || 'local'} · Agents: ${process.env.ENABLED_AGENTS || 'whatsapp,telegram'} · Screenshots: ${screenshotsEnabled() ? 'debug only' : 'off'}`);
  console.log('Zero messaging API keys. Manual approval required for every outgoing message.\n');
});

module.exports = { processIncomingMessage, runProfileRefreshJob };
