const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages, detectLanguage, countEmojis } = require('../brain/stats-engine');

function generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona }) {
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);
  const body = incomingMessage.body || '';
  const lower = body.toLowerCase();
  const style = deriveContactStyle(contact, stats, body);
  const isGroup = Boolean(incomingMessage?.is_group);
  if (isGroup) {
    style.group = true;
    style.flirtAllowed = false;
    style.length = 'short';
    if (style.tone !== 'mature') style.tone = 'direct';
  }
  const language = style.language;
  const emoji = style.emoji;

  let options = [];

  if (isGroup && decision.action === 'yes') {
    options = groupOptions(language, style, stats);
  } else if (isGroup && decision.action === 'no') {
    options = groupNoReplyOptions(language, decision);
  } else if (decision.action === 'no') {
    options = boundaryOptions(language, style);
  } else if (decision.action === 'repair') {
    options = repairOptions(language, style);
  } else if (decision.action === 'wait') {
    options = waitOptions(language, emoji, style);
  } else if (lower.includes('weekend') || lower.includes('plan') || lower.includes('scene')) {
    options = weekendOptions(language, emoji, stats, style);
  } else if (isEmotional(lower)) {
    options = emotionalOptions(language, emoji, style);
  } else if (stats.incomingHasQuestion) {
    options = questionOptions(language, emoji, style);
  } else {
    options = genericOptions(language, emoji, stats, style);
  }

  options = filterOptions(options).map(opt => scoreOptionForContext(opt, decision, stats, style));

  return {
    decision,
    stats,
    options,
    stage_analysis: inferStage(recentMessages, decision, stats, contact),
    next_move_hint: decision.best_move,
    provider: 'local-free-rule-engine',
    user_persona_used: userPersona,
    contact_style_used: style,
  };
}

// ── Contact-specific style intelligence ─────────────────────

function deriveContactStyle(contact = {}, stats = {}, latestBody = '') {
  const profile = String(contact.profile_summary || contact.profileSummary || '').toLowerCase();
  const rules = contact.contact_rules || contact.contactRules || {};
  const stage = String(contact.conversation_stage || contact.conversationStage || '').toLowerCase();
  const combined = `${profile} ${stage} ${JSON.stringify(rules).toLowerCase()}`;

  let language = normalizeLanguage(contact.preferred_language || contact.preferredLanguage || stats.detectedLanguage || detectLanguage(latestBody));
  if (combined.includes('english') && !combined.includes('roman')) language = 'english';
  if (combined.includes('roman urdu') || combined.includes('urdu') || combined.includes('mixed')) language = language === 'english' ? 'mixed' : language;

  const emojiStyle = String(contact.emoji_style || contact.emojiStyle || rules.emoji_style || 'light').toLowerCase();
  const emoji = emojiStyle === 'none' || combined.includes('no emoji') || combined.includes('low emoji')
    ? ''
    : emojiStyle === 'heavy' || combined.includes('lots of emojis') || combined.includes('meme')
      ? ' 😂'
      : ' 😄';

  let tone = 'natural';
  if (hasAny(combined, ['sarcastic', 'banter', 'meme', 'roast', 'funny'])) tone = 'sarcastic';
  else if (hasAny(combined, ['mature', 'serious', 'deep', 'thoughtful', 'calm'])) tone = 'mature';
  else if (hasAny(combined, ['short replies', 'direct', 'busy', 'low effort', 'dry'])) tone = 'direct';
  else if (hasAny(combined, ['playful', 'teasing', 'flirty', 'warm'])) tone = 'playful';

  let length = 'normal';
  if (hasAny(combined, ['short replies', 'keep short', 'direct', 'busy', 'low effort']) || stats.overInvesting || stats.energyRatio > 2) length = 'short';
  if (hasAny(combined, ['deep talks', 'thoughtful', 'long messages'])) length = 'thoughtful';

  const flirtAllowed = hasAny(combined, ['flirty', 'playful', 'teasing']) && !hasAny(combined, ['avoid flirting', 'not flirty', 'boundary', 'uncomfortable']);

  return {
    language,
    emoji,
    emojiStyle,
    tone,
    length,
    stage: stage || 'initial',
    flirtAllowed,
    avoidHeavy: hasAny(combined, ['avoid heavy', 'busy', 'exams', 'stressed']),
    source: 'contact profile + recent stats',
  };
}

