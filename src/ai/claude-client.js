/**
 * Claude AI Client — uses the Anthropic Messages API to generate reply suggestions.
 *
 * Set in .env:
 *   AI_PROVIDER=claude
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   CLAUDE_MODEL=claude-haiku-4-5-20251001   (or claude-sonnet-4-6, claude-opus-4-6)
 *
 * Cost controls
 * ─────────────
 * • If the local decision engine says WAIT or NO, the LLM call is skipped (same pattern
 *   as the Ollama client) unless CLAUDE_FORCE=true.
 * • max_tokens is capped at 900 to stay well inside context limits and keep cost low.
 * • The prompt is intentionally short: we send recent messages + decision context only.
 */

const axios = require('axios');
const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages } = require('../brain/stats-engine');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ── Main entry ───────────────────────────────────────────────

async function generateSuggestionsClaude({ contact, recentMessages, incomingMessage, userPersona }) {
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);

  // Skip Claude call if local engine already says WAIT/NO
  if (['wait', 'no'].includes(decision.action) && process.env.CLAUDE_FORCE !== 'true') {
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: 'local-free-rule-engine-claude-skipped' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[claude-client] ANTHROPIC_API_KEY not set — falling back to local rule engine.');
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    return { ...generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona }), provider: 'local-fallback-no-key' };
  }

  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = buildSuggestionPrompt({ contact, recentMessages, incomingMessage, userPersona, decision, stats, memoryBlock: incomingMessage._memoryBlock, toolContext: incomingMessage._toolContext, preferenceBlock: incomingMessage._preferenceBlock });

  let raw;
  try {
    const response = await axios.post(
      ANTHROPIC_API,
      {
        model,
        max_tokens: 900,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    raw = response.data?.content?.[0]?.text || '{}';
  } catch (err) {
    console.error('[claude-client] API error:', err.response?.data || err.message);
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    return { ...generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona }), provider: 'local-fallback-api-error' };
  }

  // Strip markdown code fences if the model added them
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Claude sometimes returns prose — extract JSON object if embedded
    const match = clean.match(/\{[\s\S]*\}/);
    try { parsed = match ? JSON.parse(match[0]) : {}; } catch { parsed = {}; }
  }

  parsed.decision = parsed.decision || decision;
  parsed.stats = stats;
  parsed.options = filterOptions(parsed.options || []);
  parsed.stage_analysis = parsed.stage_analysis || contact.conversation_stage || 'unknown';
  parsed.next_move_hint = parsed.next_move_hint || decision.best_move || 'Match energy and keep manual control.';
  parsed.provider = `claude-api:${model}`;
  return parsed;
}

async function summarizeProfileClaude({ contact, messages }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const { summarizeProfileLocal } = require('./local-rule-engine');
    return summarizeProfileLocal({ contact, messages });
  }

  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const chat = messages.map((m) => `${m.direction}: ${m.body}`).join('\n');

  const userMsg = `Refresh contact memory for "${contact.display_name || contact.external_contact_id}".\n\nCHAT:\n${chat}\n\nReturn ONLY a JSON object with keys: summary, preferredLanguage, emojiStyle, conversationStage.\nAllowed preferredLanguage: english, roman-urdu, mixed.\nAllowed emojiStyle: none, light, heavy.\nAllowed conversationStage: initial, early_rapport, building_rapport, warm_or_playful, repair_needed, boundary_respect, paused.`;

  try {
    const response = await axios.post(
      ANTHROPIC_API,
      {
        model,
        max_tokens: 300,
        system: 'You are a concise contact profile summarizer. Return ONLY valid JSON with no explanation, preamble, or markdown.',
        messages: [{ role: 'user', content: userMsg }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    );
    const raw = response.data?.content?.[0]?.text || '{}';
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(clean);
    return {
      summary: parsed.summary || 'Not enough information yet.',
      preferredLanguage: parsed.preferredLanguage || 'mixed',
      emojiStyle: parsed.emojiStyle || 'light',
      conversationStage: parsed.conversationStage || 'initial',
    };
  } catch {
    const { summarizeProfileLocal } = require('./local-rule-engine');
    return summarizeProfileLocal({ contact, messages });
  }
}

// ── Prompt builders ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are ReplyWise, a human-in-the-loop messaging co-pilot.
Your job: given a conversation context and a decision analysis, generate 3 reply options.
Rules:
- Never send anything manipulative, guilt-tripping, sexualizing, or pressure-based.
- Never fabricate facts about the other person.
- Short replies are usually better than long ones. Match the other person's energy.
- Return ONLY a valid JSON object — no markdown, no explanation.

JSON schema:
{
  "options": [
    {
      "tone": "casual|warm|playful|repair|short|empathetic",
      "text": "the actual reply text",
      "rationale": "one sentence explaining why this fits",
      "score": 75,
      "risk": "low|medium|high",
      "action": null
    }
  ],
  "stage_analysis": "current conversation stage in one short phrase",
  "next_move_hint": "one actionable sentence for the user"
}`;

function buildSuggestionPrompt({ contact, recentMessages, incomingMessage, userPersona, decision, stats, memoryBlock, toolContext, preferenceBlock }) {
  const chat = recentMessages.slice(-12).map((m) => `${m.direction}: ${m.body}`).join('\n');
  const mediaNote = incomingMessage.media_type && incomingMessage.media_type !== 'text'
    ? `\nATTACHMENT: ${incomingMessage.media_type}${incomingMessage.media_summary ? ` — "${incomingMessage.media_summary}"` : ''}`
    : '';

  const memSection  = memoryBlock  ? `\n${memoryBlock}\n`  : '';
  const toolSection = toolContext   ? `\n${toolContext}\n`  : '';
  const prefSection = preferenceBlock ? `\n${preferenceBlock}\n` : '';

  return `CONTACT: ${contact.display_name || contact.external_contact_id}
CHANNEL: ${contact.channel || 'unknown'}
PROFILE: ${contact.profile_summary || 'No profile yet.'}
STAGE: ${contact.conversation_stage || 'unknown'}
USER PERSONA: ${userPersona || 'Natural, calm, short replies.'}

DECISION ENGINE OUTPUT:
- action: ${decision.action}
- confidence: ${decision.confidence}%
- reason: ${decision.reason}
- best_move: ${decision.best_move}
- risk_level: ${decision.risk_level}
- temperature: ${decision.temperature}

STATS:
- warmthScore: ${stats.warmthScore}
- overInvesting: ${stats.overInvesting}
- doubleTextRisk: ${stats.doubleTextRisk}
- incomingHasQuestion: ${stats.incomingHasQuestion}
- theirAvgResponseMin: ${stats.theirAvgResponseMin ?? 'unknown'}
- yourAvgResponseMin: ${stats.yourAvgResponseMin ?? 'unknown'}
- responseTimeRatio: ${stats.responseTimeRatio ?? 'unknown'}
- cadenceTrend: ${stats.cadenceTrend || 'stable'}
- momentumLabel: ${stats.momentumLabel || 'unknown'}
${memSection}${toolSection}${prefSection}
RECENT CHAT (oldest → newest):
${chat}

LATEST MESSAGE: ${incomingMessage.body}${mediaNote}

Generate 3 reply options following the JSON schema.`;
}

module.exports = { generateSuggestionsClaude, summarizeProfileClaude };
