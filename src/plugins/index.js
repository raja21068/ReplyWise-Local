/**
 * Plugin Registry — Lightweight tool-plugin system for ReplyWise.
 *
 * A plugin is a plain object with:
 *   name        {string}   — unique identifier, e.g. 'web_search'
 *   description {string}   — shown in the dashboard
 *   enabled     {boolean}  — can be toggled via .env or API
 *   run(input)  {async fn} — executes the tool, returns { result, summary }
 *
 * Built-in plugins (loaded automatically if their env vars are set):
 *   web_search   — DuckDuckGo instant answers (no API key)
 *   datetime     — current date/time in user's timezone
 *   calculator   — safe math expression evaluator
 *
 * Usage from the AI pipeline:
 *   const registry = require('./plugins');
 *   const result = await registry.run('web_search', { query: 'weather Tokyo' });
 *
 * Adding your own plugin:
 *   registry.register({
 *     name: 'my_tool',
 *     description: 'Does something useful',
 *     enabled: true,
 *     async run({ input }) { return { result: '...', summary: '...' }; },
 *   });
 */

'use strict';

const axios = require('axios');

// ── Registry store ────────────────────────────────────────────

const _plugins = new Map();

function register(plugin) {
  if (!plugin || !plugin.name || typeof plugin.run !== 'function') {
    throw new Error('Plugin must have { name, run() }');
  }
  _plugins.set(plugin.name, plugin);
}

function unregister(name) {
  _plugins.delete(name);
}

function list() {
  return [..._plugins.values()].map(({ name, description, enabled }) => ({
    name, description: description || '', enabled: enabled !== false,
  }));
}

function get(name) {
  return _plugins.get(name) || null;
}

async function run(name, input = {}) {
  const plugin = _plugins.get(name);
  if (!plugin) throw new Error(`Plugin "${name}" not found`);
  if (plugin.enabled === false) throw new Error(`Plugin "${name}" is disabled`);
  try {
    const result = await plugin.run(input);
    return { ok: true, plugin: name, ...result };
  } catch (err) {
    return { ok: false, plugin: name, error: err.message, summary: null };
  }
}

// ── Built-in: datetime ────────────────────────────────────────

register({
  name: 'datetime',
  description: 'Returns the current date and time. Useful for scheduling context.',
  enabled: true,
  async run({ timezone } = {}) {
    const tz   = timezone || process.env.USER_TIMEZONE || 'Asia/Karachi';
    const now  = new Date();
    const opts = { timeZone: tz, dateStyle: 'full', timeStyle: 'short' };
    let formatted;
    try {
      formatted = new Intl.DateTimeFormat('en-US', opts).format(now);
    } catch {
      formatted = now.toUTCString();
    }
    return {
      result: { iso: now.toISOString(), formatted, timezone: tz },
      summary: `Current time: ${formatted}`,
    };
  },
});

// ── Built-in: calculator ──────────────────────────────────────

register({
  name: 'calculator',
  description: 'Evaluates a safe math expression. E.g. "2 + 2", "sqrt(144)", "15% of 3500".',
  enabled: true,
  async run({ expression }) {
    if (!expression) return { result: null, summary: 'No expression provided.' };
    // Safe evaluation — only allow numbers, operators, and common functions
    const safe = String(expression)
      .replace(/[^0-9+\-*/().%, sqrt\s]/gi, '')
      .replace(/sqrt\s*\(/g, 'Math.sqrt(')
      .replace(/(\d+)%\s*of\s*(\d+)/gi, '($1/100)*$2');
    let value;
    try {
      // eslint-disable-next-line no-new-func
      value = Function('"use strict"; return (' + safe + ')')();
    } catch {
      return { result: null, summary: `Could not evaluate: ${expression}` };
    }
    return {
      result: { expression, value },
      summary: `${expression} = ${value}`,
    };
  },
});

// ── Built-in: web_search (DuckDuckGo Instant Answers) ────────

register({
  name: 'web_search',
  description: 'Searches DuckDuckGo Instant Answers API (no key required). Good for facts/news.',
  enabled: process.env.PLUGIN_WEB_SEARCH !== 'false',
  async run({ query }) {
    if (!query) return { result: null, summary: 'No query provided.' };
    const url = 'https://api.duckduckgo.com/';
    const res = await axios.get(url, {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 8000,
    });
    const data = res.data;
    const answer   = data.AbstractText || data.Answer || null;
    const source   = data.AbstractSource || data.AnswerType || null;
    const related  = (data.RelatedTopics || [])
      .slice(0, 3)
      .map((t) => t.Text || '')
      .filter(Boolean);

    if (!answer && !related.length) {
      return { result: null, summary: `No instant answer found for: "${query}"` };
    }

    const summary = answer
      ? `${answer.slice(0, 200)}${source ? ` (${source})` : ''}`
      : related[0].slice(0, 200);

    return { result: { answer, source, related }, summary };
  },
});

// ── Built-in: reminder stub (extendable) ─────────────────────

register({
  name: 'reminder',
  description: 'Creates a simple in-memory reminder (logs to console). Extend with a real calendar integration.',
  enabled: process.env.PLUGIN_REMINDER !== 'false',
  _reminders: [],
  async run({ text, when, for: forContact }) {
    if (!text) return { result: null, summary: 'No reminder text provided.' };
    const reminder = {
      id: Date.now(),
      text: String(text).slice(0, 200),
      when: when || 'unspecified',
      for: forContact || 'general',
      created: new Date().toISOString(),
    };
    // In a real implementation, persist to DB or push to a calendar API.
    this._reminders.push(reminder);
    console.log(`[reminder plugin] Set: "${reminder.text}" for ${reminder.for} at ${reminder.when}`);
    return {
      result: reminder,
      summary: `Reminder set: "${reminder.text}" ${reminder.when !== 'unspecified' ? `at ${reminder.when}` : ''}`,
    };
  },
});

// ── Export ────────────────────────────────────────────────────

module.exports = { register, unregister, list, get, run };
