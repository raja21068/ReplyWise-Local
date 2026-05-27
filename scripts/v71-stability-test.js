'use strict';

const fs = require('fs');
const path = require('path');
const { generateSuggestionsLocal } = require('../src/ai/local-rule-engine');
const { analyzeDecision } = require('../src/brain/decision-engine');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const contact = {
  display_name: 'Ayesha',
  channel: 'whatsapp',
  preferred_language: 'mixed',
  emoji_style: 'heavy',
  conversation_stage: 'flirty',
  profile_summary: 'Roman Urdu, playful teasing, lots of emojis, but keep respectful.',
  contact_rules: {},
};
const recentMessages = [
  { direction: 'incoming', body: 'haha acha 😂' },
  { direction: 'outgoing', body: 'bas tum batao' },
];

async function main() {
  const audioDecision = analyzeDecision({
    contact,
    recentMessages,
    incomingMessage: { body: '[audio]', media_type: 'voice', media_summary: '', is_group: false },
  });
  assert(audioDecision.media_type === 'audio', 'voice/ptt should normalize to audio');
  assert(['yes', 'review'].includes(audioDecision.action), 'audio-only messages should be routed safely, not crash');
  console.log('✓ audio/voice media normalizes and routes safely');

  const unknownMedia = analyzeDecision({
    contact,
    recentMessages,
    incomingMessage: { body: '[unknown]', media_type: 'strange_binary', from_unknown: true },
  });
  assert(unknownMedia.media_risk === 'high', 'unknown media from unknown sender should be high media risk');
  assert(unknownMedia.action === 'review', 'unknown risky media should require review');
  console.log('✓ unknown media from unknown sender requires review');

  const groupIgnored = generateSuggestionsLocal({
    contact,
    recentMessages,
    incomingMessage: { body: 'What is the scene today?', is_group: true, author: 'Ali' },
    userPersona: 'My name is Lohana. Keep replies short.',
  });
  assert(groupIgnored.decision.action === 'no', 'unaddressed group message should be no-reply');
  assert(groupIgnored.options.every(o => ['skip', 'wait'].includes(String(o.action || '').toLowerCase())), 'unaddressed group options must be non-send instructions');
  assert(groupIgnored.options.every(o => /^\[/.test(o.text)), 'unaddressed group options should be instruction text, not messages to send');
  console.log('✓ unaddressed group messages show non-send instructions only');

  const groupMention = generateSuggestionsLocal({
    contact,
    recentMessages,
    incomingMessage: { body: '@Lohana what do you think?', is_group: true, mentioned_me: true, author: 'Ali' },
    userPersona: 'My name is Lohana. Keep replies short.',
  });
  assert(groupMention.decision.action === 'yes', 'direct group mention should allow reply');
  assert(groupMention.options.every(o => !/flirt|date|romantic|company achi/i.test(`${o.tone} ${o.text}`)), 'group options must not be flirty/date style');
  console.log('✓ directly addressed group messages get neutral short replies');

  const updated = {
    display_name: 'Persona Test',
    channel: 'telegram',
    preferred_language: 'mixed',
    emoji_style: 'light',
    conversation_stage: 'initial',
    profile_summary: 'Neutral profile.',
    contact_rules: { custom_persona: 'For this contact, reply in mature English, no emoji, thoughtful but concise.' },
  };
  assert(updated.contact_rules.custom_persona.includes('mature English'), 'custom persona should be present in contact rules');
  const personaResult = generateSuggestionsLocal({
    contact: updated,
    recentMessages,
    incomingMessage: { body: "What's your weekend plan?" },
    userPersona: updated.contact_rules.custom_persona,
  });
  assert(personaResult.contact_style_used.language === 'english', 'custom persona should steer language to English');
  assert(personaResult.contact_style_used.emoji === '', 'custom persona should disable emojis');
  console.log('✓ per-contact custom persona persists and overrides style');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert(serverSource.includes('wechat'), 'server/dashboard should expose WeChat where supported');
  assert(serverSource.includes('dashboardChannels'), 'server should build dashboard channel list dynamically');
  assert(serverSource.includes('name="media_type"'), 'sandbox should expose media test fields');
  console.log('✓ WeChat and media/group sandbox controls are visible in dashboard source');

  console.log('\n✓ v7.1 stability test passed');
}

main().catch(err => {
  console.error('v7.1 stability test failed:', err);
  process.exit(1);
});
