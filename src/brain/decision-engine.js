/**
 * Decision Engine v3
 *
 * Adds:
 * - Media awareness: image/audio/video/file/sticker/text + media risk.
 * - Group-chat awareness: group messages are ignored unless directly addressed,
 *   mentioned, or replying to the user's own message.
 * - Context summary for dashboard cards.
 */

const { analyzeRecentMessages } = require('./stats-engine');

const MEDIA_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file',
  STICKER: 'sticker',
  UNKNOWN: 'unknown',
};

function normalizeMediaType(raw) {
  if (!raw || raw === 'text') return MEDIA_TYPES.TEXT;
  const t = String(raw).toLowerCase();
  if (['image', 'photo', 'img', 'gif'].includes(t)) return MEDIA_TYPES.IMAGE;
  if (['audio', 'voice', 'ptt', 'ogg', 'voice-note', 'voice_note'].includes(t)) return MEDIA_TYPES.AUDIO;
  if (['video', 'mp4', 'mov'].includes(t)) return MEDIA_TYPES.VIDEO;
  if (['file', 'document', 'doc', 'pdf'].includes(t)) return MEDIA_TYPES.FILE;
  if (['sticker'].includes(t)) return MEDIA_TYPES.STICKER;
  return MEDIA_TYPES.UNKNOWN;
}

