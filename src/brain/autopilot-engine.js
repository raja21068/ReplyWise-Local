const { cleanSuggestionText, containsUnsafeText, isSystemInstructionText } = require('../safety/guardrails');

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function numberEnv(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : defaultValue;
}

function evaluateAutopilot({ contact, decision, stats, options, incomingMessage, autoSendsToday = 0 }) {
  const safeOptions = (options || [])
    .map((opt, index) => ({ ...opt, index, text: cleanSuggestionText(opt.text) }))
    .filter((opt) => isSendableOption(opt));

  const recommended = chooseBestOption(safeOptions, decision, stats);
  const rules = contact?.contactRules || contact?.contact_rules || {};
  const body = String(incomingMessage?.body || '').trim();
  const lower = body.toLowerCase();
  const isGroup = Boolean(incomingMessage?.is_group || incomingMessage?.metadata?.is_group);
  const mentionedMe = Boolean(incomingMessage?.mentioned_me || incomingMessage?.metadata?.mentioned_me);
  const replyToMe = Boolean(incomingMessage?.reply_to_me || incomingMessage?.metadata?.reply_to_me);

  const autoChooseEnabled = boolEnv('AUTO_CHOOSE_ENABLED', true) || ['auto_choose', 'auto_send_safe'].includes(rules.autopilot_mode);
  const autoSendEnabled = boolEnv('AUTO_SEND_ENABLED', false);
  const whitelistOnly = boolEnv('AUTO_SEND_WHITELIST_ONLY', true);
  const whitelisted = Boolean(rules.auto_send_whitelisted || rules.autopilot_whitelisted || rules.autopilot_mode === 'auto_send_safe');
  const minConfidence = numberEnv('AUTO_SEND_CONFIDENCE_MIN', 97);
  const maxReplyLength = numberEnv('AUTO_SEND_MAX_LENGTH', 80);
  const dailyLimit = numberEnv('AUTO_SEND_DAILY_LIMIT', 20);
  const allowOpenQuestions = boolEnv('AUTO_SEND_ALLOW_OPEN_QUESTIONS', false);
  const allowEmotional = boolEnv('AUTO_SEND_ALLOW_EMOTIONAL', false);

  const blockers = [];
  if (!autoSendEnabled) blockers.push('AUTO_SEND_ENABLED is false');
  if (isGroup) blockers.push('group chats require human approval');
  if (isGroup && !mentionedMe && !replyToMe) blockers.push('group message did not mention or directly reply to you');
  if (whitelistOnly && !whitelisted) blockers.push('contact is not auto-send whitelisted');
  if (!recommended) blockers.push('no safe sendable option');
  if ((decision?.risk_level || 'low') !== 'low') blockers.push(`risk level is ${decision?.risk_level || 'unknown'}`);
  if (!['yes', 'reply_now'].includes(String(decision?.action || decision?.should_reply || '').toLowerCase())) blockers.push(`decision is ${decision?.action || decision?.should_reply}`);
  if (Number(decision?.confidence || 0) < minConfidence) blockers.push(`confidence is below ${minConfidence}%`);
  if (recommended && recommended.text.length > maxReplyLength) blockers.push(`reply is longer than ${maxReplyLength} characters`);
  if (recommended && containsUnsafeText(recommended.text)) blockers.push('reply text failed safety filter');
  if (stats?.doubleTextRisk || stats?.overInvesting) blockers.push('energy matching says slow down');

  const simpleAck = isSimpleAcknowledgement(lower);
  const greeting = isSimpleGreeting(lower);
  const thanks = isThanks(lower);
  const openQuestion = Boolean(stats?.incomingHasQuestion);
  const emotional = ['emotional', 'tense', 'boundary'].includes(String(decision?.temperature || '').toLowerCase()) || hasEmotionalOrSensitiveSignal(lower);
  const flirtyOrDate = hasFlirtyOrDateSignal(lower);

  if (!simpleAck && !greeting && !thanks && !(allowOpenQuestions && openQuestion)) {
    blockers.push('message is not a simple low-risk acknowledgement/greeting');
  }
  if (openQuestion && !allowOpenQuestions) blockers.push('open questions require human approval');
  if (emotional && !allowEmotional) blockers.push('emotional/sensitive messages require human approval');
  if (flirtyOrDate) blockers.push('flirty/date-planning messages require human approval');
  if (dailyLimit <= 0) blockers.push('daily auto-send limit is zero');
  if (Number(autoSendsToday || 0) >= dailyLimit) blockers.push(`daily auto-send limit reached (${dailyLimit})`);

  const autoSendAllowed = blockers.length === 0;

  return {
    version: 'smart-autopilot-v1',
    mode: autoSendAllowed ? 'auto_send_safe' : autoChooseEnabled ? 'auto_choose' : 'manual',
    auto_choose: {
      enabled: autoChooseEnabled,
      allowed: autoChooseEnabled && Boolean(recommended),
    },
    auto_send: {
      enabled: autoSendEnabled,
      allowed: autoSendAllowed,
      blocked_reasons: blockers,
      whitelist_only: whitelistOnly,
      whitelisted,
      min_confidence: minConfidence,
      max_reply_length: maxReplyLength,
      daily_limit: dailyLimit,
      auto_sends_today: Number(autoSendsToday || 0),
    },
    recommended_index: recommended ? recommended.index : null,
    recommended_tone: recommended ? recommended.tone : null,
    recommended_text: recommended ? recommended.text : null,
    recommended_score: recommended ? recommended.score : null,
    safety_class: autoSendAllowed ? 'low-risk-auto-send' : (decision?.risk_level || 'manual-review'),
  };
}

