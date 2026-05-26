function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function detectLanguage(text) {
  const lower = String(text || '').toLowerCase();
  const romanUrduHints = ['kya', 'haan', 'nahi', 'acha', 'thora', 'kaisa', 'batao', 'hai', 'tha', 'tum', 'mein', 'mera', 'apka', 'scene'];
  const hits = romanUrduHints.filter((w) => lower.includes(w)).length;
  if (hits >= 2) return 'mixed';
  return 'english';
}

function countEmojis(text) {
  return (String(text || '').match(/[😂😄😭🔥🙂😉🥺😅😆😊💪✨❤️]/g) || []).length;
}

function analyzeRecentMessages(messages, incomingMessage) {
  const recent = messages || [];
  const incoming = recent.filter(m => m.direction === 'incoming');
  const outgoing = recent.filter(m => m.direction === 'outgoing');
  const incomingWordCounts = incoming.map(m => words(m.body).length);
  const outgoingWordCounts = outgoing.map(m => words(m.body).length);
  const incomingAvgWords = avg(incomingWordCounts);
  const outgoingAvgWords = avg(outgoingWordCounts);
  const energyRatio = incomingAvgWords > 0 ? outgoingAvgWords / incomingAvgWords : 1;
  const lastTwoOutgoing = recent.slice(-3).filter(m => m.direction === 'outgoing').length >= 2;

  const body = incomingMessage?.body || '';
  const question = body.includes('?') || /\b(kya|what|why|how|kab|when|where|kaisa|batao)\b/i.test(body);
  const emojiCount = countEmojis(body);
  const language = detectLanguage(`${recent.map(m => m.body).join(' ')} ${body}`);

  const contactQuestionRate = incoming.length ? incoming.filter(m => /\?/.test(m.body)).length / incoming.length : 0;
  const userQuestionRate = outgoing.length ? outgoing.filter(m => /\?/.test(m.body)).length / outgoing.length : 0;

  const lastIncomingAt = [...recent].reverse().find(m => m.direction === 'incoming')?.timestamp;
  const lastOutgoingAt = [...recent].reverse().find(m => m.direction === 'outgoing')?.timestamp;
  let minutesSinceUserLastReply = null;
  if (lastOutgoingAt) minutesSinceUserLastReply = Math.round((Date.now() - new Date(lastOutgoingAt).getTime()) / 60000);

  return {
    messageCount: recent.length,
    incomingCount: incoming.length,
    outgoingCount: outgoing.length,
    incomingAvgWords: Math.round(incomingAvgWords * 10) / 10,
    outgoingAvgWords: Math.round(outgoingAvgWords * 10) / 10,
    energyRatio: Math.round(energyRatio * 100) / 100,
    overInvesting: energyRatio > 2.5 && outgoing.length >= 3,
    doubleTextRisk: lastTwoOutgoing,
    incomingHasQuestion: question,
    incomingEmojiCount: emojiCount,
    detectedLanguage: language,
    contactQuestionRate: Math.round(contactQuestionRate * 100),
    userQuestionRate: Math.round(userQuestionRate * 100),
    minutesSinceUserLastReply,
    warmthScore: computeWarmthScore(recent, body),
  };
}

function computeWarmthScore(messages, body) {
  const text = `${messages.slice(-8).map(m => m.body).join(' ')} ${body}`.toLowerCase();
  let score = 50;
  const warm = ['haha', 'lol', '😂', '😄', 'aww', 'nice', 'cute', 'thank', 'thanks', 'miss', 'good', 'acha', 'hahaha'];
  const cold = ['ok', 'k', 'hmm', 'fine', 'busy', 'later', 'leave', 'stop', 'no', 'not interested'];
  for (const w of warm) if (text.includes(w)) score += 5;
  for (const w of cold) if (text.includes(w)) score -= 6;
  return clamp(score, 0, 100);
}

module.exports = {
  analyzeRecentMessages,
  detectLanguage,
  countEmojis,
};
