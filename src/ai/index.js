const { generateSuggestionsLocal, summarizeProfileLocal } = require('./local-rule-engine');
const { generateSuggestionsOllama, summarizeProfileOllama } = require('./ollama-client');

async function generateSuggestions(input) {
  const provider = String(process.env.AI_PROVIDER || 'local').toLowerCase();
  if (provider === 'ollama') return generateSuggestionsOllama(input);
  return generateSuggestionsLocal(input);
}

async function summarizeProfile(input) {
  const provider = String(process.env.AI_PROVIDER || 'local').toLowerCase();
  if (provider === 'ollama') return summarizeProfileOllama(input);
  return summarizeProfileLocal(input);
}

module.exports = { generateSuggestions, summarizeProfile };
