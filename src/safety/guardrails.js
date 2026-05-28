// ── Blocked phrase list ─────────────────────────────────────────
// Expanded in v6: covers manipulation, guilt-tripping, possessiveness,
// stalking, sexual coercion, secrecy, threats, isolation tactics.
// Phrases are kept short to act as substring matches — common building
// blocks of manipulative messages.

const BLOCKED_PHRASES = [
  // ── Original 13 ─────────────────────────────────────────────
  'send me pics', 'prove you like me', 'if you cared', 'you owe me',
  'i will keep messaging', "don't tell anyone", 'secret from everyone',
  'you have to reply', 'i know where', "i won't stop", 'you are mine',
  'i deserve', 'meet me or else',

  // ── Manipulation / guilt-tripping ─────────────────────────────
  'after all i did for you', 'after everything', 'if you really loved me',
  "if you really cared", "you don't really love me", "you don't even care",
  'you made me do this', 'this is your fault', 'look what you made me do',
  'i guess i mean nothing', 'fine, ignore me', 'whatever, forget i asked',
  'i was only joking',  // typical retreat after crossing a line

  // ── Possessiveness / control ──────────────────────────────────
  "you can't talk to", "you're not allowed", 'who is that guy',
  'who were you with', "you're mine", 'belong to me', 'i forbid',
  'delete his number', 'block him', 'block her',

  // ── Sexual coercion / pressure ────────────────────────────────
  'send nudes', 'send a pic of', 'why so shy', 'no one will know',
  'just one picture', "don't be a prude", 'everyone does it',
  'just this once', 'come over now',

  // ── Secrecy / isolation ───────────────────────────────────────
  "don't tell your", "your friends don't get us", 'keep this between us',
  "they don't understand us", "they're just jealous",
  'cut them off', 'stop hanging out with',

  // ── Stalking / surveillance ───────────────────────────────────
  'i saw you at', 'i was watching', 'i followed you', 'i checked your',
  'sent me your location', 'share your location now',

  // ── Threats / intimidation ────────────────────────────────────
  "you'll regret", "i'll make you", "i'll tell everyone",
  "i'll post your", 'leak your', 'ruin your', "you'll be sorry",
  'i know people who', "you can't escape",

  // ── Self-harm leverage (manipulator-side) ─────────────────────
  "i'll hurt myself if",  // only as leverage from the other person
  "you're driving me to",
  "if you leave i'll",
];

// ── Manipulation patterns (regex) ───────────────────────────────
// Catch variations the substring list misses.

const BLOCKED_PATTERNS = [
  /if you (really|truly|actually) (loved|cared|liked|valued)/i,
  /you (always|never) (listen|reply|answer|respond|care|understand|ignore|forget|remember|do this)/i,
  /(prove|show) (me )?(your|you) love/i,
  /(send|share) (me )?(a )?(pic|picture|photo|nude)/i,
  /nobody (has to|needs to|will) know/i,
  /(don'?t|do not) (tell|mention|say) (anyone|anybody|a soul)/i,
  /you (are|'re) (mine|my property|nothing without)/i,
  /(meet|come) (me )?(or|else)/i,
  /i (will|'ll) (keep|never stop) (messag|call|text)ing/i,
];

function containsUnsafeText(text) {
  const lower = String(text || '').toLowerCase();
  for (const phrase of BLOCKED_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  return false;
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