function normalizeLanguage(value) {
  const v = String(value || 'mixed').toLowerCase();
  if (v.includes('english')) return 'english';
  if (v.includes('urdu') || v.includes('roman')) return 'mixed';
  return 'mixed';
}

function hasAny(text, words) {
  return words.some(w => text.includes(w));
}

function isEnglish(language) {
  return language === 'english';
}

// ── Option generators ──────────────────────────────────────

function groupNoReplyOptions(language, decision = {}) {
  const english = isEnglish(language);
  if (english) {
    return [
      { tone: 'no-reply/group', text: '[Do not reply — this group message was not addressed to you]', rationale: 'Most group messages do not need a response unless you are tagged or directly asked.', score: 96, risk: 'low', action: 'skip' },
      { tone: 'watch/group', text: '[Watch the thread and reply only if someone asks you directly]', rationale: 'Keeps you from looking bot-like or needy in a group.', score: 92, risk: 'low', action: 'wait' },
      { tone: 'manual-only/group', text: '[Manual reply only if you have specific value to add]', rationale: 'Group replies should be intentional and neutral.', score: 88, risk: 'low', action: 'skip' },
    ];
  }
  return [
    { tone: 'no-reply/group', text: '[Reply na karo — ye group message directly tumhare liye nahi hai]', rationale: 'Group mein har message ka reply zaroori nahi hota.', score: 96, risk: 'low', action: 'skip' },
    { tone: 'watch/group', text: '[Thread dekho, sirf direct ask/tag par reply karo]', rationale: 'Bot-like ya needy lagne se bachata hai.', score: 92, risk: 'low', action: 'wait' },
    { tone: 'manual-only/group', text: '[Manual reply only agar koi useful baat add karni ho]', rationale: 'Group replies short, neutral, aur intentional hone chahiye.', score: 88, risk: 'low', action: 'skip' },
  ];
}

function groupOptions(language, style = {}, stats = {}) {
  const english = isEnglish(language) || style.tone === 'mature';
  if (english) {
    return [
      { tone: 'group/short', text: `Good point. I think we can keep it simple.`, rationale: 'Short, neutral, and group-safe.', score: 91, risk: 'low' },
      { tone: 'group/helpful', text: `Makes sense. What do you all think?`, rationale: 'Keeps the group conversation open without over-personalizing.', score: 88, risk: 'low' },
      { tone: 'group/direct', text: `I can help with that if needed.`, rationale: 'Useful and non-flirty.', score: 84, risk: 'low' },
    ];
  }
  return [
    { tone: 'group/short', text: `Haan makes sense. Simple rakhte hain.`, rationale: 'Short, neutral, and group-safe.', score: 91, risk: 'low' },
    { tone: 'group/helpful', text: `Theek hai, baaki sab kya soch rahe hain?`, rationale: 'Keeps group conversation open.', score: 88, risk: 'low' },
    { tone: 'group/direct', text: `Need ho toh main help kar deta hoon.`, rationale: 'Helpful and non-flirty.', score: 84, risk: 'low' },
  ];
}

