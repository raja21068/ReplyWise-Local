require('dotenv').config();
const db = require('./index');

async function seed() {
  console.log('Seeding ConversationOS Local...');
  await db.setSetting('user_persona', 'I am calm, respectful, playful when appropriate, and prefer natural short replies. I do not pressure people. My style: English + Roman Urdu mix, light emojis, not too polished.');

  const contacts = [
    { channel: 'whatsapp', externalContactId: '923001234567@c.us', displayName: 'Ayesha' },
    { channel: 'telegram', externalContactId: 'tg_ayesha_1001', displayName: 'Ayesha Telegram' },
  ];

  for (const c of contacts) {
    const contact = await db.upsertContact(c);
    const messages = [
      { direction: 'incoming', body: 'Hey, how are you?', offset: -7200 },
      { direction: 'outgoing', body: 'Good alhamdulillah, just got back from work. You?', offset: -7000 },
      { direction: 'incoming', body: 'Same haha. Bohot thak gayi hun exam prep se', offset: -6800 },
      { direction: 'outgoing', body: 'Oof exam season is brutal. Kab hai?', offset: -6600 },
      { direction: 'incoming', body: 'Next week 😩 pray for me', offset: -6400 },
      { direction: 'outgoing', body: 'InshaAllah you will do great. Thora break bhi lena', offset: -6200 },
    ];
    for (const m of messages) {
      await db.insertMessage({ contactId: contact.id, direction: m.direction, body: m.body, timestamp: new Date(Date.now() + m.offset * 1000).toISOString() });
    }
    console.log(`  ✓ ${c.channel}: ${c.displayName}`);
  }

  console.log('Seed complete.');
  await db.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
