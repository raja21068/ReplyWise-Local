const axios = require('axios');
const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages } = require('../brain/stats-engine');

async function generateSuggestionsOllama({ contact, recentMessages, incomingMessage, userPersona }) {
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);

  // Free-cost optimization: if local decision says WAIT/NO, avoid an LLM call.
  if (['wait', 'no'].includes(decision.action) && process.env.OLLAMA_FORCE !== 'true') {
    const { generateSuggestionsLocal } = require('./local-rule-engine');
    const local = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona });
    return { ...local, provider: 'local-free-rule-engine-ollama-skipped' };
  }

  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.1';
  const prompt = buildSuggestionPrompt({ contact, recentMessages, incomingMessage, userPersona, decision, stats });
  const response = await axios.post(`${baseUrl}/api/generate`, {
    model,
    prompt,
    stream: false,
    format: 'json'
  }, { timeout: 120000 });
  const raw = response.data && response.data.response ? response.data.response : '{}';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { options: [] }; }
  parsed.decision = parsed.decision || decision;
  parsed.stats = stats;
  parsed.options = filterOptions(parsed.options || []);
  parsed.stage_analysis = parsed.stage_analysis || contact.conversation_stage || 'unknown';
  parsed.next_move_hint = parsed.next_move_hint || decision.best_move || 'Match energy and keep manual control.';
  parsed.provider = 'ollama-local';
  return parsed;
}

async function summarizeProfileOllama({ contact, messages }) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.1';
  const chat = messages.map((m) => `${m.direction}: ${m.body}`).join('\n');
  const prompt = `You are ConversationOS Local. Refresh concise contact memory. Return strict JSON only.
Fields: summary, preferredLanguage, emojiStyle, conversationStage.
Allowed preferredLanguage: english, roman-urdu, mixed.
Allowed emojiStyle: none, light, heavy.
Allowed conversationStage: initial, early_rapport, building_rapport, warm_or_playful, repair_needed, boundary_respect, paused.
Keep it respectful and factual. Do not invent sensitive facts.

CONTACT: ${contact.display_name || contact.external_contact_id}
CHAT:\n${chat}`;

  const response = await axios.post(`${baseUrl}/api/generate`, { model, prompt, stream: false, format: 'json' }, { timeout: 120000 });
  const raw = response.data && response.data.response ? response.data.response : '{}';
  try {
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary || 'Not enough information yet.',
      preferredLanguage: parsed.preferredLanguage || 'mixed',
      emojiStyle: parsed.emojiStyle || 'light',
      conversationStage: parsed.conversationStage || 'initial'
    };
  } catch {
    const { summarizeProfileLocal } = require('./local-rule-engine');
    return summarizeProfileLocal({ contact, messages });
  }
}

function buildSuggestionPrompt({ contact, recentMessages, incomingMessage, userPersona, decision, stats }) {
  const chat = recentMessages.map((m) => `${m.direction}: ${m.body}`).join('\n');
  return `You are ConversationOS Local, a human-in-the-loop communication judgment assistant.
Your most important job: decide whether replying is a good idea before drafting text.
Never auto-send. Never pressure, guilt-trip, manipulate, sexualize, or fabricate facts.
Match energy. Short replies are often better than perfect replies.

CONTACT PROFILE:\n${contact.profile_summary || 'No profile yet.'}

RECENT CHAT:\n${chat}

LATEST MESSAGE:\n${incomingMessage.body}

LOCAL DECISION BASELINE:\n${JSON.stringify(decision, null, 2)}

LOCAL STATS:\n${JSON.stringify(stats, null, 2)}

USER PERSONA:\n${userPersona}

Return strict JSON:
{
  "decision": {
    "should_reply":"yes|wait|no|repair|end",
    "action":"yes|wait|no|repair|end",
    "confidence": 0,
    "reason":"...",
    "best_move":"...",
    "avoid":"...",
    "wait_minutes": 0,
    "temperature":"cold|neutral|warm|playful|emotional|tense|boundary",
    "risk_level":"low|medium|high"
  },
  "options": [
    {"tone":"casual", "text":"...", "rationale":"...", "score":85, "risk":"low"},
    {"tone":"playful", "text":"...", "rationale":"...", "score":80, "risk":"low"},
    {"tone":"genuine", "text":"...", "rationale":"...", "score":78, "risk":"low"}
  ],
  "stage_analysis":"...",
  "next_move_hint":"..."
}`;
}

module.exports = { generateSuggestionsOllama, summarizeProfileOllama };
