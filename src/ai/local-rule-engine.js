const { filterOptions } = require('../safety/guardrails');
const { analyzeDecision } = require('../brain/decision-engine');
const { analyzeRecentMessages, detectLanguage, countEmojis } = require('../brain/stats-engine');

function generateSuggestionsLocal({ contact, recentMessages, incomingMessage, userPersona }) {
  const decision = analyzeDecision({ contact, recentMessages, incomingMessage });
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);
  const body = incomingMessage.body || '';
  const lower = body.toLowerCase();
  const language = contact.preferred_language || stats.detectedLanguage || detectLanguage(body);
  const emoji = contact.emoji_style === 'none' ? '' : contact.emoji_style === 'heavy' ? ' 😂' : ' 😄';

  let options = [];

  if (decision.action === 'no') {
    options = boundaryOptions(language);
  } else if (decision.action === 'repair') {
    options = repairOptions(language);
  } else if (decision.action === 'wait') {
    options = waitOptions(language, emoji);
  } else if (lower.includes('weekend') || lower.includes('plan') || lower.includes('scene')) {
    options = weekendOptions(language, emoji, stats);
  } else if (isEmotional(lower)) {
    options = emotionalOptions(language, emoji);
  } else if (stats.incomingHasQuestion) {
    options = questionOptions(language, emoji);
  } else {
    options = genericOptions(language, emoji, stats);
  }

  options = filterOptions(options).map(opt => scoreOptionForContext(opt, decision, stats));

  return {
    decision,
    stats,
    options,
    stage_analysis: inferStage(recentMessages, decision, stats),
    next_move_hint: decision.best_move,
    provider: 'local-free-rule-engine',
    user_persona_used: userPersona
  };
}

function weekendOptions(language, emoji, stats) {
  const keepShort = stats.overInvesting;
  if (language === 'english') {
    return [
      { tone: 'casual', text: keepShort ? `Nothing fixed yet. You?` : `Nothing fixed yet, maybe food and rest. What about you?`, rationale: 'Answers and asks back without pressure.', score: 88, risk: 'low' },
      { tone: 'playful', text: `Plan is still loading${emoji} Got any good ideas?`, rationale: 'Light and playful without trying too hard.', score: 86, risk: 'low' },
      { tone: 'soft/flirty', text: `Depends. Good company can make even a simple plan work${emoji}`, rationale: 'Warm but not pushy.', score: 76, risk: 'medium' }
    ];
  }
  return [
    { tone: 'casual', text: keepShort ? `Abhi kuch fixed nahi. Tumhara?` : `Abhi kuch fixed nahi, shayad food aur rest. Tumhara kya scene hai?`, rationale: 'Natural Roman Urdu mix and asks back.', score: 90, risk: 'low' },
    { tone: 'playful', text: `Plan abhi loading pe hai${emoji} Tum koi acha idea do`, rationale: 'Playful and easy.', score: 87, risk: 'low' },
    { tone: 'soft/flirty', text: `Depend karta hai, company achi ho toh simple plan bhi set ho jata hai${emoji}`, rationale: 'Gentle flirt, not aggressive.', score: 77, risk: 'medium' }
  ];
}

function emotionalOptions(language) {
  if (language === 'english') {
    return [
      { tone: 'supportive', text: `That sounds exhausting. Take a small break first, you don't have to handle everything at once.`, rationale: 'Validates stress before solving.', score: 93, risk: 'low' },
      { tone: 'caring', text: `I get why you're drained. Want to vent, or should I distract you for a bit?`, rationale: 'Gives them control over the emotional direction.', score: 91, risk: 'low' },
      { tone: 'gentle/playful', text: `Okay first rule: breathe. Second rule: tiny chai break, then comeback.`, rationale: 'Lightens the mood without dismissing feelings.', score: 84, risk: 'low' }
    ];
  }
  return [
    { tone: 'supportive', text: `Yaar ye kaafi exhausting lag raha hai. Pehle thora break lo, sab ek sath handle karna zaroori nahi.`, rationale: 'Warm support in Roman Urdu.', score: 93, risk: 'low' },
    { tone: 'caring', text: `Samajh sakta hoon. Vent karna hai ya thora mood distract karun?`, rationale: 'Lets them choose support or distraction.', score: 91, risk: 'low' },
    { tone: 'gentle/playful', text: `Pehle breathe. Phir chai break. Phir comeback mode.`, rationale: 'Gentle humor, low pressure.', score: 84, risk: 'low' }
  ];
}