function weekendOptions(language, emoji, stats, style = {}) {
  const keepShort = stats.overInvesting || style.length === 'short';

  if (style.tone === 'direct') {
    return isEnglish(language)
      ? [
          { tone: 'short/direct', text: `Nothing fixed yet. You?`, rationale: 'Matches a short/direct contact without over-investing.', score: 93, risk: 'low' },
          { tone: 'casual', text: `No solid plan yet. What about you?`, rationale: 'Clear and low-pressure.', score: 88, risk: 'low' },
          { tone: 'wait/low energy', text: `Still deciding.`, rationale: 'Very short backup if their energy is low.', score: 78, risk: 'low' },
        ]
      : [
          { tone: 'short/direct', text: `Abhi kuch fixed nahi. Tumhara?`, rationale: 'Matches a short/direct contact without over-investing.', score: 93, risk: 'low' },
          { tone: 'casual', text: `Abhi plan nahi bana. Tumhara kya scene?`, rationale: 'Simple and natural.', score: 88, risk: 'low' },
          { tone: 'low energy', text: `Still deciding.`, rationale: 'Very short backup.', score: 78, risk: 'low' },
        ];
  }

  if (style.tone === 'mature') {
    return [
      { tone: 'calm/mature', text: `I haven't planned much yet. Probably a quiet weekend. What about you?`, rationale: 'Thoughtful and mature without sounding try-hard.', score: 92, risk: 'low' },
      { tone: 'genuine', text: `Nothing fixed yet. I might just rest and catch up on a few things. What are you thinking?`, rationale: 'Natural and open-ended.', score: 89, risk: 'low' },
      { tone: 'short/calm', text: `No big plans yet. You?`, rationale: 'Shorter mature option.', score: 83, risk: 'low' },
    ];
  }

  if (style.tone === 'sarcastic') {
    return isEnglish(language)
      ? [
          { tone: 'sarcastic/playful', text: `Survive, eat, repeat. Very ambitious plan${emoji}`, rationale: 'Matches banter/meme energy.', score: 92, risk: 'low' },
          { tone: 'playful', text: `My weekend plan is currently under construction${emoji} Yours?`, rationale: 'Funny and still asks back.', score: 88, risk: 'low' },
          { tone: 'casual', text: `Nothing fixed yet, just pretending to be productive. You?`, rationale: 'Dry humor without pressure.', score: 85, risk: 'low' },
        ]
      : [
          { tone: 'sarcastic/playful', text: `Survive, eat, repeat. Bohot ambitious plan${emoji}`, rationale: 'Matches banter/meme energy.', score: 92, risk: 'low' },
          { tone: 'playful', text: `Weekend plan abhi construction mein hai${emoji} Tumhara?`, rationale: 'Funny and still asks back.', score: 88, risk: 'low' },
          { tone: 'casual', text: `Abhi kuch fixed nahi, bas productive banne ki acting. Tumhara?`, rationale: 'Dry humor without pressure.', score: 85, risk: 'low' },
        ];
  }

  if (isEnglish(language)) {
    return [
      { tone: 'casual', text: keepShort ? `Nothing fixed yet. You?` : `Nothing fixed yet, maybe food and rest. What about you?`, rationale: 'Answers and asks back without pressure.', score: 88, risk: 'low' },
      { tone: 'playful', text: `Plan is still loading${emoji} Got any good ideas?`, rationale: 'Light and playful without trying too hard.', score: 86, risk: 'low' },
      { tone: 'soft/flirty', text: style.flirtAllowed ? `Depends. Good company can make even a simple plan work${emoji}` : `Depends, maybe something simple and relaxed${emoji}`, rationale: 'Warm but not pushy.', score: style.flirtAllowed ? 78 : 74, risk: style.flirtAllowed ? 'medium' : 'low' }
    ];
  }
  return [
    { tone: 'casual', text: keepShort ? `Abhi kuch fixed nahi. Tumhara?` : `Abhi kuch fixed nahi, shayad food aur rest. Tumhara kya scene hai?`, rationale: 'Natural Roman Urdu mix and asks back.', score: 90, risk: 'low' },
    { tone: 'playful', text: `Plan abhi loading pe hai${emoji} Tum koi acha idea do`, rationale: 'Playful and easy.', score: 87, risk: 'low' },
    { tone: 'soft/flirty', text: style.flirtAllowed ? `Depend karta hai, company achi ho toh simple plan bhi set ho jata hai${emoji}` : `Depend karta hai, shayad kuch simple aur relaxed${emoji}`, rationale: 'Warm but not aggressive.', score: style.flirtAllowed ? 77 : 73, risk: style.flirtAllowed ? 'medium' : 'low' }
  ];
}

