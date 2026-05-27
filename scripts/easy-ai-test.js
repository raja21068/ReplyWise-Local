#!/usr/bin/env node
'use strict';

process.env.AI_PROVIDER = 'easy';
process.env.AI_PROVIDER_CHAIN = 'gemini,openrouter,groq,local';
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.MAX_CLOUD_CALLS_PER_DAY = '5';

const ai = require('../src/ai');

async function main() {
  const status = ai.getProviderStatus();
  if (!status.easyMode) throw new Error('easy mode not detected');
  if (!status.configuredChain.includes('local')) throw new Error('local fallback missing');

  const result = await ai.generateSuggestions({
    contact: { id: 'c1', channel: 'whatsapp', display_name: 'Ayesha', profile_summary: 'playful Roman Urdu, light emoji', conversation_stage: 'warming' },
    recentMessages: [{ direction: 'incoming', body: 'haha weekend?', timestamp: new Date().toISOString() }],
    incomingMessage: { body: 'what is your weekend plan?', media_type: 'text' },
    userPersona: 'I reply naturally, short, respectful, playful only when appropriate.',
  });
  if (!result.options || result.options.length < 1) throw new Error('no options generated');
  if (!String(result.provider || '').includes('local')) throw new Error('expected local fallback without keys');

  console.log('✅ easy mode works without Ollama or API keys');
  console.log('✅ local fallback generated', result.options.length, 'options');
  console.log('✅ provider:', result.provider);
}

main().catch(err => { console.error('❌ easy-ai-test failed:', err); process.exit(1); });
