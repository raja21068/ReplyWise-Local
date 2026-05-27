/**
 * OpenAI-Compatible Endpoint Client
 *
 * v7.2 makes cloud setup easier by supporting provider aliases:
 *   gemini      → Gemini OpenAI-compatible endpoint
 *   openrouter  → OpenRouter chat completions endpoint
 *   groq        → Groq OpenAI-compatible endpoint
 *   openai      → OpenAI-compatible endpoint
 *   openai_compat / lm_studio / llamafile → custom/local endpoints
 *
 * Existing env-only mode still works with AI_PROVIDER=openai_compat.
 */

'use strict';

const axios = require('axios');
const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages } = require('../brain/stats-engine');

function normProvider(provider) {
  return String(provider || process.env.AI_PROVIDER || 'openai_compat').toLowerCase().replace(/-/g, '_');
}

// ── Preset resolver ───────────────────────────────────────────

function resolveEndpoint(provider) {
  const p = normProvider(provider);
  if (p === 'gemini')     return process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  if (p === 'openrouter') return process.env.OPENROUTER_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
  if (p === 'groq')       return process.env.GROQ_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions';
  if (p === 'openai')     return process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';

  if (process.env.OPENAI_COMPAT_ENDPOINT) return process.env.OPENAI_COMPAT_ENDPOINT;
  if (process.env.LM_STUDIO === 'true')    return 'http://localhost:1234/v1/chat/completions';
  if (process.env.LLAMAFILE === 'true')    return 'http://localhost:8080/v1/chat/completions';
  if (process.env.OPENAI === 'true')       return 'https://api.openai.com/v1/chat/completions';
  return (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1/chat/completions';
}

function resolveModel(provider) {
  const p = normProvider(provider);
  if (p === 'gemini')     return process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  if (p === 'openrouter') return process.env.OPENROUTER_MODEL || 'openrouter/auto';
  if (p === 'groq')       return process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  if (p === 'openai')     return process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (process.env.OPENAI_COMPAT_MODEL) return process.env.OPENAI_COMPAT_MODEL;
  if (process.env.LM_STUDIO === 'true') return 'local-model';
  if (process.env.LLAMAFILE === 'true') return 'LLaMA_CPP';
  if (process.env.OPENAI === 'true')    return 'gpt-4o-mini';
  return process.env.OLLAMA_MODEL || 'llama3.1';
}

function resolveApiKey(provider) {
  const p = normProvider(provider);
  if (p === 'gemini')     return process.env.GEMINI_API_KEY || '';
  if (p === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
  if (p === 'groq')       return process.env.GROQ_API_KEY || '';
  if (p === 'openai')     return process.env.OPENAI_API_KEY || '';
  if (process.env.OPENAI === 'true') return process.env.OPENAI_API_KEY || process.env.OPENAI_COMPAT_API_KEY || '';
  return process.env.OPENAI_COMPAT_API_KEY || '';
}

function isConfigured(provider) {
  const p = normProvider(provider);
  if (p === 'local') return true;
  if (['gemini', 'openrouter', 'groq', 'openai'].includes(p)) return Boolean(resolveApiKey(p));
  if (p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
    // Local compatible endpoints often do not need a key.
    return Boolean(process.env.OPENAI_COMPAT_ENDPOINT || process.env.LM_STUDIO === 'true' || process.env.LLAMAFILE === 'true' || process.env.OPENAI === 'true');
  }
  return false;
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
    incomingMessage.is_group ? 'GROUP CHAT MODE: never flirt, keep replies short/neutral, only reply if directly addressed.' : '',
    memoryBlock     ? memoryBlock     : '',
    toolContext     ? toolContext     : '',
    preferenceBlock ? preferenceBlock : '',
    '',
    'Return ONLY a JSON object with this exact shape (no markdown, no preamble):',
    '{ "options": [ { "tone": "...", "text": "...", "rationale": "...", "score": 85, "risk": "low", "action": "reply" }, ... ] }',
    'Provide exactly 3 options. Tone values: casual, playful, warm, direct, supportive, repair, soft, group.',
    'Risk values: low, medium, high. Score 0-100. Keep each reply under 120 characters.',
    decision.action === 'wait'
      ? 'Include one option with action:"wait" and text:"[Wait and do not reply yet]".'
      : '',
    decision.action === 'no'
      ? 'Do not generate normal sendable replies. Use action:"skip" / action:"wait" instruction options only.'
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

async function callEndpoint(messages, provider) {
  const endpoint    = resolveEndpoint(provider);
  const model       = resolveModel(provider);
  const temperature = Number(process.env.OPENAI_COMPAT_TEMPERATURE || process.env.CLOUD_TEMPERATURE || 0.7);
  const max_tokens  = Number(process.env.OPENAI_COMPAT_MAX_TOKENS || process.env.CLOUD_MAX_TOKENS || 600);
  const timeoutMs   = Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || process.env.CLOUD_TIMEOUT_MS || 30_000);
  const apiKey      = resolveApiKey(provider);

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  // OpenRouter recommends optional attribution headers; safe to omit if unset.
  if (normProvider(provider) === 'openrouter') {
    if (process.env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['X-Title'] = process.env.OPENROUTER_APP_NAME;
  }

  const body = { model, messages, temperature, max_tokens, stream: false };
  if (process.env.CLOUD_RESPONSE_FORMAT_JSON === 'true') body.response_format = { type: 'json_object' };

  const res = await axios.post(endpoint, body, { headers, timeout: timeoutMs });
  const text = res.data?.choices?.[0]?.message?.content || res.data?.message?.content || '';
  return String(text).trim();
}

// ── Response parser ───────────────────────────────────────────

function parseOptions(text) {
  const clean = String(text || '').replace(/```(?:json)?/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    const raw = Array.isArray(parsed) ? parsed : (parsed.options || []);
    return raw.slice(0, 5);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const raw = Array.isArray(parsed) ? parsed : (parsed.options || []);
    return raw.slice(0, 5);
  }
}

// ── Test connection ───────────────────────────────────────────

async function testConnection(provider) {
  const messages = [
    { role: 'system', content: 'Reply with exactly: {"status":"ok"}' },
    { role: 'user',   content: 'test' },
  ];
  try {
    if (!isConfigured(provider)) return { ok: false, error: `${normProvider(provider)} is not configured`, provider: normProvider(provider) };
    const text = await callEndpoint(messages, provider);
    const json = JSON.parse(text.replace(/```(?:json)?/g, '').trim());
    return { ok: json.status === 'ok', provider: normProvider(provider), endpoint: resolveEndpoint(provider), model: resolveModel(provider) };
  } catch (err) {
    return { ok: false, error: err.message, provider: normProvider(provider), endpoint: resolveEndpoint(provider), model: resolveModel(provider) };
  }
}

// ── Main entry: generateSuggestions ──────────────────────────

async function generateSuggestionsOpenAICompat({ contact, recentMessages, incomingMessage, userPersona }, options = {}) {
  const provider = normProvider(options.provider);
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats    = analyzeRecentMessages(recentMessages, incomingMessage);

  if (['wait', 'no'].includes(decision.action) && process.env.OPENAI_COMPAT_FORCE !== 'true' && process.env.CLOUD_FORCE !== 'true') {
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: `local-free-rule-engine-${provider}-skipped` };
  }

  if (!isConfigured(provider)) {
    if (options.throwOnError) throw new Error(`${provider} is not configured`);
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    return { ...generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona }), provider: `local-fallback-${provider}-not-configured` };
  }

  const messages = buildMessages({
    contact,
    recentMessages,
    incomingMessage,
    userPersona,
    decision,
    stats,
    memoryBlock: incomingMessage._memoryBlock,
    toolContext: incomingMessage._toolContext,
    preferenceBlock: incomingMessage._preferenceBlock,
  });

  let rawOptions = [];
  try {
    const text = await callEndpoint(messages, provider);
    rawOptions = parseOptions(text);
    if (!rawOptions.length) throw new Error('provider returned no valid options');
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn(`[${provider}] LLM error, falling back to local rule engine:`, err.message);
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: `local-free-rule-engine-${provider}-fallback` };
  }

  const optionsFiltered = filterOptions(rawOptions);

  return {
    decision,
    stats,
    options: optionsFiltered,
    stage_analysis: null,
    next_move_hint: decision.best_move,
    provider: `${provider}:${resolveModel(provider)}`,
    user_persona_used: userPersona,
  };
}