function emotionalOptions(language, emoji, style = {}) {
  if (style.length === 'short') {
    return isEnglish(language)
      ? [
          { tone: 'short/supportive', text: `That sounds exhausting. Take a small break first.`, rationale: 'Supportive without over-writing.', score: 93, risk: 'low' },
          { tone: 'caring', text: `Want to vent, or should I distract you?`, rationale: 'Gives them control.', score: 91, risk: 'low' },
          { tone: 'simple', text: `I get you. That sounds rough.`, rationale: 'Short validation.', score: 86, risk: 'low' },
        ]
      : [
          { tone: 'short/supportive', text: `Yaar exhausting lag raha hai. Pehle thora break lo.`, rationale: 'Supportive without over-writing.', score: 93, risk: 'low' },
          { tone: 'caring', text: `Vent karna hai ya distract karun?`, rationale: 'Gives them control.', score: 91, risk: 'low' },
          { tone: 'simple', text: `Samajh sakta hoon, rough lag raha hai.`, rationale: 'Short validation.', score: 86, risk: 'low' },
        ];
  }

  if (isEnglish(language) || style.tone === 'mature') {
    return [
      { tone: 'supportive', text: `That sounds exhausting. Take a small break first, you don't have to handle everything at once.`, rationale: 'Validates stress before solving.', score: 93, risk: 'low' },
      { tone: 'caring', text: `I get why you're drained. Want to vent, or should I distract you for a bit?`, rationale: 'Gives them control over the emotional direction.', score: 91, risk: 'low' },
      { tone: 'gentle', text: `Be kind to yourself today. One thing at a time.`, rationale: 'Calm and mature.', score: 87, risk: 'low' }
    ];
  }
  return [
    { tone: 'supportive', text: `Yaar ye kaafi exhausting lag raha hai. Pehle thora break lo, sab ek sath handle karna zaroori nahi.`, rationale: 'Warm support in Roman Urdu.', score: 93, risk: 'low' },
    { tone: 'caring', text: `Samajh sakta hoon. Vent karna hai ya thora mood distract karun?`, rationale: 'Lets them choose support or distraction.', score: 91, risk: 'low' },
    { tone: 'gentle/playful', text: `Pehle breathe. Phir chai break. Phir comeback mode.`, rationale: 'Gentle humor, low pressure.', score: 84, risk: 'low' }
  ];
}