function questionOptions(language, emoji) {
  if (language === 'english') {
    return [
      { tone: 'direct/casual', text: `Honestly, I'd say it depends on the situation. What made you ask?`, rationale: 'Answers naturally and invites context.', score: 85, risk: 'low' },
      { tone: 'playful', text: `I have a simple answer and a dramatic answer. Which one do you want first?`, rationale: 'Creates playful curiosity.', score: 83, risk: 'low' },
      { tone: 'short', text: `Good question${emoji} I think yes, mostly.`, rationale: 'Short when energy matching matters.', score: 78, risk: 'low' }
    ];
  }
  return [
    { tone: 'direct/casual', text: `Honestly situation pe depend karta hai. Tumne kyun poocha?`, rationale: 'Natural and curious.', score: 86, risk: 'low' },
    { tone: 'playful', text: `Iska ek seedha answer hai aur ek dramatic answer. Pehle konsa?`, rationale: 'Playful without being intense.', score: 84, risk: 'low' },
    { tone: 'short', text: `Good question${emoji} Mere khayal se mostly yes.`, rationale: 'Short, safe answer.', score: 78, risk: 'low' }
  ];
}

function genericOptions(language, emoji, stats) {
  const short = stats.overInvesting || stats.energyRatio > 2;
  if (language === 'english') {
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

function waitOptions(language, emoji) {
  if (language === 'english') {
    return [
      { tone: 'wait', text: `[Do not send yet — wait 20-30 minutes]`, rationale: 'Best move is timing control, not more text.', score: 92, risk: 'low', action: 'wait' },
      { tone: 'short backup', text: `Haha fair${emoji}`, rationale: 'If you must reply, keep it very short.', score: 76, risk: 'medium' },
      { tone: 'low pressure', text: `Makes sense.`, rationale: 'Low-pressure reply that does not chase.', score: 72, risk: 'low' }
    ];
  }
  return [
    { tone: 'wait', text: `[Abhi send na karo — 20-30 min wait]`, rationale: 'Timing is better than chasing.', score: 92, risk: 'low', action: 'wait' },
    { tone: 'short backup', text: `Hahaha fair${emoji}`, rationale: 'If replying, keep it short.', score: 76, risk: 'medium' },
    { tone: 'low pressure', text: `Makes sense.`, rationale: 'Low pressure and simple.', score: 72, risk: 'low' }
  ];
}

function repairOptions(language) {
  if (language === 'english') {
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

function boundaryOptions(language) {
  if (language === 'english') {
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

function scoreOptionForContext(opt, decision, stats) {
  let score = Number(opt.score || 75);
  if (decision.action === 'wait' && !String(opt.tone).includes('wait')) score -= 8;
  if (stats.overInvesting && String(opt.text || '').split(/\s+/).length > 12) score -= 10;
  if (decision.risk_level === 'high' && opt.risk !== 'low') score -= 20;
  return { ...opt, score: Math.max(30, Math.min(99, Math.round(score))) };
}

function isEmotional(lower) {
  return ['tired', 'sad', 'stress', 'stressed', 'exam', 'drained', 'upset', 'anxious', 'thak', 'pareshan'].some(x => lower.includes(x));
}

function inferStage(messages, decision, stats) {
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

module.exports = { generateSuggestionsLocal, summarizeProfileLocal };
