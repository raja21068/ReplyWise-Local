/**
 * Decision Engine v2
 *
 * Changes from v1:
 * ─────────────────
 * • Accepts `media_type` and `media_summary` on incomingMessage (image/audio/video/file/sticker/text)
 * • Returns `context_summary` — one-line human-readable situation summary
 * • Returns `media_risk` — extra risk flag when an unknown/unexpected attachment is present
 * • Sticker-only and voice-note messages get distinct routing (no text to reply to blindly)
 * • All existing logic preserved and unchanged
 */

const { analyzeRecentMessages } = require('./stats-engine');

// ── Media type constants ──────────────────────────────────────
const MEDIA_TYPES = {
  TEXT:    'text',
  IMAGE:   'image',
  AUDIO:   'audio',
  VIDEO:   'video',
  FILE:    'file',
  STICKER: 'sticker',
  UNKNOWN: 'unknown',
};

function normalizeMediaType(raw) {
  if (!raw || raw === 'text') return MEDIA_TYPES.TEXT;
  const t = String(raw).toLowerCase();
  if (['image', 'photo', 'img', 'gif'].includes(t)) return MEDIA_TYPES.IMAGE;
  if (['audio', 'voice', 'ptt', 'ogg'].includes(t)) return MEDIA_TYPES.AUDIO;
  if (['video', 'mp4', 'mov'].includes(t)) return MEDIA_TYPES.VIDEO;
  if (['file', 'document', 'doc', 'pdf', 'sticker'].includes(t)) return t === 'sticker' ? MEDIA_TYPES.STICKER : MEDIA_TYPES.FILE;
  return MEDIA_TYPES.UNKNOWN;
}

// ── Main analyzeDecision ──────────────────────────────────────

function analyzeDecision({ contact, recentMessages, incomingMessage }) {
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);
  const body   = String(incomingMessage?.body || '').trim();
  const lower  = body.toLowerCase();

  // Media awareness
  const mediaType   = normalizeMediaType(incomingMessage?.media_type);
  const mediaSummary = String(incomingMessage?.media_summary || '').trim();
  const hasMedia    = mediaType !== MEDIA_TYPES.TEXT;
  const mediaRisk   = assessMediaRisk(mediaType, mediaSummary, incomingMessage?.from_unknown);

  const boundary    = hasBoundary(lower);
  const emotional   = hasEmotionalSignal(lower);
  const conflict    = hasConflictSignal(lower);
  const openQuestion = stats.incomingHasQuestion;
  const lowEffort   = !hasMedia && isLowEffort(lower);        // sticker ≠ low-effort
  const cold        = stats.warmthScore < 35 || lowEffort;
  const warm        = stats.warmthScore >= 65;
  const overInvesting = stats.overInvesting || stats.doubleTextRisk;

  let action       = 'yes';
  let confidence   = 75;
  let reason       = 'The message is safe to answer naturally.';
  let bestMove     = 'Reply briefly and match their energy.';
  let avoid        = 'Avoid over-explaining or trying too hard.';
  let waitMinutes  = 0;
  let temperature  = temperatureFromStats(stats);
  let riskLevel    = mediaRisk === 'high' ? 'medium' : 'low'; // elevate when unknown media

  // ── Decision tree ─────────────────────────────────────────

  if (mediaRisk === 'high') {
    action     = 'review';
    confidence = 80;
    reason     = 'An unexpected attachment from an unknown sender requires human review before replying.';
    bestMove   = 'Review the attachment manually. Do not open unknown files.';
    avoid      = 'Do not click links or open files from people you do not know.';
    temperature = 'caution';
    riskLevel  = 'high';
  } else if (mediaType === MEDIA_TYPES.STICKER && !body) {
    // Sticker only — they're expressing something but there's no text to reply to
    action     = 'yes';
    confidence = 70;
    reason     = 'They sent a sticker — a light emoji reaction or brief reply keeps the vibe going.';
    bestMove   = 'Reply with a short warm message or a matching emoji.';
    avoid      = 'Don\'t overthink it — this is low-stakes.';
    temperature = 'warm';
  } else if (mediaType === MEDIA_TYPES.AUDIO || mediaType === MEDIA_TYPES.VIDEO) {
    action     = 'yes';
    confidence = 72;
    reason     = mediaSummary
      ? `They sent a ${mediaType}: "${mediaSummary}". A brief acknowledgement keeps the conversation going.`
      : `They sent a ${mediaType}. Listen/watch before replying so your reply fits.`;
    bestMove   = mediaSummary ? 'Respond to what the media was about.' : `Review the ${mediaType} first, then reply naturally.`;
    avoid      = 'Don\'t reply before listening — generic replies feel dismissive.';
    temperature = warm ? 'warm' : 'neutral';
  } else if (boundary) {
    action     = 'no';
    confidence = 96;
    reason     = 'The message appears to contain a boundary, rejection, or discomfort signal.';
    bestMove   = 'Respect the boundary. Do not flirt or push. If needed, acknowledge calmly once.';
    avoid      = 'Do not argue, guilt-trip, chase, or send repeated messages.';
    temperature = 'boundary';
    riskLevel  = 'high';
  } else if (conflict) {
    action     = 'repair';
    confidence = 90;
    reason     = 'The tone looks tense or there may be a misunderstanding.';
    bestMove   = 'Repair with a calm, short, non-defensive message.';
    avoid      = 'Do not be sarcastic, sexual, dramatic, or overly clever.';
    temperature = 'tense';
    riskLevel  = 'medium';
  } else if (emotional) {
    action     = 'yes';
    confidence = 88;
    reason     = 'The message carries emotional weight, so a supportive reply is better than silence.';
    bestMove   = 'Validate first, then ask whether they want to vent or be distracted.';
    avoid      = 'Do not turn it into flirting or make the conversation about you.';
    temperature = 'emotional';
  } else if (overInvesting && !openQuestion) {
    action     = 'wait';
    confidence = 84;
    reason     = 'You are currently investing more energy than the other person, and their message does not require a fast reply.';
    bestMove   = 'Wait and keep the next reply short.';
    avoid      = 'Do not double-text or send a long message.';
    waitMinutes = 30;
    temperature = cold ? 'cold' : 'neutral';
    riskLevel  = 'medium';
  } else if (lowEffort && !openQuestion) {
    action     = 'wait';
    confidence = 78;
    reason     = 'The reply is low-effort. A fast long reply may look needy.';
    bestMove   = 'Wait, or send a very short low-pressure reply.';
    avoid      = 'Do not chase with questions repeatedly.';
    waitMinutes = 20;
    temperature = 'cold';
    riskLevel  = 'medium';
  } else if (openQuestion || warm) {
    action     = 'yes';
    confidence = openQuestion ? 90 : 82;
    reason     = openQuestion
      ? 'They asked an open question, so replying keeps momentum.'
      : 'The tone is warm enough for a natural reply.';
    bestMove   = openQuestion ? 'Answer lightly and ask back.' : 'Keep the reply easy, warm, and not too long.';
    avoid      = 'Avoid over-flirting or writing an essay.';
    temperature = warm ? 'warm' : 'neutral';
  }

  // ── Context summary ────────────────────────────────────────
  const context_summary = buildContextSummary({
    action, temperature, riskLevel, mediaType, hasMedia, mediaSummary,
    openQuestion, emotional, conflict, boundary, overInvesting, stats,
    displayName: contact?.display_name || incomingMessage?.displayName || 'them',
  });

  return {
    should_reply:    action,
    action,
    confidence,
    reason,
    best_move:       bestMove,
    avoid,
    wait_minutes:    waitMinutes,
    temperature,
    risk_level:      riskLevel,
    media_type:      mediaType,
    media_risk:      mediaRisk,
    context_summary,
  };
}