function analyzeDecision({ contact, recentMessages, incomingMessage }) {
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);
  const body = String(incomingMessage?.body || '').trim();
  const lower = body.toLowerCase();

  const mediaType = normalizeMediaType(incomingMessage?.media_type);
  const mediaSummary = String(incomingMessage?.media_summary || '').trim();
  const hasMedia = mediaType !== MEDIA_TYPES.TEXT;
  const mediaRisk = assessMediaRisk(mediaType, mediaSummary, incomingMessage?.from_unknown);

  const isGroup = Boolean(incomingMessage?.is_group);
  const groupCtx = isGroup ? analyzeGroupContext({ body, lower, incomingMessage }) : null;

  const boundary = hasBoundary(lower);
  const emotional = hasEmotionalSignal(lower);
  const conflict = hasConflictSignal(lower);
  const openQuestion = stats.incomingHasQuestion;
  const lowEffort = !hasMedia && isLowEffort(lower);
  const cold = stats.warmthScore < 35 || lowEffort;
  const warm = stats.warmthScore >= 65;
  const overInvesting = stats.overInvesting || stats.doubleTextRisk;

  let action = 'yes';
  let confidence = 75;
  let reason = 'The message is safe to answer naturally.';
  let bestMove = 'Reply briefly and match their energy.';
  let avoid = 'Avoid over-explaining or trying too hard.';
  let waitMinutes = 0;
  let temperature = temperatureFromStats(stats);
  let riskLevel = mediaRisk === 'high' ? 'medium' : 'low';

  if (isGroup && !groupCtx.directlyAddressed && !boundary) {
    action = 'no';
    confidence = 88;
    reason = `Group chat message not directly addressed to you${groupCtx.author ? ` (from ${groupCtx.author})` : ''}. Most group messages do not need a reply.`;
    bestMove = 'Watch the conversation. Reply only if you are tagged, asked directly, or can add something useful.';
    avoid = 'Do not auto-reply to every group message. Never use flirty tones in groups.';
    temperature = 'neutral';
    riskLevel = 'low';
  } else if (mediaRisk === 'high') {
    action = 'review';
    confidence = 80;
    reason = 'An unexpected attachment from an unknown sender requires human review before replying.';
    bestMove = 'Review the attachment manually. Do not open unknown files.';
    avoid = 'Do not click links or open files from people you do not know.';
    temperature = 'caution';
    riskLevel = 'high';
  } else if (mediaType === MEDIA_TYPES.STICKER && !body) {
    action = isGroup ? 'yes' : 'yes';
    confidence = isGroup ? 62 : 70;
    reason = isGroup
      ? 'They sent a sticker in a group. Reply only if it was directed at you.'
      : 'They sent a sticker — a light emoji reaction or brief reply keeps the vibe going.';
    bestMove = isGroup ? 'Keep it very short and neutral.' : 'Reply with a short warm message or a matching emoji.';
    avoid = isGroup ? 'Do not flirt or start a side conversation in the group.' : 'Do not overthink it — this is low-stakes.';
    temperature = warm ? 'warm' : 'neutral';
  } else if (mediaType === MEDIA_TYPES.AUDIO || mediaType === MEDIA_TYPES.VIDEO) {
    action = 'yes';
    confidence = mediaSummary || body ? 78 : 72;
    reason = mediaSummary || body
      ? `They sent a ${mediaType}: "${(mediaSummary || body).slice(0, 120)}". Reply to that content.`
      : `They sent a ${mediaType}. Listen/watch before replying so your reply fits.`;
    bestMove = mediaSummary || body ? 'Respond to what the media was about.' : `Review the ${mediaType} first, then reply naturally.`;
    avoid = 'Do not reply before listening — generic replies feel dismissive.';
    temperature = warm ? 'warm' : 'neutral';
  } else if (boundary) {
    action = 'no';
    confidence = 96;
    reason = 'The message appears to contain a boundary, rejection, or discomfort signal.';
    bestMove = 'Respect the boundary. Do not flirt or push. If needed, acknowledge calmly once.';
    avoid = 'Do not argue, guilt-trip, chase, or send repeated messages.';
    temperature = 'boundary';
    riskLevel = 'high';
  } else if (conflict) {
    action = 'repair';
    confidence = 90;
    reason = 'The tone looks tense or there may be a misunderstanding.';
    bestMove = 'Repair with a calm, short, non-defensive message.';
    avoid = 'Do not be sarcastic, sexual, dramatic, or overly clever.';
    temperature = 'tense';
    riskLevel = 'medium';
  } else if (emotional) {
    action = 'yes';
    confidence = 88;
    reason = 'The message carries emotional weight, so a supportive reply is better than silence.';
    bestMove = 'Validate first, then ask whether they want to vent or be distracted.';
    avoid = 'Do not turn it into flirting or make the conversation about you.';
    temperature = 'emotional';
  } else if (overInvesting && !openQuestion) {
    action = 'wait';
    confidence = 84;
    reason = 'You are currently investing more energy than the other person, and their message does not require a fast reply.';
    bestMove = 'Wait and keep the next reply short.';
    avoid = 'Do not double-text or send a long message.';
    waitMinutes = 30;
    temperature = cold ? 'cold' : 'neutral';
    riskLevel = 'medium';
  } else if (lowEffort && !openQuestion) {
    action = 'wait';
    confidence = 78;
    reason = 'The reply is low-effort. A fast long reply may look needy.';
    bestMove = 'Wait, or send a very short low-pressure reply.';
    avoid = 'Do not chase with questions repeatedly.';
    waitMinutes = 20;
    temperature = 'cold';
    riskLevel = 'medium';
  } else if (openQuestion || warm) {
    action = 'yes';
    confidence = openQuestion ? 90 : 82;
    reason = openQuestion
      ? 'They asked an open question, so replying keeps momentum.'
      : 'The tone is warm enough for a natural reply.';
    bestMove = openQuestion ? 'Answer lightly and ask back.' : 'Keep the reply easy, warm, and not too long.';
    avoid = 'Avoid over-flirting or writing an essay.';
    temperature = warm ? 'warm' : 'neutral';
  }

  if (isGroup && groupCtx.directlyAddressed && action === 'yes') {
    bestMove = 'Reply briefly, neutrally, and only to the group-relevant part.';
    avoid = 'Never use flirty, romantic, or overly personal tones in a group chat.';
    riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
  }

  const context_summary = buildContextSummary({
    action, temperature, riskLevel, mediaType, hasMedia, mediaSummary,
    openQuestion, emotional, conflict, boundary, overInvesting, stats,
    displayName: contact?.display_name || incomingMessage?.displayName || 'them',
    groupCtx,
  });

  return {
    should_reply: action,
    action,
    confidence,
    reason,
    best_move: bestMove,
    avoid,
    wait_minutes: waitMinutes,
    temperature,
    risk_level: riskLevel,
    media_type: mediaType,
    media_risk: mediaRisk,
    is_group: isGroup,
    group_directly_addressed: groupCtx ? groupCtx.directlyAddressed : false,
    group_reason: groupCtx ? groupCtx.reason : null,
    context_summary,
  };
}

