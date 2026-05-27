/**
 * OpenAI-Compatible Endpoint Client
 *
 * Works with ANY server that implements the OpenAI Chat Completions API:
 *   • Ollama      → http://localhost:11434/v1/chat/completions
 *   • LM Studio   → http://localhost:1234/v1/chat/completions
 *   • llamafile   → http://localhost:8080/v1/chat/completions
 *   • text-gen-webui → http://localhost:5000/v1/chat/completions
 *   • OpenAI      → https://api.openai.com/v1/chat/completions
 *   • Claude      → use src/ai/claude-client.js instead
 *   • Any proxy   → set OPENAI_COMPAT_ENDPOINT to the full URL
 *
 * Environment variables:
 *   AI_PROVIDER=openai_compat         ← selects this client
 *   OPENAI_COMPAT_ENDPOINT            ← full URL to /v1/chat/completions
 *   OPENAI_COMPAT_MODEL               ← model name (e.g. "llama3", "mistral", "gpt-4o-mini")
 *   OPENAI_COMPAT_API_KEY             ← optional; omit for local servers
 *   OPENAI_COMPAT_TEMPERATURE=0.7     ← 0.0–2.0
 *   OPENAI_COMPAT_MAX_TOKENS=600
 *   OPENAI_COMPAT_TIMEOUT_MS=30000
 *
 * Quick presets (set AI_PROVIDER=openai_compat and one of these):
 *   LM_STUDIO=true        → endpoint=http://localhost:1234/v1/chat/completions
 *   LLAMAFILE=true         → endpoint=http://localhost:8080/v1/chat/completions
 *   OPENAI=true           → endpoint=https://api.openai.com/v1/chat/completions
 *   (OLLAMA preset is just the default Ollama URL)
 */

'use strict';

const axios = require('axios');
const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages } = require('../brain/stats-engine');

// ── Preset resolver ───────────────────────────────────────────

function resolveEndpoint() {
  if (process.env.OPENAI_COMPAT_ENDPOINT) return process.env.OPENAI_COMPAT_ENDPOINT;
  if (process.env.LM_STUDIO === 'true')    return 'http://localhost:1234/v1/chat/completions';
  if (process.env.LLAMAFILE === 'true')     return 'http://localhost:8080/v1/chat/completions';
  if (process.env.OPENAI === 'true')        return 'https://api.openai.com/v1/chat/completions';
  // Default → Ollama's OpenAI-compat shim
  return (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1/chat/completions';
}

function resolveModel() {
  if (process.env.OPENAI_COMPAT_MODEL) return process.env.OPENAI_COMPAT_MODEL;
  if (process.env.LM_STUDIO === 'true')  return 'local-model';
  if (process.env.LLAMAFILE === 'true')  return 'LLaMA_CPP';
  if (process.env.OPENAI === 'true')     return 'gpt-4o-mini';
  return process.env.OLLAMA_MODEL || 'llama3.1';
}

// ── Message formatter ─────────────────────────────────────────

function buildMessages({ contact, recentMessages, incomingMessage, userPersona, decision, stats, memoryBlock, toolContext, preferenceBlock }) {
  const systemContent = [
    userPersona || 'I am a thoughtful, calm communicator. I prefer natural, short replies.',
    '',
    `Contact: ${contact.displayName || contact.display_name || contact.externalContactId}`,
    `Stage: ${contact.conversationStage || contact.conversation_stage || 'initial'}`,
    `Profile: ${contact.profileSummary || contact.profile_summary || 'No profile yet.'}`,
    '',
    `Decision: ${decision.action} (${decision.confidence}% confidence)`,
    `Reason: ${decision.reason}`,
    `Best move: ${decision.best_move}`,
    `Avoid: ${decision.avoid}`,
    stats.warmthScore != null ? `Warmth: ${stats.warmthScore}/100` : '',
    stats.theirAvgResponseMin != null
      ? `Their avg reply gap: ${stats.theirAvgResponseMin}m (yours: ${stats.yourAvgResponseMin ?? '?'}m, trend: ${stats.cadenceTrend || 'stable'})`
      : '',
    stats.momentumLabel && stats.momentumLabel !== 'unknown' && stats.momentumLabel !== 'steady'
      ? `Conversation momentum: ${stats.momentumLabel}`
      : '',
    incomingMessage.media_type && incomingMessage.media_type !== 'text'
      ? `Media type: ${incomingMessage.media_type}${incomingMessage.media_summary ? ' — ' + incomingMessage.media_summary : ''}`
      : '',
    memoryBlock     ? memoryBlock     : '',
    toolContext     ? toolContext     : '',
    preferenceBlock ? preferenceBlock : '',
    '',
    'Return ONLY a JSON object with this exact shape (no markdown, no preamble):',
    '{ "options": [ { "tone": "...", "text": "...", "rationale": "...", "score": 85, "risk": "low", "action": "reply" }, ... ] }',
    'Provide exactly 3 options. Tone values: casual, playful, warm, direct, supportive, repair, soft.',
    'Risk values: low, medium, high. Score 0-100. Keep each reply under 120 characters.',
    decision.action === 'wait'
      ? 'Include one option with action:"wait" and text:"[Wait and do not reply yet]".'
      : '',
  ].filter(Boolean).join('\n');

  const history = (recentMessages || []).slice(-20).map((m) => ({
    role: m.direction === 'outgoing' ? 'assistant' : 'user',
    content: m.body || '',
  }));

  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: incomingMessage.body || `[${incomingMessage.media_type || 'message'}]` },
  ];
}