function questionOptions(language, emoji, style = {}) {
  if (style.tone === 'direct' || style.length === 'short') {
    return isEnglish(language)
      ? [
          { tone: 'short/direct', text: `Depends. What made you ask?`, rationale: 'Short and invites context.', score: 90, risk: 'low' },
          { tone: 'casual', text: `Good question. I think yes, mostly.`, rationale: 'Simple answer.', score: 84, risk: 'low' },
          { tone: 'low pressure', text: `Maybe. Context matters.`, rationale: 'Keeps it brief.', score: 78, risk: 'low' },
        ]
      : [
          { tone: 'short/direct', text: `Depend karta hai. Tumne kyun poocha?`, rationale: 'Short and invites context.', score: 90, risk: 'low' },
          { tone: 'casual', text: `Good question. Mere khayal se mostly yes.`, rationale: 'Simple answer.', score: 84, risk: 'low' },
          { tone: 'low pressure', text: `Maybe. Context matter karta hai.`, rationale: 'Keeps it brief.', score: 78, risk: 'low' },
        ];
  }

  if (style.tone === 'sarcastic') {
    return isEnglish(language)
      ? [
          { tone: 'playful', text: `I have a simple answer and a dramatic answer. Which one do you want first?`, rationale: 'Matches banter style.', score: 88, risk: 'low' },
          { tone: 'casual', text: `Depends, because apparently life loves plot twists${emoji}`, rationale: 'Light sarcasm.', score: 84, risk: 'low' },
          { tone: 'direct', text: `Honestly, it depends. What made you ask?`, rationale: 'Safe backup.', score: 82, risk: 'low' },
        ]
      : [
          { tone: 'playful', text: `Iska ek seedha answer hai aur ek dramatic answer. Pehle konsa?`, rationale: 'Matches banter style.', score: 88, risk: 'low' },
          { tone: 'casual', text: `Depend karta hai, kyun ke life ko plot twist pasand hain${emoji}`, rationale: 'Light sarcasm.', score: 84, risk: 'low' },
          { tone: 'direct', text: `Honestly depend karta hai. Tumne kyun poocha?`, rationale: 'Safe backup.', score: 82, risk: 'low' },
        ];
  }

  if (isEnglish(language) || style.tone === 'mature') {
    return [
      { tone: 'direct/casual', text: `Honestly, I'd say it depends on the situation. What made you ask?`, rationale: 'Answers naturally and invites context.', score: 85, risk: 'low' },
      { tone: 'thoughtful', text: `I think the honest answer depends on the context. Tell me what happened.`, rationale: 'Mature and context-seeking.', score: 84, risk: 'low' },
      { tone: 'short', text: `Good question${emoji} I think yes, mostly.`, rationale: 'Short when energy matching matters.', score: 78, risk: 'low' }
    ];
  }
  return [
    { tone: 'direct/casual', text: `Honestly situation pe depend karta hai. Tumne kyun poocha?`, rationale: 'Natural and curious.', score: 86, risk: 'low' },
    { tone: 'playful', text: `Iska ek seedha answer hai aur ek dramatic answer. Pehle konsa?`, rationale: 'Playful without being intense.', score: 84, risk: 'low' },
    { tone: 'short', text: `Good question${emoji} Mere khayal se mostly yes.`, rationale: 'Short, safe answer.', score: 78, risk: 'low' }
  ];
}

function genericOptions(language, emoji, stats, style = {}) {
  const short = stats.overInvesting || stats.energyRatio > 2 || style.length === 'short';

  if (style.tone === 'direct' || short) {
    return isEnglish(language)
      ? [
          { tone: 'short/casual', text: `Haha fair${emoji}`, rationale: 'Matches low-context energy.', score: 86, risk: 'low' },
          { tone: 'simple', text: `Makes sense.`, rationale: 'Safe and low-pressure.', score: 82, risk: 'low' },
          { tone: 'curious', text: `What happened?`, rationale: 'Short curiosity.', score: 78, risk: 'low' },
        ]
      : [
          { tone: 'short/casual', text: `Hahaha fair${emoji}`, rationale: 'Matches low-context energy.', score: 86, risk: 'low' },
          { tone: 'simple', text: `Makes sense.`, rationale: 'Safe and low-pressure.', score: 82, risk: 'low' },
          { tone: 'curious', text: `Kya hua?`, rationale: 'Short curiosity.', score: 78, risk: 'low' },
        ];
  }

  if (style.tone === 'sarcastic') {
    return isEnglish(language)
      ? [
          { tone: 'dry/playful', text: `Iconic behavior honestly${emoji}`, rationale: 'Banter style.', score: 86, risk: 'low' },
          { tone: 'curious', text: `Okay now I need the backstory.`, rationale: 'Playful curiosity.', score: 83, risk: 'low' },
          { tone: 'warm', text: `Haha fair, I get you.`, rationale: 'Safer backup.', score: 78, risk: 'low' },
        ]
      : [
          { tone: 'dry/playful', text: `Iconic behavior honestly${emoji}`, rationale: 'Banter style.', score: 86, risk: 'low' },
          { tone: 'curious', text: `Ab iski backstory bhi chahiye.`, rationale: 'Playful curiosity.', score: 83, risk: 'low' },
          { tone: 'warm', text: `Hahaha fair, samajh gaya.`, rationale: 'Safer backup.', score: 78, risk: 'low' },
        ];
  }

  if (isEnglish(language) || style.tone === 'mature') {
    return [
      { tone: 'short/casual', text: short ? `Haha fair${emoji}` : `Haha fair${emoji} Tell me more.`, rationale: 'Matches low-context energy.', score: 80, risk: 'low' },
      { tone: 'curious', text: `I feel there's a story here.`, rationale: 'Invites elaboration without pressure.', score: 78, risk: 'low' },
      { tone: 'warm', text: `I get you. That actually makes sense.`, rationale: 'Validates naturally.', score: 76, risk: 'low' }
    ];
  }
  return [
    { tone: 'short/casual', text: short ? `Hahaha fair${emoji}` : `Hahaha fair${emoji} Iske peechay story lag rahi hai.`, rationale: 'Casual, not over-invested.', score: 80, risk: 'low' },
    { tone: 'curious', text: `Iske peechay story lag rahi hai, batao zara.`, rationale: 'Easy curiosity.', score: 78, risk: 'low' },
    { tone: 'warm', text: `Samajh gaya, honestly makes sense.`, rationale: 'Simple validation.', score: 76, risk: 'low' }
  ];
}