// ── Profile summarisation ─────────────────────────────────────

async function summarizeProfileOpenAICompat({ contact, messages }, options = {}) {
  const provider = normProvider(options.provider);
  if (!isConfigured(provider)) {
    if (options.throwOnError) throw new Error(`${provider} is not configured`);
    const { summarizeProfileLocal } = require('./local-rule-engine');
    return summarizeProfileLocal({ contact, messages });
  }

  const snippet = messages.slice(-40).map((m) =>
    `[${m.direction}] ${m.body || ''}`.slice(0, 120)
  ).join('\n');

  const prompt = [
    { role: 'system', content: 'You summarize messaging conversation patterns. Return ONLY JSON, no markdown.' },
    {
      role: 'user',
      content: `Contact: ${contact.displayName || contact.display_name}\nMessages:\n${snippet}\n\n` +
        'Return: { "summary": "...", "preferredLanguage": "english|urdu|mixed|other", "emojiStyle": "none|light|heavy", "conversationStage": "initial|warming|regular|close|stale", "stats": {} }',
    },
  ];

  try {
    const text  = await callEndpoint(prompt, provider);
    const clean = text.replace(/```(?:json)?/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : clean);
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn(`[${provider}] Profile summarization failed:`, err.message);
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
  resolveApiKey,
  isConfigured,
  buildMessages,
};
