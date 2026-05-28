/**
 * Preference Learner
 *
 * Reads back the user's chosen suggestions per contact and builds a tone
 * preference profile. Injected into every AI prompt so the LLM gradually
 * learns which tones each contact responds well to AND which tones the user
 * personally tends to send.
 *
 * Why this matters
 * ────────────────
 * Today `chosen_text` is written to the DB but never read back. Every approval
 * is a strong signal — the user has implicitly ranked the chosen option above
 * the others. This module mines that signal.
 *
 * Scoring rule (per suggestion):
 *   chosen tone   → +2 score
 *   skipped tones →  −1 score each
 *   custom reply  → +2 to "custom" bucket (signals "AI options were not quite right")
 *
 * Per-contact aggregation:
 *   topTones     → 3 tones with highest cumulative score
 *   avoidTones   → 2 tones with most negative score
 *   avgChosenLen → average length of chosen replies (chars)
 *   customRate   → % of approvals where user wrote their own reply
 *
 * The result is rendered as a short text block injected into AI prompts:
 *
 *   "Tone preferences for this contact: prefers casual + warm, avoid playful.
 *    Average reply length: ~28 chars. Custom-write rate: 12%."
 *
 * Cost: O(n) over last LOOKBACK_LIMIT suggestions, run once per pipeline call.
 *       Cached for 60s per contact via _cache to avoid redundant scans.
 */

'use strict';

const LOOKBACK_LIMIT = 30;       // last N suggestions per contact
const CACHE_TTL_MS   = 60 * 1000;

const _cache = new Map();         // contactId → { ts, profile }

// ── Public: record a feedback event ──────────────────────────

/**
 * Called from approveSuggestion / skipSuggestion to log what happened.
 * Writes a single row to `feedback_events` in the store.
 *
 * @param {object} db         the db module
 * @param {object} params
 * @param {string} params.contactId
 * @param {string} params.suggestionId
 * @param {object} params.suggestion       full suggestion row
 * @param {string} params.chosenText
 * @param {string} params.source           'manual_approval' | 'smart_autopilot_auto_send' | 'skip' | 'wait'
 */
async function recordFeedback(db, { contactId, suggestionId, suggestion, chosenText, source }) {
  const store = await db._readStore();
  const options = parseJson(suggestion?.options_json, []);
  const chosenIdx = findChosenIndex(options, chosenText);
  const chosenTone = chosenIdx >= 0 ? options[chosenIdx]?.tone : 'custom';
  const skippedTones = options
    .filter((_, i) => i !== chosenIdx)
    .map((o) => o?.tone)
    .filter(Boolean);

  store.feedback_events = store.feedback_events || [];
  store.feedback_events.push({
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    contact_id:    contactId,
    suggestion_id: suggestionId,
    source,
    chosen_tone:   chosenTone,
    skipped_tones: skippedTones,
    chosen_len:    String(chosenText || '').length,
    was_custom:    chosenIdx < 0,
    created_at:    new Date().toISOString(),
  });

  // Keep the log bounded — drop oldest beyond 5000 rows global
  if (store.feedback_events.length > 5000) {
    store.feedback_events = store.feedback_events.slice(-5000);
  }

  await db._writeStore(store);
  _cache.delete(contactId);   // bust cache for this contact
}

// ── Public: get tone preferences for a contact ──────────────

/**
 * @returns {{
 *   topTones:    string[],
 *   avoidTones:  string[],
 *   avgChosenLen: number,
 *   customRate:   number,
 *   sampleSize:   number,
 *   promptBlock:  string,     // ready to inject
 * }}
 */
async function getPreferenceProfile(db, contactId) {
  const cached = _cache.get(contactId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.profile;
  }

  const store = await db._readStore();
  const events = (store.feedback_events || [])
    .filter((e) => e.contact_id === contactId)
    .slice(-LOOKBACK_LIMIT);

  if (!events.length) {
    const empty = {
      topTones: [], avoidTones: [], avgChosenLen: 0,
      customRate: 0, sampleSize: 0, promptBlock: '',
    };
    _cache.set(contactId, { ts: Date.now(), profile: empty });
    return empty;
  }

  // Aggregate tone scores
  const scores = new Map();
  for (const e of events) {
    if (e.chosen_tone) {
      scores.set(e.chosen_tone, (scores.get(e.chosen_tone) || 0) + 2);
    }
    for (const t of e.skipped_tones || []) {
      scores.set(t, (scores.get(t) || 0) - 1);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topTones   = ranked.filter(([, s]) => s > 0).slice(0, 3).map(([t]) => t);
  const avoidTones = ranked.filter(([, s]) => s < -1).slice(-2).map(([t]) => t);

  const customCount = events.filter((e) => e.was_custom).length;
  const customRate  = Math.round((customCount / events.length) * 100);

  const lens = events.map((e) => Number(e.chosen_len) || 0).filter((n) => n > 0);
  const avgChosenLen = lens.length
    ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)
    : 0;

  // Build the prompt block — only include if we have meaningful data
  let promptBlock = '';
  if (topTones.length || avoidTones.length || avgChosenLen) {
    const parts = [];
    if (topTones.length)   parts.push(`prefers: ${topTones.join(', ')}`);
    if (avoidTones.length) parts.push(`avoid: ${avoidTones.join(', ')}`);
    if (avgChosenLen)      parts.push(`typical reply length: ~${avgChosenLen} chars`);
    if (customRate >= 30)  parts.push(`note: user customises ${customRate}% of replies — give them more flexibility`);

    promptBlock = [
      '--- User preference history for this contact ---',
      parts.join('. ') + '.',
      `(Based on ${events.length} past approvals.)`,
      '--- End preference history ---',
    ].join('\n');
  }

  const profile = { topTones, avoidTones, avgChosenLen, customRate, sampleSize: events.length, promptBlock };
  _cache.set(contactId, { ts: Date.now(), profile });
  return profile;
}

// ── Public: scoring boost for AI options ─────────────────────

/**
 * Boost option scores based on tone preference. Called after the AI returns
 * options but before they're persisted, so the dashboard's "Auto-chosen" pill
 * reflects the learned preference.
 */
function reorderOptionsByPreference(options, profile) {
  if (!profile?.topTones?.length && !profile?.avoidTones?.length) return options;

  return options.map((opt) => {
    let boost = 0;
    if (profile.topTones.includes(opt.tone))   boost += 8;
    if (profile.avoidTones.includes(opt.tone)) boost -= 12;
    return { ...opt, score: Math.max(0, Math.min(100, (opt.score || 75) + boost)) };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ── Helpers ──────────────────────────────────────────────────

function parseJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function findChosenIndex(options, chosenText) {
  if (!chosenText || !options?.length) return -1;
  const ct = String(chosenText).trim();
  return options.findIndex((o) => String(o?.text || '').trim() === ct);
}

module.exports = {
  recordFeedback,
  getPreferenceProfile,
  reorderOptionsByPreference,
};