function waitOptions(language, emoji, style = {}) {
  const direct = style.length === 'short' || style.tone === 'direct';
  if (isEnglish(language)) {
    return [
      { tone: 'wait', text: `[Do not send yet — wait 20-30 minutes]`, rationale: 'Best move is timing control, not more text.', score: 92, risk: 'low', action: 'wait' },
      { tone: 'short backup', text: direct ? `Fair.` : `Haha fair${emoji}`, rationale: 'If you must reply, keep it very short.', score: 76, risk: 'medium' },
      { tone: 'low pressure', text: `Makes sense.`, rationale: 'Low-pressure reply that does not chase.', score: 72, risk: 'low' }
    ];
  }
  return [
    { tone: 'wait', text: `[Abhi send na karo — 20-30 min wait]`, rationale: 'Timing is better than chasing.', score: 92, risk: 'low', action: 'wait' },
    { tone: 'short backup', text: direct ? `Fair.` : `Hahaha fair${emoji}`, rationale: 'If replying, keep it short.', score: 76, risk: 'medium' },
    { tone: 'low pressure', text: `Makes sense.`, rationale: 'Low pressure and simple.', score: 72, risk: 'low' }
  ];
}

function repairOptions(language, style = {}) {
  if (isEnglish(language) || style.tone === 'mature') {
    return [
      { tone: 'repair', text: `You're right, I didn't mean it that way. My bad.`, rationale: 'Simple accountability without overexplaining.', score: 90, risk: 'low' },
      { tone: 'calm', text: `I get why that sounded off. Let me rephrase.`, rationale: 'Acknowledges tension and resets.', score: 86, risk: 'low' },
      { tone: 'space-giving', text: `Fair. I'll give you space and not push it.`, rationale: 'Respects the moment.', score: 84, risk: 'low' }
    ];
  }
  return [
    { tone: 'repair', text: `Tum sahi keh rahi ho, mera woh matlab nahi tha. My bad.`, rationale: 'Short accountability.', score: 90, risk: 'low' },
    { tone: 'calm', text: `Samajh gaya, woh thora off sound hua. Let me rephrase.`, rationale: 'Calm reset.', score: 86, risk: 'low' },
    { tone: 'space-giving', text: `Fair. Main push nahi karta, thori space de deta hoon.`, rationale: 'Respectful and non-pushy.', score: 84, risk: 'low' }
  ];
}

