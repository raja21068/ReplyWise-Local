/**
 * Tool Caller — Agentic pre-reply tool invocation
 *
 * Before generating reply suggestions, this module decides which plugins
 * (if any) would improve the quality of the response, calls them in parallel,
 * and returns a context string to inject into the AI prompt.
 *
 * Design goals:
 *   • Zero latency when no tools are needed (fast path)
 *   • Parallel execution (Promise.allSettled) — one slow tool never blocks
 *   • Graceful degradation — failed tool = skipped, not crashed
 *   • Human-readable output for both the AI prompt AND the dashboard
 *
 * Tool selection strategy:
 *   Local keyword rules decide which tools to call, keyed on the incoming
 *   message body. No LLM call required for tool selection — keeps it fast.
 *
 * Environment variables:
 *   TOOL_CALLING_ENABLED=true     — master switch (default: true)
 *   TOOL_CALLING_TIMEOUT_MS=5000  — max time to wait for all tools
 *   TOOL_CALLING_MAX=3            — max tools per message
 *
 * Adding a new trigger rule:
 *   Add an entry to TOOL_TRIGGERS below. Each rule has:
 *     match   — (body, contact) => boolean
 *     tools   — array of { name, input }
 *     label   — human-readable label shown in dashboard
 */

'use strict';

const plugins = require('../plugins');

// ── Config ────────────────────────────────────────────────────

const ENABLED     = process.env.TOOL_CALLING_ENABLED !== 'false';
const TIMEOUT_MS  = Number(process.env.TOOL_CALLING_TIMEOUT_MS || 5000);
const MAX_TOOLS   = Number(process.env.TOOL_CALLING_MAX        || 3);

// ── Trigger rules ─────────────────────────────────────────────
// Rules are checked in order; first MAX_TOOLS matches win.

const TOOL_TRIGGERS = [

  // ── Date / time awareness ───────────────────────────────────
  {
    label: 'datetime',
    match: (body) => /\b(today|tonight|tomorrow|this week|weekend|what time|right now|schedule|plan|kab|aaj|kal)\b/i.test(body),
    tools: [{ name: 'datetime', input: {} }],
  },

  // ── Arithmetic in message ───────────────────────────────────
  {
    label: 'calculator',
    match: (body) => /\d+\s*[+\-*/x÷]\s*\d/.test(body) || /\b(\d+)%\s*of\b/i.test(body),
    tools: [{ name: 'calculator', input: { expression: extractMath(body) } }],
  },

  // ── Explicit question asking for a fact ─────────────────────
  {
    label: 'web_search',
    match: (body) => (
      /\b(what is|who is|tell me about|do you know|search|look up|latest|news|kya hai)\b/i.test(body)
      && body.length > 20
    ),
    tools: [{ name: 'web_search', input: { query: extractSearchQuery(body) } }],
  },

  // ── Reminder / scheduling request ───────────────────────────
  {
    label: 'reminder',
    match: (body) => /\b(remind me|don.t forget|reminder|set alarm|remember to|yaad karna)\b/i.test(body),
    tools: [{ name: 'reminder', input: { text: body.slice(0, 150), when: 'unspecified' } }],
  },

];

// ── Helpers ───────────────────────────────────────────────────

function extractMath(body) {
  const m = body.match(/[\d+\-*/x÷().%\s]+(?:of\s+\d+)?/);
  return m ? m[0].replace(/x/g, '*').replace(/÷/g, '/').trim() : body;
}

function extractSearchQuery(body) {
  return body
    .replace(/^(what is|who is|tell me about|do you know|search for|look up)/i, '')
    .replace(/\?+$/, '')
    .trim()
    .slice(0, 80) || body.slice(0, 80);
}

// ── Runner ────────────────────────────────────────────────────

/**
 * @param {{ body: string, contact: object, incomingMessage: object }} ctx
 * @returns {Promise<ToolCallResult>}
 *
 * ToolCallResult: {
 *   called: boolean,
 *   tools: [{ name, label, input, result, summary, ok, durationMs }],
 *   contextBlock: string,   // ready to inject into AI prompt
 *   dashboardHtml: string,  // snippet for the suggestion card
 * }
 */
async function callTools({ body, contact, incomingMessage } = {}) {
  const empty = { called: false, tools: [], contextBlock: '', dashboardHtml: '' };
  if (!ENABLED || !body) return empty;

  // Resolve which tools to call (respect MAX_TOOLS cap)
  const selected = [];
  for (const rule of TOOL_TRIGGERS) {
    if (selected.length >= MAX_TOOLS) break;
    try {
      if (rule.match(body, contact)) {
        // Evaluate lazy input (some tool inputs reference `body` at call time)
        const tool = rule.tools[0];
        const input = typeof tool.input === 'function' ? tool.input(body) : tool.input;
        selected.push({ name: tool.name, label: rule.label, input });
      }
    } catch {
      // bad rule match — skip
    }
  }

  if (!selected.length) return empty;

  // Check all selected tools exist in the registry
  const runnable = selected.filter((t) => {
    const p = plugins.get(t.name);
    return p && p.enabled !== false;
  });

  if (!runnable.length) return empty;

  // Run all tools in parallel with a shared timeout
  const deadline = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Tool-calling timeout')), TIMEOUT_MS)
  );

  const calls = runnable.map(async (t) => {
    const start = Date.now();
    try {
      const res = await Promise.race([
        plugins.run(t.name, t.input),
        deadline,
      ]);
      return {
        name: t.name, label: t.label, input: t.input,
        result: res.result, summary: res.summary || '',
        ok: res.ok !== false, durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: t.name, label: t.label, input: t.input,
        result: null, summary: '', ok: false,
        error: err.message, durationMs: Date.now() - start,
      };
    }
  });

  const results = await Promise.allSettled(calls);
  const tools = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r) => r.ok && r.summary);

  if (!tools.length) return empty;

  // Build context block for the AI prompt
  const lines = tools.map((t) => `[Tool: ${t.label}] ${t.summary}`);
  const contextBlock = [
    '--- Tool results (use if relevant, ignore if not) ---',
    ...lines,
    '--- End tool results ---',
  ].join('\n');

  // Build a lightweight HTML snippet for the dashboard suggestion card
  const dashboardHtml = tools.map((t) =>
    `<span class="pill" title="${esc(t.name)}: ${esc(t.summary)}">🔧 ${esc(t.label)}: ${esc(t.summary.slice(0, 60))}</span>`
  ).join(' ');

  return { called: true, tools, contextBlock, dashboardHtml };
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { callTools };