// ── API call ──────────────────────────────────────────────────

async function callEndpoint(messages) {
  const endpoint    = resolveEndpoint();
  const model       = resolveModel();
  const temperature = Number(process.env.OPENAI_COMPAT_TEMPERATURE || 0.7);
  const max_tokens  = Number(process.env.OPENAI_COMPAT_MAX_TOKENS  || 600);
  const timeoutMs   = Number(process.env.OPENAI_COMPAT_TIMEOUT_MS  || 30_000);
  const apiKey      = process.env.OPENAI_COMPAT_API_KEY || 'none';  // local servers ignore this

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey !== 'none' ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const body = { model, messages, temperature, max_tokens, stream: false };

  const res = await axios.post(endpoint, body, { headers, timeout: timeoutMs });

  // OpenAI-compat format: choices[0].message.content
  const text = res.data?.choices?.[0]?.message?.content
    // Ollama native format fallback
    || res.data?.message?.content
    || '';

  return String(text).trim();
}

// ── Response parser ───────────────────────────────────────────

function parseOptions(text) {
  // Strip markdown code fences if the model added them
  const clean = text.replace(/```(?:json)?/g, '').trim();
  const parsed = JSON.parse(clean);
  const raw = Array.isArray(parsed) ? parsed : (parsed.options || []);
  return raw.slice(0, 5);
}

// ── Test connection ───────────────────────────────────────────

async function testConnection() {
  const messages = [
    { role: 'system', content: 'Reply with exactly: {"status":"ok"}' },
    { role: 'user',   content: 'test' },
  ];
  try {
    const text = await callEndpoint(messages);
    const json = JSON.parse(text.replace(/```(?:json)?/g, '').trim());
    return { ok: json.status === 'ok', endpoint: resolveEndpoint(), model: resolveModel() };
  } catch (err) {
    return { ok: false, error: err.message, endpoint: resolveEndpoint(), model: resolveModel() };
  }
}

// ── Main entry: generateSuggestions ──────────────────────────

async function generateSuggestionsOpenAICompat({ contact, recentMessages, incomingMessage, userPersona }) {
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats    = analyzeRecentMessages(recentMessages, incomingMessage);

  // Skip LLM if local engine already says WAIT/NO (saves tokens)
  if (['wait', 'no'].includes(decision.action) && process.env.OPENAI_COMPAT_FORCE !== 'true') {
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: 'local-free-rule-engine-compat-skipped' };
  }

  const messages = buildMessages({ contact, recentMessages, incomingMessage, userPersona, decision, stats, memoryBlock: incomingMessage._memoryBlock, toolContext: incomingMessage._toolContext, preferenceBlock: incomingMessage._preferenceBlock });

  let rawOptions = [];
  try {
    const text = await callEndpoint(messages);
    rawOptions = parseOptions(text);
  } catch (err) {
    console.warn('[openai-compat] LLM error, falling back to local rule engine:', err.message);
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: 'local-free-rule-engine-compat-fallback' };
  }

  const options = filterOptions(rawOptions);

  return {
    decision,
    stats,
    options,
    stage_analysis: null,
    next_move_hint: decision.best_move,
    provider: `openai-compat:${resolveModel()}@${resolveEndpoint()}`,
    user_persona_used: userPersona,
  };
}

// ── Profile summarisation ─────────────────────────────────────

async function summarizeProfileOpenAICompat({ contact, messages }) {
  const snippet = messages.slice(-40).map((m) =>
    `[${m.direction}] ${m.body || ''}`.slice(0, 120)
  ).join('\n');

  const prompt = [
    { role: 'system', content: 'You summarize WhatsApp conversation patterns. Return ONLY JSON, no markdown.' },
    {
      role: 'user',
      content: `Contact: ${contact.displayName || contact.display_name}\nMessages:\n${snippet}\n\n` +
        'Return: { "summary": "...", "preferredLanguage": "english|urdu|mixed|other", "emojiStyle": "none|light|heavy", "conversationStage": "initial|warming|regular|close|stale", "stats": {} }',
    },
  ];

  try {
    const text  = await callEndpoint(prompt);
    const clean = text.replace(/```(?:json)?/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.warn('[openai-compat] Profile summarization failed:', err.message);
    return {
      summary: `${contact.displayName || 'Contact'} — profile update failed.`,
      preferredLanguage: 'mixed',
      emojiStyle: 'light',
      conversationStage: contact.conversationStage || 'initial',
      stats: {},
    };
  }
}

module.exports = {
  generateSuggestionsOpenAICompat,
  summarizeProfileOpenAICompat,
  testConnection,
  resolveEndpoint,
  resolveModel,
};
