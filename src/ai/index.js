const { generateSuggestionsLocal, summarizeProfileLocal } = require('./local-rule-engine');
const { generateSuggestionsOllama, summarizeProfileOllama } = require('./ollama-client');
const { generateSuggestionsClaude, summarizeProfileClaude } = require('./claude-client');
const {
  generateSuggestionsOpenAICompat,
  summarizeProfileOpenAICompat,
  testConnection,
  isConfigured: isOpenAICompatConfigured,
  resolveModel,
} = require('./openai-compat-client');
const usage = require('./usage-meter');

function getProvider() {
  return String(process.env.AI_PROVIDER || 'easy').toLowerCase().replace(/-/g, '_');
}

function isEasyProvider(p = getProvider()) {
  return ['easy', 'auto', 'hybrid', 'cloud_auto'].includes(String(p).toLowerCase().replace(/-/g, '_'));
}

function providerChain() {
  const raw = process.env.AI_PROVIDER_CHAIN || 'gemini,openrouter,groq,openai_compat,local';
  const items = raw.split(',').map(x => x.trim().toLowerCase().replace(/-/g, '_')).filter(Boolean);
  return [...new Set(items.length ? items : ['local'])];
}

function isProviderConfigured(provider) {
  const p = String(provider || '').toLowerCase().replace(/-/g, '_');
  if (p === 'local') return true;
  if (p === 'gemini' || p === 'openrouter' || p === 'groq' || p === 'openai' || p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
    return isOpenAICompatConfigured(p);
  }
  if (p === 'claude') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (p === 'ollama') return process.env.ENABLE_OLLAMA_FALLBACK === 'true' || getProvider() === 'ollama';
  return false;
}

function configuredChain() {
  return providerChain().filter(isProviderConfigured);
}

async function callNamedProvider(provider, input, kind) {
  const p = String(provider || '').toLowerCase().replace(/-/g, '_');
  if (p === 'local') {
    return kind === 'summary' ? summarizeProfileLocal(input) : generateSuggestionsLocal(input);
  }

  const cap = usage.canUseCloud(p);
  if (!cap.allowed) throw new Error(cap.reason);

  try {
    let result;
    if (p === 'gemini' || p === 'openrouter' || p === 'groq' || p === 'openai' || p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
      result = kind === 'summary'
        ? await summarizeProfileOpenAICompat(input, { provider: p, throwOnError: true })
        : await generateSuggestionsOpenAICompat(input, { provider: p, throwOnError: true });
    } else if (p === 'claude') {
      result = kind === 'summary' ? await summarizeProfileClaude(input) : await generateSuggestionsClaude(input);
    } else if (p === 'ollama') {
      result = kind === 'summary' ? await summarizeProfileOllama(input) : await generateSuggestionsOllama(input);
    } else {
      throw new Error(`Unknown provider: ${p}`);
    }
    usage.recordCloudCall(p, 'ok');
    return result;
  } catch (err) {
    usage.recordCloudCall(p, 'failed');
    throw err;
  }
}

async function autoRoute(input, kind = 'suggestions') {
  const attempts = [];
  const chain = configuredChain();
  const finalChain = chain.includes('local') ? chain : [...chain, 'local'];

  for (const provider of finalChain) {
    try {
      const result = await callNamedProvider(provider, input, kind === 'summary' ? 'summary' : 'suggestions');
      if (result && typeof result === 'object') {
        result.provider_route = { mode: getProvider(), used: provider, attempts };
      }
      return result;
    } catch (err) {
      attempts.push({ provider, error: err.message });
      console.warn(`[ai-router] ${provider} failed/skipped: ${err.message}`);
    }
  }

  return kind === 'summary' ? summarizeProfileLocal(input) : generateSuggestionsLocal(input);
}


function summarizeAiError(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const serverMessage = typeof data === 'string'
    ? data
    : (data?.error?.message || data?.message || data?.error || '');
  return [status ? `HTTP ${status}` : '', err?.message || '', serverMessage ? `— ${String(serverMessage).slice(0, 220)}` : '']
    .filter(Boolean)
    .join(' ');
}

async function generateSuggestions(input) {
  const p = getProvider();
  if (isEasyProvider(p)) return autoRoute(input, 'suggestions');

  try {
    let result;
    if (p === 'ollama') result = await generateSuggestionsOllama(input);
    else if (p === 'claude') result = await generateSuggestionsClaude(input);
    else if (p === 'gemini' || p === 'openrouter' || p === 'groq' || p === 'openai' || p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
      result = await generateSuggestionsOpenAICompat(input, { provider: p });
    } else {
      result = generateSuggestionsLocal(input);
    }
    return result;
  } catch (err) {
    const summary = summarizeAiError(err);
    console.warn(`[ai] ${p} failed; Nano Bot local fallback used: ${summary}`);
    const local = generateSuggestionsLocal(input);
    return { ...local, provider: `nano-local-fallback-after-${p}`, provider_error: summary };
  }
}

async function summarizeProfile(input) {
  const p = getProvider();
  if (isEasyProvider(p)) return autoRoute(input, 'summary');

  try {
    if (p === 'ollama') return await summarizeProfileOllama(input);
    if (p === 'claude') return await summarizeProfileClaude(input);
    if (p === 'gemini' || p === 'openrouter' || p === 'groq' || p === 'openai' || p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
      return await summarizeProfileOpenAICompat(input, { provider: p });
    }
    return summarizeProfileLocal(input);
  } catch (err) {
    const summary = summarizeAiError(err);
    console.warn(`[ai] ${p} profile summary failed; local fallback used: ${summary}`);
    return summarizeProfileLocal(input);
  }
}

async function testCurrentProvider() {
  const p = getProvider();
  if (isEasyProvider(p)) {
    const chain = configuredChain();
    const tests = [];
    for (const provider of chain.filter(x => x !== 'local')) {
      tests.push(await testConnection(provider));
    }
    return {
      ok: tests.some(t => t.ok) || chain.includes('local'),
      provider: p,
      chain,
      cloudUsage: usage.getUsageSummary(),
      tests,
      note: chain.length ? 'Easy mode will use the first working configured provider, then local fallback.' : 'No providers configured; local fallback only.',
    };
  }
  if (p === 'gemini' || p === 'openrouter' || p === 'groq' || p === 'openai' || p === 'openai_compat' || p === 'lm_studio' || p === 'llamafile') {
    return testConnection(p);
  }
  return { ok: true, provider: p, model: p === 'local' ? 'local-rule-engine' : resolveModel(p), cloudUsage: usage.getUsageSummary(), note: 'No live test for this provider.' };
}

function getProviderStatus() {
  const p = getProvider();
  return {
    provider: p,
    easyMode: isEasyProvider(p),
    chain: providerChain(),
    configuredChain: configuredChain(),
    cloudUsage: usage.getUsageSummary(),
  };
}

module.exports = { generateSuggestions, summarizeProfile, testCurrentProvider, getProviderStatus, providerChain, configuredChain };
