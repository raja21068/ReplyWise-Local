const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const STORE_FILE = path.resolve(process.env.STORE_FILE || path.join(DATA_DIR, 'conversationos.store.json'));

function now() { return new Date().toISOString(); }

function emptyStore() {
  return {
    contacts: [],
    messages: [],
    suggestions: [],
    outgoing_queue: [],
    personality_changelog: [],
    user_settings: {},
    agent_statuses: [],
    feedback_events: [],
    cost_log: [],
    automation_events: [],
  };
}

function ensureStoreFile() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(emptyStore(), null, 2));
  }
}

async function readStore() {
  ensureStoreFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function normalizeChannel(channel) {
  const value = String(channel || 'manual').toLowerCase().trim().replace(/_/g, '-');
  if (['wa', 'whatsapp', 'whatsapp-webjs', 'webjs'].includes(value)) return 'whatsapp';
  if (['telegram', 'tg'].includes(value)) return 'telegram';
  if (['manual', 'sandbox'].includes(value)) return 'manual';
  return value.replace(/[^a-z0-9-]/g, '') || 'manual';
}

function assertSupportedChannel(channel) {
  const ch = normalizeChannel(channel);
  if (!['whatsapp', 'telegram', 'manual'].includes(ch)) {
    throw new Error(`Unsupported channel in this MVP: ${ch}. Use whatsapp or telegram.`);
  }
  return ch;
}

function normalizeExternalId({ channel, externalContactId, whatsappId }) {
  const id = externalContactId || whatsappId;
  if (!id || !String(id).trim()) {
    throw new Error(`${normalizeChannel(channel)} externalContactId is required`);
  }
  return String(id).trim();
}

function legacyContactId(channel, externalContactId) {
  return normalizeChannel(channel) === 'whatsapp' ? externalContactId : `${normalizeChannel(channel)}:${externalContactId}`;
}

function defaultBridgeForContact(contact) {
  return `${normalizeChannel(contact && contact.channel)}-browser-agent`;
}

async function getDb() {
  const store = await readStore();
  if (!store.user_settings.user_persona) {
    store.user_settings.user_persona = 'I am calm, respectful, playful when appropriate, and prefer natural short replies. I do not pressure people.';
    await writeStore(store);
  }
  return store;
}

function normalizeContactRow(row) {
  if (!row) return row;
  return {
    ...row,
    whatsapp_id: row.whatsapp_id || legacyContactId(row.channel, row.external_contact_id),
    externalContactId: row.external_contact_id,
    displayName: row.display_name,
    profileSummary: row.profile_summary,
    preferredLanguage: row.preferred_language,
    emojiStyle: row.emoji_style,
    conversationStage: row.conversation_stage,
    contactRules: row.contact_rules || {},
    stats: row.stats || {},
  };
}

function normalizeMessageRow(row) {
  return row ? { ...row, contactId: row.contact_id } : row;
}

function normalizeSuggestionRow(row) {
  if (!row) return row;
  return {
    ...row,
    contactId: row.contact_id,
    incomingMessageId: row.incoming_message_id,
    optionsJson: row.options_json,
    decisionJson: row.decision_json,
    statsJson: row.stats_json,
    stageAnalysis: row.stage_analysis,
    nextMoveHint: row.next_move_hint,
    chosenText: row.chosen_text,
    automationJson: row.automation_json,
    recommendedText: row.recommended_text,
    recommendedOptionIndex: row.recommended_option_index,
    recommendedTone: row.recommended_tone,
  };
}

async function upsertContact({ channel = 'manual', externalContactId, whatsappId, displayName }) {
  const store = await readStore();
  const normalizedChannel = assertSupportedChannel(channel);
  const normalizedExternalId = normalizeExternalId({ channel: normalizedChannel, externalContactId, whatsappId });
  const legacyId = legacyContactId(normalizedChannel, normalizedExternalId);
  let row = store.contacts.find(c => c.channel === normalizedChannel && c.external_contact_id === normalizedExternalId);

  if (row) {
    row.display_name = displayName || row.display_name || normalizedExternalId;
    row.whatsapp_id = legacyId;
    await writeStore(store);
    return normalizeContactRow(row);
  }

  row = {
    id: uuidv4(),
    whatsapp_id: legacyId,
    channel: normalizedChannel,
    external_contact_id: normalizedExternalId,
    display_name: displayName || normalizedExternalId,
    profile_summary: `New ${normalizedChannel} contact. Not enough history yet. Keep replies short, respectful, and natural.`,
    preferred_language: 'mixed',
    emoji_style: 'light',
    conversation_stage: 'initial',
    contact_rules: {
      memory_depth: 'normal',
      can_read: true,
      can_suggest: true,
      can_send_after_approval: true,
      autopilot_mode: 'manual',
      auto_send_whitelisted: false,
    },
    stats: {},
    is_tracked: true,
    last_updated: null,
    created_at: now(),
  };
  store.contacts.push(row);
  await writeStore(store);
  return normalizeContactRow(row);
}

async function getContactById(id) {
  const store = await readStore();
  return normalizeContactRow(store.contacts.find(c => c.id === id));
}

async function getContactByExternalId(channel, externalContactId) {
  const store = await readStore();
  return normalizeContactRow(store.contacts.find(c => c.channel === normalizeChannel(channel) && c.external_contact_id === String(externalContactId || '').trim()));
}

async function listContacts() {
  const store = await readStore();
  return store.contacts
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(c => {
      const msgs = store.messages.filter(m => m.contact_id === c.id).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      return normalizeContactRow({ ...c, message_count: msgs.length, last_message: msgs[0]?.body || null });
    });
}

async function insertMessage({ contactId, direction, body, timestamp, metadata }) {
  const store = await readStore();
  const row = {
    id: uuidv4(),
    contact_id: contactId,
    timestamp: timestamp || now(),
    direction,
    body,
    metadata: metadata || null,
    created_at: now(),
  };
  store.messages.push(row);
  await writeStore(store);
  return normalizeMessageRow(row);
}

async function getRecentMessages(contactId, limit = 30) {
  const store = await readStore();
  return store.messages
    .filter(m => m.contact_id === contactId)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, Number(limit || 30))
    .reverse()
    .map(normalizeMessageRow);
}

