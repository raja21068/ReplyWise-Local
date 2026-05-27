const { generateSuggestionsLocal, summarizeProfileLocal } = require('./local-rule-engine');
const { generateSuggestionsOllama, summarizeProfileOllama } = require('./ollama-client');
const { generateSuggestionsClaude, summarizeProfileClaude } = require('./claude-client');
const { generateSuggestionsOpenAICompat, summarizeProfileOpenAICompat, testConnection } = require('./openai-compat-client');

function getProvider() {
  return String(process.env.AI_PROVIDER || 'local').toLowerCase().replace(/-/g, '_');
}

async function generateSuggestions(input) {
  const p = getProvider();
  if (p === 'ollama')                        return generateSuggestionsOllama(input);
  if (p === 'claude')                        return generateSuggestionsClaude(input);
  if (p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile' || p === 'openai')
                                             return generateSuggestionsOpenAICompat(input);
  return generateSuggestionsLocal(input);
}

async function summarizeProfile(input) {
  const p = getProvider();
  if (p === 'ollama')                        return summarizeProfileOllama(input);
  if (p === 'claude')                        return summarizeProfileClaude(input);
  if (p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile' || p === 'openai')
                                             return summarizeProfileOpenAICompat(input);
  return summarizeProfileLocal(input);
}

// Test whatever backend is currently configured
async function testCurrentProvider() {
  const p = getProvider();
  if (p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile' || p === 'openai') {
    return testConnection();
  }
  return { ok: true, provider: p, note: 'No live test for this provider.' };
}

module.exports = { generateSuggestions, summarizeProfile, testCurrentProvider };