function analyzeGroupContext({ body, lower, incomingMessage }) {
  const userName = String(
    incomingMessage?._userDisplayName ||
    incomingMessage?.user_display_name ||
    process.env.USER_DISPLAY_NAME ||
    ''
  ).trim();
  const botName = String(process.env.BOT_DISPLAY_NAME || '').trim();

  const mentionedMe = Boolean(incomingMessage?.mentioned_me || incomingMessage?.mentions_me || incomingMessage?.mentionedMe);
  const replyToMe = Boolean(incomingMessage?.reply_to_me || incomingMessage?.quoted_from_me || incomingMessage?.replyToMe);
  const explicitMention = /(^|\s)@[\w.\-]+/.test(body);
  const nameHit = [userName, botName]
    .filter(Boolean)
    .some(name => lower.includes(name.toLowerCase()));
  const directAddress = /\b(you|u|tum|ap|aap|bro|bhai|dude)\b/.test(lower) && /[?؟]/.test(body);

  const directlyAddressed = mentionedMe || replyToMe || nameHit || directAddress;
  let reason = 'not addressed';
  if (mentionedMe) reason = 'mentioned/tagged you';
  else if (replyToMe) reason = 'replying to your message';
  else if (nameHit) reason = 'contains your name';
  else if (directAddress) reason = 'direct question in group';
  else if (explicitMention) reason = 'mentions someone else';

  return {
    directlyAddressed,
    reason,
    author: incomingMessage?.author || null,
  };
}

function buildContextSummary({ action, mediaType, hasMedia, mediaSummary,
  openQuestion, emotional, conflict, boundary, overInvesting, stats, displayName, groupCtx }) {
  const parts = [];

  if (groupCtx) parts.push(groupCtx.directlyAddressed ? `group: ${groupCtx.reason}` : 'group: not addressed to you');
  if (hasMedia && mediaType !== MEDIA_TYPES.TEXT) {
    parts.push(mediaSummary ? `sent a ${mediaType}: "${mediaSummary.slice(0, 50)}"` : `sent a ${mediaType}`);
  }
  if (boundary) parts.push('set a boundary');
  else if (conflict) parts.push('tension detected');
  else if (emotional) parts.push('sharing something emotional');
  else if (openQuestion) parts.push('asked a question');

  if (overInvesting) parts.push('you are over-investing');
  if (stats.doubleTextRisk) parts.push('double-text risk');
  if (stats.warmthScore >= 70) parts.push('warm vibe');
  else if (stats.warmthScore < 35) parts.push('cold vibe');

  const situationStr = parts.length ? parts.join(', ') : 'neutral exchange';
  const actionStr = {
    yes: 'Safe to reply.',
    wait: 'Better to wait.',
    no: 'Do not reply.',
    repair: 'Repair mode.',
    review: 'Review required.',
  }[action] || 'Check manually.';

  return `${displayName}: ${situationStr}. ${actionStr}`;
}

function assessMediaRisk(mediaType, mediaSummary, fromUnknown) {
  if (mediaType === MEDIA_TYPES.TEXT || mediaType === MEDIA_TYPES.STICKER) return 'low';
  if (mediaType === MEDIA_TYPES.UNKNOWN) return fromUnknown ? 'high' : 'medium';
  if (mediaType === MEDIA_TYPES.FILE && fromUnknown) return 'high';
  if (fromUnknown && [MEDIA_TYPES.IMAGE, MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO].includes(mediaType)) return 'medium';
  return 'low';
}

function hasBoundary(lower) {
  return [
    'stop', 'leave me', 'not interested', 'don\'t message', 'dont message', 'uncomfortable',
    'no thanks', 'i said no', 'busy right now', 'please stop', 'not comfortable'
  ].some(x => lower.includes(x));
}

function hasEmotionalSignal(lower) {
  return ['sad', 'stress', 'stressed', 'tired', 'exam', 'anxious', 'depressed', 'upset', 'cry', 'drained', 'thak', 'pareshan'].some(x => lower.includes(x));
}

function hasConflictSignal(lower) {
  return ['why did you', 'you always', 'you never', 'angry', 'mad', 'hurt', 'rude', 'ignore', 'ignored', 'offended', 'naraz'].some(x => lower.includes(x));
}

function isLowEffort(lower) {
  const cleaned = lower.replace(/[😂😄😭🔥🙂😉🥺😅😆😊💪✨❤️\s.!?]/g, '').trim();
  return ['ok', 'k', 'hmm', 'hm', 'nice', 'lol', 'haha', 'acha', 'theek'].includes(cleaned) || lower.length <= 6;
}

function temperatureFromStats(stats) {
  if (stats.warmthScore >= 75) return 'playful';
  if (stats.warmthScore >= 60) return 'warm';
  if (stats.warmthScore <= 30) return 'cold';
  return 'neutral';
}

module.exports = { analyzeDecision, normalizeMediaType, assessMediaRisk, analyzeGroupContext, MEDIA_TYPES };