async function getMessagesSinceLastProfile(contactId, maxMessages = 200) {
  const store = await readStore();
  const contact = store.contacts.find(c => c.id === contactId);
  return store.messages
    .filter(m => m.contact_id === contactId && (!contact?.last_updated || String(m.timestamp) > String(contact.last_updated)))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, Number(maxMessages || 200))
    .reverse()
    .map(normalizeMessageRow);
}

async function createSuggestion({ contactId, incomingMessageId, result }) {
  const store = await readStore();
  const row = {
    id: uuidv4(),
    contact_id: contactId,
    incoming_message_id: incomingMessageId,
    decision_json: result.decision || {},
    options_json: result.options || [],
    stats_json: result.stats || {},
    stage_analysis: result.stage_analysis || '',
    next_move_hint: result.next_move_hint || '',
    automation_json: result.automation || {},
    recommended_text: result.automation?.recommended_text || null,
    recommended_option_index: result.automation?.recommended_index ?? null,
    recommended_tone: result.automation?.recommended_tone || null,
    status: 'pending',
    chosen_text: null,
    created_at: now(),
    decided_at: null,
  };
  store.suggestions.push(row);
  store.cost_log.push({ id: uuidv4(), type: result.provider || 'local', cost: 0, created_at: now(), note: 'local/free suggestion generation' });
  if (result.automation) {
    store.automation_events.push({
      id: uuidv4(),
      suggestion_id: row.id,
      contact_id: contactId,
      event_type: result.automation.auto_send?.allowed ? 'auto_send_allowed' : result.automation.auto_choose?.allowed ? 'auto_chosen' : 'manual_required',
      payload: result.automation,
      created_at: now(),
    });
  }
  await writeStore(store);
  return normalizeSuggestionRow(row);
}

async function getSuggestionById(id) {
  const store = await readStore();
  const s = store.suggestions.find(x => x.id === id);
  if (!s) return null;
  const c = store.contacts.find(x => x.id === s.contact_id) || {};
  const m = store.messages.find(x => x.id === s.incoming_message_id) || {};
  return normalizeSuggestionRow({
    ...s,
    display_name: c.display_name,
    channel: c.channel,
    external_contact_id: c.external_contact_id,
    whatsapp_id: c.whatsapp_id,
    incoming_body: m.body,
    contact: normalizeContactRow(c),
    incomingMessage: normalizeMessageRow(m),
  });
}

