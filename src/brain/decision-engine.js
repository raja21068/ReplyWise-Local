const { analyzeRecentMessages } = require('./stats-engine');

function analyzeDecision({ contact, recentMessages, incomingMessage }) {
  const stats = analyzeRecentMessages(recentMessages, incomingMessage);
  const body = String(incomingMessage?.body || '').trim();
  const lower = body.toLowerCase();

  const boundary = hasBoundary(lower);
  const emotional = hasEmotionalSignal(lower);
  const conflict = hasConflictSignal(lower);
  const openQuestion = stats.incomingHasQuestion;
  const lowEffort = isLowEffort(lower);
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
  let riskLevel = 'low';

  if (boundary) {
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
    riskLevel = 'low';
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
    reason = openQuestion ? 'They asked an open question, so replying keeps momentum.' : 'The tone is warm enough for a natural reply.';
    bestMove = openQuestion ? 'Answer lightly and ask back.' : 'Keep the reply easy, warm, and not too long.';
    avoid = 'Avoid over-flirting or writing an essay.';
    temperature = warm ? 'warm' : 'neutral';
    riskLevel = 'low';
  }

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
  };
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

module.exports = { analyzeDecision };
