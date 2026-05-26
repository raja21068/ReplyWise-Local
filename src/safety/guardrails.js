function containsUnsafeText(text) {
  const lower = String(text || '').toLowerCase();
  const blocked = [
    'send me pics', 'prove you like me', 'if you cared', 'you owe me', 'i will keep messaging',
    'don\'t tell anyone', 'secret from everyone', 'you have to reply', 'i know where',
    'i won\'t stop', 'you are mine', 'i deserve', 'meet me or else'
  ];
  return blocked.some((phrase) => lower.includes(phrase));
}

function cleanSuggestionText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function filterOptions(options) {
  const safe = [];
  for (const option of options || []) {
    const text = cleanSuggestionText(option.text);
    if (!text) continue;
    if (containsUnsafeText(text)) continue;
    safe.push({
      tone: String(option.tone || 'casual').slice(0, 60),
      text,
      rationale: String(option.rationale || 'Fits the current conversation.').slice(0, 300),
      score: Number(option.score || 75),
      risk: ['low', 'medium', 'high'].includes(option.risk) ? option.risk : 'low',
      action: option.action || null,
    });
  }
  while (safe.length < 3) {
    safe.push({
      tone: ['casual', 'warm', 'simple'][safe.length] || 'casual',
      text: ['Haha fair 😄', 'That makes sense.', 'Tell me more.'][safe.length] || 'Makes sense.',
      rationale: 'Safe local fallback option.',
      score: 70,
      risk: 'low',
      action: null,
    });
  }
  return safe.slice(0, 3);
}

function assertHumanApproval() {
  // Manual send buttons are always allowed. Autonomous sends are handled only
  // by the Smart Autopilot policy engine and never use this manual path.
  return true;
}

function isSystemInstructionText(text) {
  return /^\[.*\]$/.test(String(text || '').trim());
}

module.exports = { containsUnsafeText, cleanSuggestionText, filterOptions, assertHumanApproval, isSystemInstructionText };
