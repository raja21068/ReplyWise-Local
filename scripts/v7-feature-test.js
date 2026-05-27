'use strict';

const fs = require('fs');
const path = require('path');
const { generateSuggestionsLocal } = require('../src/ai/local-rule-engine');
const { transcribe } = require('../src/media/transcribe');

const contact = {
  display_name: 'Group Test',
  preferred_language: 'english',
  emoji_style: 'none',
  conversation_stage: 'neutral',
  profile_summary: 'Neutral, professional, short replies.',
};
const recentMessages = [
  { direction: 'incoming', body: 'hello everyone' },
  { direction: 'outgoing', body: 'hey' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const groupIgnored = generateSuggestionsLocal({
    contact,
    recentMessages,
    incomingMessage: { body: 'What is the plan for today?', is_group: true, author: 'Ali' },
    userPersona: 'My name is Lohana. Keep replies short.',
  });
  assert(groupIgnored.decision.action === 'no', 'unaddressed group message should not trigger a normal reply');
  assert(/group/i.test(groupIgnored.decision.context_summary), 'group context summary missing');
  console.log('✓ group chat unaddressed message → no reply');

  const groupMentioned = generateSuggestionsLocal({
    contact,
    recentMessages,
    incomingMessage: { body: '@Lohana what do you think?', is_group: true, mentioned_me: true, author: 'Ali' },
    userPersona: 'My name is Lohana. Keep replies short.',
  });
  assert(groupMentioned.decision.action === 'yes', 'directly mentioned group message should allow a reply');
  assert(groupMentioned.options.length >= 3, 'group-safe options missing');
  assert(groupMentioned.options.every(o => !/flirt|romantic|date/i.test(`${o.tone} ${o.text}`)), 'group options must not be flirty');
  console.log('✓ group chat direct mention → short neutral options only');

  delete process.env.TRANSCRIBE_ENABLED;
  const tr = await transcribe('/tmp/nonexistent-audio.ogg');
  assert(tr.skipped && tr.backend === 'disabled', 'transcribe should be disabled by default');
  console.log('✓ voice transcription is off by default and safe for free-cost mode');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert(serverSource.includes('custom_persona'), 'server must support per-contact custom_persona override');
  assert(serverSource.includes('/api/contacts/:id/persona'), 'server must expose persona update route');
  console.log('✓ per-contact custom persona route and override are present');

  console.log('\n✓ v7 feature test passed');
}

main().catch(err => {
  console.error('v7 feature test failed:', err);
  process.exit(1);
});