// ── Context summary builder ───────────────────────────────────

function buildContextSummary({ action, temperature, riskLevel, mediaType, hasMedia, mediaSummary,
  openQuestion, emotional, conflict, boundary, overInvesting, stats, displayName }) {
  const parts = [];

  if (hasMedia && mediaType !== MEDIA_TYPES.TEXT) {
    parts.push(mediaSummary ? `Sent a ${mediaType}: "${mediaSummary.slice(0, 50)}"` : `Sent a ${mediaType}`);
  }
  if (boundary)      parts.push('set a boundary');
  else if (conflict) parts.push('tension detected');
  else if (emotional) parts.push('sharing something emotional');
  else if (openQuestion) parts.push('asked a question');

  if (overInvesting)         parts.push('you\'re over-investing');
  if (stats.doubleTextRisk)  parts.push('double-text risk');
  if (stats.warmthScore >= 70) parts.push('warm vibe');
  else if (stats.warmthScore < 35) parts.push('cold vibe');

  const situationStr = parts.length ? parts.join(', ') : 'neutral exchange';
  const actionStr = {
    yes:    'Safe to reply.',
    wait:   'Better to wait.',
    no:     'Do not reply.',
    repair: 'Repair mode.',
    review: 'Review required.',
  }[action] || 'Check manually.';

  return `${displayName}: ${situationStr}. ${actionStr}`;
}

// ── Media risk assessment ─────────────────────────────────────

function assessMediaRisk(mediaType, mediaSummary, fromUnknown) {
  if (mediaType === MEDIA_TYPES.TEXT || mediaType === MEDIA_TYPES.STICKER) return 'low';
  if (mediaType === MEDIA_TYPES.UNKNOWN) return fromUnknown ? 'high' : 'medium';
  if (mediaType === MEDIA_TYPES.FILE && fromUnknown) return 'high';
  // Images/video from known contacts are medium-low; from unknown elevate
  if (fromUnknown && [MEDIA_TYPES.IMAGE, MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO].includes(mediaType)) return 'medium';
  return 'low';
}

// ── Signal detectors (unchanged from v1) ─────────────────────

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

module.exports = { analyzeDecision, normalizeMediaType, assessMediaRisk, MEDIA_TYPES };