function boundaryOptions(language, style = {}) {
  if (isEnglish(language) || style.tone === 'mature') {
    return [
      { tone: 'respect boundary', text: `Understood. I won't push it.`, rationale: 'Respects the boundary directly.', score: 95, risk: 'low' },
      { tone: 'apology', text: `Sorry, I didn't mean to make you uncomfortable. I'll stop.`, rationale: 'Acknowledges discomfort and stops.', score: 94, risk: 'low' },
      { tone: 'no reply', text: `[Do not reply further]`, rationale: 'Sometimes silence is the most respectful response.', score: 96, risk: 'low', action: 'skip' }
    ];
  }
  return [
    { tone: 'respect boundary', text: `Samajh gaya. Main push nahi karunga.`, rationale: 'Directly respects the boundary.', score: 95, risk: 'low' },
    { tone: 'apology', text: `Sorry, mera intention uncomfortable karna nahi tha. Main stop karta hoon.`, rationale: 'Apologizes and stops.', score: 94, risk: 'low' },
    { tone: 'no reply', text: `[Ab reply na karo]`, rationale: 'Silence may be the respectful option.', score: 96, risk: 'low', action: 'skip' }
  ];
}

function scoreOptionForContext(opt, decision, stats, style = {}) {
  let score = Number(opt.score || 75);
  if (decision.action === 'wait' && !String(opt.tone).includes('wait')) score -= 8;
  if (stats.overInvesting && String(opt.text || '').split(/\s+/).length > 12) score -= 10;
  if (decision.risk_level === 'high' && opt.risk !== 'low') score -= 20;
  if (style.tone && String(opt.tone || '').includes(style.tone)) score += 3;
  if (style.length === 'short' && String(opt.text || '').split(/\s+/).length <= 8) score += 4;
  if (style.group && /flirt|romantic|company|date/i.test(`${opt.tone || ''} ${opt.text || ''}`)) score -= 40;
  return { ...opt, score: Math.max(30, Math.min(99, Math.round(score))) };
}

function isEmotional(lower) {
  return ['tired', 'sad', 'stress', 'stressed', 'exam', 'drained', 'upset', 'anxious', 'thak', 'pareshan'].some(x => lower.includes(x));
}

function inferStage(messages, decision, stats, contact = {}) {
  const existing = contact.conversation_stage || contact.conversationStage;
  if (existing && existing !== 'initial') return existing;
  if (decision.temperature === 'boundary') return 'boundary_respect';
  if (decision.action === 'repair') return 'repair_needed';
  if (stats.warmthScore >= 75) return 'warm_or_playful';
  const count = messages ? messages.length : 0;
  if (count > 40) return 'building_rapport';
  if (count > 12) return 'early_rapport';
  return 'initial';
}

function summarizeProfileLocal({ contact, messages }) {
  const allText = (messages || []).map((m) => m.body).join(' ').toLowerCase();
  const preferredLanguage = detectLanguage(allText);
  const emojiCount = countEmojis(allText);
  const emojiStyle = emojiCount > 8 ? 'heavy' : emojiCount > 0 ? 'light' : 'none';
  const fakeIncoming = { body: messages[messages.length - 1]?.body || '' };
  const stats = analyzeRecentMessages(messages || [], fakeIncoming);
  const conversationStage = stats.warmthScore >= 75 ? 'warm_or_playful' : messages.length > 40 ? 'building_rapport' : messages.length > 12 ? 'early_rapport' : 'initial';
  const summary = [
    `${contact.display_name || contact.external_contact_id || contact.whatsapp_id} (${contact.channel || 'manual'}) memory.`,
    `Preferred style appears ${preferredLanguage}; emoji usage ${emojiStyle}.`,
    `Current stage: ${conversationStage}; warmth score ${stats.warmthScore}/100.`,
    `Energy ratio user/contact: ${stats.energyRatio}.`,
    `Best move: match energy, keep replies natural, and do not over-invest when replies are short.`
  ].join(' ');
  return { summary, preferredLanguage, emojiStyle, conversationStage, stats };
}

module.exports = { generateSuggestionsLocal, summarizeProfileLocal, deriveContactStyle };