async function listPendingSuggestions() {
  const store = await readStore();
  return store.suggestions
    .filter(s => s.status === 'pending')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(s => {
      const c = store.contacts.find(x => x.id === s.contact_id) || {};
      const m = store.messages.find(x => x.id === s.incoming_message_id) || {};
      return normalizeSuggestionRow({
        ...s,
        display_name: c.display_name,
        channel: c.channel,
        external_contact_id: c.external_contact_id,
        whatsapp_id: c.whatsapp_id,
        incoming_body: m.body,
        contact: normalizeContactRow(c),
        incomingMessage: normalizeMessageRow(m),
      });
    });
}

async function approveSuggestion({ suggestionId, chosenText, bridge, source = 'manual_approval', status = 'approved' }) {
  const store = await readStore();
  const suggestion = store.suggestions.find(s => s.id === suggestionId);
  if (!suggestion) throw new Error('Suggestion not found');
  if (suggestion.status !== 'pending') throw new Error('Suggestion already decided');
  const contact = store.contacts.find(c => c.id === suggestion.contact_id);
  if (!contact) throw new Error('Contact not found');
  const sendBridge = bridge || defaultBridgeForContact(contact);
  const ts = now();

  suggestion.status = status || 'approved';
  suggestion.chosen_text = chosenText;
  suggestion.decided_at = ts;

  const msg = {
    id: uuidv4(),
    contact_id: contact.id,
    timestamp: ts,
    direction: 'outgoing',
    body: chosenText,
    metadata: { source, suggestion_id: suggestionId, bridge: sendBridge },
    created_at: ts,
  };
  store.messages.push(msg);

  const queue = {
    id: uuidv4(),
    contact_id: contact.id,
    whatsapp_id: contact.whatsapp_id,
    channel: contact.channel,
    external_contact_id: contact.external_contact_id,
    body: chosenText,
    bridge: sendBridge,
    source,
    status: process.env.DRY_RUN_SEND === 'true' ? 'dry_run' : 'pending',
    error_log: null,
    created_at: ts,
    sent_at: null,
    failed_at: null,
  };
  store.outgoing_queue.push(queue);
  store.automation_events.push({ id: uuidv4(), suggestion_id: suggestionId, contact_id: contact.id, event_type: source, payload: { status: suggestion.status, chosenText, queueId: queue.id }, created_at: ts });
  await writeStore(store);
  return { queueId: queue.id, contact: normalizeContactRow(contact), body: chosenText, bridge: sendBridge };
}

async function skipSuggestion(suggestionId) {
  const store = await readStore();
  const suggestion = store.suggestions.find(s => s.id === suggestionId);
  if (suggestion && suggestion.status === 'pending') {
    suggestion.status = 'skipped';
    suggestion.decided_at = now();
    await writeStore(store);
  }
}

async function waitSuggestion(suggestionId, waitMinutes = 30) {
  const store = await readStore();
  const suggestion = store.suggestions.find(s => s.id === suggestionId);
  if (suggestion && suggestion.status === 'pending') {
    suggestion.status = 'waiting';
    suggestion.wait_until = new Date(Date.now() + Number(waitMinutes || 30) * 60 * 1000).toISOString();
    suggestion.decided_at = now();
    await writeStore(store);
  }
}

async function getPendingOutgoing({ channel = null, limit = 10 } = {}) {
  const store = await readStore();
  const ch = channel ? normalizeChannel(channel) : null;
  return store.outgoing_queue
    .filter(q => q.status === 'pending' && (!ch || normalizeChannel(q.channel) === ch))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, Number(limit || 10))
    .map(q => {
      const c = store.contacts.find(x => x.id === q.contact_id) || {};
      return { ...q, display_name: c.display_name, contact: normalizeContactRow(c), externalContactId: q.external_contact_id, displayName: c.display_name };
    });
}

async function markOutgoingSent(id) {
  const store = await readStore();
  const row = store.outgoing_queue.find(q => q.id === id);
  if (row) {
    row.status = 'sent';
    row.sent_at = now();
    await writeStore(store);
  }
}

async function markOutgoingFailed(id, errorLog = 'Unknown error') {
  const store = await readStore();
  const row = store.outgoing_queue.find(q => q.id === id);
  if (row) {
    row.status = 'failed';
    row.error_log = String(errorLog).slice(0, 500);
    row.failed_at = now();
    await writeStore(store);
  }
}

