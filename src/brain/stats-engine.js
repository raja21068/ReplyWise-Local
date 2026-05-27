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

  // ── Response cadence (NEW) ────────────────────────────────────
  // Compute average reply gaps using existing timestamps. These are the
  // strongest signals of conversational interest level — much more reliable
  // than keyword-based warmth scoring alone.
  const cadence = computeResponseCadence(recent);

  // ── Activity momentum (NEW) ──────────────────────────────────
  // Compare message volume in last 24 h vs the 24 h before that.
  const momentum = computeMomentum(recent);

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
    warmthScore: computeWarmthScore(recent, body, cadence, momentum),

    // ── New cadence + momentum fields ───────────────────────────
    theirAvgResponseMin:  cadence.theirAvgMin,
    yourAvgResponseMin:   cadence.yourAvgMin,
    responseTimeRatio:    cadence.ratio,
    cadenceTrend:         cadence.trend,            // 'speeding_up' | 'stable' | 'slowing_down'
    momentumScore:        momentum.score,           // -100..+100  positive = growing
    momentumLabel:        momentum.label,           // 'growing' | 'steady' | 'cooling' | 'dying'
    messagesLast24h:      momentum.last24h,
    messagesPrior24h:     momentum.prior24h,
  };
}

// ── Response cadence helpers ────────────────────────────────────

/**
 * Walks the message history and computes:
 *   • theirAvgMin   — avg minutes between *your* outgoing and *their* reply
 *   • yourAvgMin    — avg minutes between *their* incoming and *your* reply
 *   • ratio         — yourAvgMin / theirAvgMin  (>1 means you reply slower than them)
 *   • trend         — comparing last 4 gaps to prior 4 gaps
 *
 * Real-world interpretation:
 *   ratio < 0.5  → you reply much faster than them (potential over-investment)
 *   ratio ~ 1    → balanced cadence
 *   ratio > 2    → they reply much faster than you (you might be holding back)
 *   trend speeding_up + their gaps shrinking → growing interest
 *   trend slowing_down + their gaps growing → cooling off
 */
function computeResponseCadence(messages) {
  const empty = { theirAvgMin: null, yourAvgMin: null, ratio: null, trend: 'stable' };
  if (!Array.isArray(messages) || messages.length < 4) return empty;

  const sorted = [...messages]
    .filter((m) => m.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const theirGaps = [];   // outgoing → incoming
  const yourGaps  = [];   // incoming → outgoing

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.direction === curr.direction) continue; // need a direction flip
    const gapMs = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    if (gapMs <= 0 || gapMs > 7 * 24 * 60 * 60_000) continue;   // skip 7-day+ gaps (cold restart)
    const gapMin = gapMs / 60_000;
    if (prev.direction === 'outgoing' && curr.direction === 'incoming') theirGaps.push(gapMin);
    if (prev.direction === 'incoming' && curr.direction === 'outgoing') yourGaps.push(gapMin);
  }

  const theirAvg = theirGaps.length ? avg(theirGaps) : null;
  const yourAvg  = yourGaps.length  ? avg(yourGaps)  : null;
  const ratio = (theirAvg && yourAvg) ? Math.round((yourAvg / theirAvg) * 100) / 100 : null;

  // Trend: compare last 4 of theirGaps to prior 4
  let trend = 'stable';
  if (theirGaps.length >= 8) {
    const recent = avg(theirGaps.slice(-4));
    const prior  = avg(theirGaps.slice(-8, -4));
    if (prior > 0 && recent < prior * 0.65) trend = 'speeding_up';
    else if (prior > 0 && recent > prior * 1.5) trend = 'slowing_down';
  }

  return {
    theirAvgMin: theirAvg ? Math.round(theirAvg) : null,
    yourAvgMin:  yourAvg  ? Math.round(yourAvg)  : null,
    ratio,
    trend,
  };
}

/**
 * Activity momentum — is this conversation growing or dying?
 * Compares message count in the last 24 h to the 24 h before that.
 */
function computeMomentum(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return { score: 0, label: 'unknown', last24h: 0, prior24h: 0 };
  }
  const now = Date.now();
  const oneDay = 24 * 60 * 60_000;
  let last24h = 0, prior24h = 0;
  for (const m of messages) {
    const t = new Date(m.timestamp || 0).getTime();
    if (!t) continue;
    const age = now - t;
    if (age >= 0 && age < oneDay)             last24h++;
    else if (age >= oneDay && age < 2 * oneDay) prior24h++;
  }
  // Score: log-scaled diff so a 3→6 jump and a 10→20 jump feel similar
  let score = 0;
  if (last24h + prior24h > 0) {
    score = Math.round(((last24h - prior24h) / Math.max(1, prior24h)) * 50);
    score = clamp(score, -100, 100);
  }
  let label = 'steady';
  if (last24h === 0 && prior24h === 0)             label = 'dormant';
  else if (last24h === 0 && prior24h > 0)          label = 'dying';
  else if (score >= 40)                            label = 'growing';
  else if (score <= -40)                           label = 'cooling';
  return { score, label, last24h, prior24h };
}

function computeWarmthScore(messages, body, cadence, momentum) {
  const text = `${messages.slice(-8).map(m => m.body).join(' ')} ${body}`.toLowerCase();
  let score = 50;
  const warm = ['haha', 'lol', '😂', '😄', 'aww', 'nice', 'cute', 'thank', 'thanks', 'miss', 'good', 'acha', 'hahaha'];
  const cold = ['ok', 'k', 'hmm', 'fine', 'busy', 'later', 'leave', 'stop', 'no', 'not interested'];
  for (const w of warm) if (text.includes(w)) score += 5;
  for (const w of cold) if (text.includes(w)) score -= 6;

  // ── Cadence-based adjustment (NEW) ────────────────────────────
  // Fast replies from them = high warmth; slow replies = cold signal.
  if (cadence?.theirAvgMin != null) {
    if (cadence.theirAvgMin < 5)        score += 15;   // replying within minutes
    else if (cadence.theirAvgMin < 30)  score += 8;
    else if (cadence.theirAvgMin > 180) score -= 8;    // 3+ hour avg gap
    else if (cadence.theirAvgMin > 720) score -= 15;   // 12+ hour avg gap
  }
  // Trend direction matters more than absolute speed
  if (cadence?.trend === 'speeding_up')  score += 10;
  if (cadence?.trend === 'slowing_down') score -= 10;

  // ── Momentum-based adjustment (NEW) ───────────────────────────
  if (momentum?.label === 'growing') score += 8;
  if (momentum?.label === 'cooling') score -= 8;
  if (momentum?.label === 'dying')   score -= 15;

  return clamp(score, 0, 100);
}

module.exports = {
  analyzeRecentMessages,
  detectLanguage,
  countEmojis,
};
