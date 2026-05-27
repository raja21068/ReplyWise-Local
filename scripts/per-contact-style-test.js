'use strict';

const { generateSuggestionsLocal } = require('../src/ai/local-rule-engine');

const incomingMessage = { body: "So what's your weekend plan?" };
const recentMessages = [
  { direction: 'incoming', body: 'hey' },
  { direction: 'outgoing', body: 'hey, how are you?' },
];

const contacts = [
  {
    display_name: 'Ayesha',
    preferred_language: 'mixed',
    emoji_style: 'heavy',
    conversation_stage: 'flirty',
    profile_summary: 'Roman Urdu, playful, lots of emojis, likes teasing and food jokes, flirty stage.',
  },
  {
    display_name: 'Sara',
    preferred_language: 'english',
    emoji_style: 'none',
    conversation_stage: 'deepening',
    profile_summary: 'English, mature, calm, serious, deep thoughtful conversations, low emojis.',
  },
  {
    display_name: 'Hina',
    preferred_language: 'english',
    emoji_style: 'none',
    conversation_stage: 'neutral',
    profile_summary: 'Short replies, direct, busy, low effort, keep replies short.',
  },
  {
    display_name: 'Noor',
    preferred_language: 'mixed',
    emoji_style: 'heavy',
    conversation_stage: 'playful',
    profile_summary: 'Funny sarcastic banter meme energy, likes dry humor and roasting.',
  },
];

const firstReplies = [];
for (const contact of contacts) {
  const result = generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona: 'natural' });
  const first = result.options[0]?.text || '';
  firstReplies.push(first);
  console.log(`\n${contact.display_name}`);
  console.log(`style=${result.contact_style_used.tone}, language=${result.contact_style_used.language}, emoji=${result.contact_style_used.emojiStyle}, length=${result.contact_style_used.length}`);
  for (const opt of result.options) console.log(`- ${opt.tone}: ${opt.text}`);
}

const unique = new Set(firstReplies);
if (unique.size !== contacts.length) {
  console.error('\nFAIL: contacts did not produce distinct primary replies');
  process.exit(1);
}

console.log('\n✓ Per-contact style test passed: same message produced different replies for different contact profiles.');