async function listOutgoingQueue() {
  const store = await readStore();
  return store.outgoing_queue.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30);
}

async function getSetting(key) {
  const store = await readStore();
  return store.user_settings[key] || null;
}

async function setSetting(key, value) {
  const store = await readStore();
  store.user_settings[key] = String(value);
  await writeStore(store);
}

async function updateContactProfile({ contactId, summary, preferredLanguage, emojiStyle, conversationStage, stats }) {
  const store = await readStore();
  const contact = store.contacts.find(c => c.id === contactId);
  if (!contact) throw new Error('Contact not found');
  contact.profile_summary = summary || contact.profile_summary || 'Not enough information yet.';
  contact.preferred_language = preferredLanguage || contact.preferred_language || 'mixed';
  contact.emoji_style = emojiStyle || contact.emoji_style || 'light';
  contact.conversation_stage = conversationStage || contact.conversation_stage || 'initial';
  contact.stats = { ...(contact.stats || {}), ...(stats || {}) };
  contact.last_updated = now();
  store.personality_changelog.push({ id: uuidv4(), contact_id: contactId, summary_text: contact.profile_summary, generated_at: now() });
  await writeStore(store);
}

async function contactsNeedingRefresh(minNewMessages = 25) {
  const store = await readStore();
  return store.contacts.filter(c => {
    if (c.is_tracked === false || c.is_tracked === 0) return false;
    const count = store.messages.filter(m => m.contact_id === c.id && (!c.last_updated || String(m.timestamp) > String(c.last_updated))).length;
    c.new_message_count = count;
    return count >= Number(minNewMessages || 25);
  }).map(normalizeContactRow);
}

async function updateContactRules(contactId, patch = {}) {
  const store = await readStore();
  const contact = store.contacts.find(c => c.id === contactId);
  if (!contact) throw new Error('Contact not found');
  contact.contact_rules = { ...(contact.contact_rules || {}), ...patch };
  contact.updated_at = now();
  await writeStore(store);
  return normalizeContactRow(contact);
}

async function updateAgentStatus(channel, status, errorLog = null) {
  const store = await readStore();
  const ch = normalizeChannel(channel);
  let row = store.agent_statuses.find(a => a.channel === ch);
  if (!row) {
    row = { channel: ch, status: 'unknown', errorLog: null, updatedAt: now() };
    store.agent_statuses.push(row);
  }
  row.status = status;
  row.errorLog = errorLog || null;
  row.error_log = errorLog || null;
  row.updatedAt = now();
  row.updated_at = row.updatedAt;
  await writeStore(store);
}

async function getAgentStatuses() {
  const store = await readStore();
  return store.agent_statuses.slice().sort((a,b)=>String(a.channel).localeCompare(String(b.channel)));
}

async function countAutoSendsToday() {
  const store = await readStore();
  const today = new Date().toISOString().slice(0, 10);
  return store.outgoing_queue.filter(q =>
    q.source === 'smart_autopilot_auto_send' && String(q.created_at || '').startsWith(today)
  ).length;
}

async function getCostSummary() {
  const store = await readStore();
  const today = new Date().toISOString().slice(0, 10);
  const todays = store.cost_log.filter(x => String(x.created_at || '').startsWith(today));
  return {
    estimatedCostUsd: todays.reduce((sum, x) => sum + Number(x.cost || 0), 0),
    localActions: todays.length,
    screenshotsUsed: 0,
    cloudAiCalls: 0,
  };
}

async function disconnect() {}

module.exports = {
  getDb,
  normalizeChannel,
  assertSupportedChannel,
  normalizeExternalId,
  defaultBridgeForContact,
  upsertContact,
  getContactById,
  getContactByExternalId,
  listContacts,
  insertMessage,
  getRecentMessages,
  getMessagesSinceLastProfile,
  createSuggestion,
  getSuggestionById,
  listPendingSuggestions,
  approveSuggestion,
  skipSuggestion,
  waitSuggestion,
  getPendingOutgoing,
  markOutgoingSent,
  markOutgoingFailed,
  listOutgoingQueue,
  getSetting,
  setSetting,
  updateContactProfile,
  contactsNeedingRefresh,
  updateContactRules,
  updateAgentStatus,
  getAgentStatuses,
  countAutoSendsToday,
  getCostSummary,
  disconnect,
  readStore,
  writeStore,
};