function chooseBestOption(options, decision, stats) {
  if (!options.length) return null;
  const ranked = options
    .filter((opt) => opt.risk !== 'high')
    .map((opt) => {
      let score = Number(opt.score || 0);
      if (opt.risk === 'medium') score -= 10;
      if (stats?.overInvesting && wordCount(opt.text) > 10) score -= 10;
      if (decision?.action === 'repair' && String(opt.tone || '').includes('repair')) score += 8;
      if (decision?.action === 'wait' && opt.action === 'wait') score += 12;
      return { ...opt, _rankScore: score };
    })
    .sort((a, b) => b._rankScore - a._rankScore);
  return ranked[0] || null;
}

function isSendableOption(opt) {
  if (!opt || !opt.text) return false;
  if (isSystemInstructionText(opt.text)) return false;
  if (['wait', 'skip', 'no_reply'].includes(String(opt.action || '').toLowerCase())) return false;
  if (containsUnsafeText(opt.text)) return false;
  return true;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function isSimpleAcknowledgement(lower) {
  const cleaned = lower.replace(/[😂😄😭🔥🙂😉🥺😅😆😊💪✨❤️❤🤍🤝👍👌\s.!?,]/g, '').trim();
  return [
    'ok', 'okay', 'k', 'kk', 'hmm', 'hm', 'nice', 'great', 'cool', 'lol', 'haha', 'hahaha',
    'acha', 'achaa', 'theek', 'sahi', 'done', 'yes', 'yep', 'yeah', 'no', 'nope', 'alright'
  ].includes(cleaned) || lower.length <= 8;
}

function isSimpleGreeting(lower) {
  return /^(hi|hey|hello|salam|assalam|good morning|morning|gm|good night|gn|aoa|aslam)/i.test(lower.trim());
}

function isThanks(lower) {
  return ['thanks', 'thank you', 'ty', 'shukriya', 'thankyou', 'jazakallah'].some((x) => lower.includes(x));
}

function hasEmotionalOrSensitiveSignal(lower) {
  return [
    'sad', 'cry', 'crying', 'depressed', 'anxious', 'stress', 'stressed', 'hurt', 'angry', 'mad',
    'uncomfortable', 'stop', 'not interested', 'leave me', 'family', 'money', 'ill', 'sick', 'hospital',
    'exam', 'pareshan', 'naraz', 'thak', 'tired'
  ].some((x) => lower.includes(x));
}

function hasFlirtyOrDateSignal(lower) {
  return [
    'date', 'meet', 'hangout', 'hang out', 'come over', 'miss you', 'love', 'cute', 'hot', 'sexy',
    'weekend plan', 'plan?', 'coffee', 'dinner', 'movie', 'milna', 'milo', 'yaad'
  ].some((x) => lower.includes(x));
}

module.exports = { evaluateAutopilot, chooseBestOption };
