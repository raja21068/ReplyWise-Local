# ReplyWise v4 — Changelog & Improvement Guide

> Everything added relative to v3. Each section explains **what** changed, **where** the code lives, and **how to test** it.

---

## 1. WeChat Support  ★ HIGH PRIORITY

**File:** `src/bridge/wechat-agent.js`  
**Updated:** `src/bridge/agent-manager.js`, `src/db/index.js`, `.env.example`

### What was done
A full Playwright-based WeChat agent, following the exact same `BaseAgent` contract as the existing WhatsApp and Telegram agents.

| Feature | Detail |
|---|---|
| Login | QR code scan on `web.wechat.com` (first run only, session persists) |
| Message detection | DOM `MutationObserver` on the active chat panel + 2 s polling badge counter |
| Sending | Find contact by `data-id` → name search → search-box fallback |
| Deduplication | Per-contact last-message cache prevents double-ingest |
| Fallback URL | Set `WECHAT_USE_WX2=true` to use `wx2.qq.com` if primary blocks headless |

### How to enable
```env
# .env
ENABLED_AGENTS=whatsapp,telegram,wechat
# WECHAT_USE_WX2=false
```

### Known limitations
- WeChat Web shows a subset of contacts (no Mini Programs, no official accounts).
- Session expires if the phone app is inactive for ~24 h (same as WhatsApp Web).
- First login requires a non-headless browser window (`BROWSER_HEADLESS=false`).

---

## 2. Media Handling Pipeline  ★ HIGH PRIORITY

**Files:** `src/media/media-handler.js`, `src/bridge/whatsapp-agent.js` (v2)  
**Updated:** `src/brain/decision-engine.js`, `src/db/index.js`, `src/server.js`

### What was done

#### 2a. WhatsApp Agent v2 (`whatsapp-agent.js`)
- Detects media type for every incoming message: `image | audio | video | file | sticker | unknown`
- Builds a `media_summary` string from metadata (filename, caption, duration, MIME type) — **no download required**
- Optionally downloads bytes when `WHATSAPP_DOWNLOAD_MEDIA=true`
- Passes `media_type` + `media_summary` to `/api/ingest/whatsapp`

#### 2b. Media Handler (`src/media/media-handler.js`)
```
classifyAttachment(msg, options)  → { media_type, media_summary, risk_level, ocr_text }
assessRisk(mediaType, source, mime) → 'low' | 'medium' | 'high'
extractTextFromImage(buffer)       → string (via tesseract.js if installed)
summarizeForPrompt(meta)           → "[IMAGE risk=medium] — caption: …"
```

Risk matrix:
| Media type | From known | From unknown |
|---|---|---|
| sticker | low | low |
| audio | low | medium |
| image | medium | **high** |
| video | medium | **high** |
| file | medium | **high** |
| unknown | medium | **high** |
| Executables (.exe, .sh, .bat) | — | **always high** |

#### 2c. Decision Engine v2 (`decision-engine.js`)
- Accepts `media_type` and `media_summary` on `incomingMessage`
- Returns `context_summary` (one-line human-readable situation string)
- Returns `media_risk` — extra flag when unknown attachment is present
- Sticker-only and voice-note messages routed correctly (not treated as low-effort text)

#### 2d. DB (`db/index.js`)
- `messages` rows now carry `media_type` and `media_summary` fields
- `insertMessage()` accepts both fields

### How to enable OCR
```bash
npm i tesseract.js          # ~100 MB, English only by default
```
```env
WHATSAPP_DOWNLOAD_MEDIA=true
OCR_ENABLED=true
MEDIA_MAX_OCR_MB=2          # skip files larger than 2 MB
```

---

## 3. Claude AI Provider  ★ MEDIUM-HIGH

**File:** `src/ai/claude-client.js`  
**Updated:** `src/ai/index.js`

### What was done
A new `AI_PROVIDER=claude` mode that calls the Anthropic Messages API directly.

Cost controls built in:
- If local decision engine says **WAIT** or **NO**, the Claude API call is **skipped** (falls back to local rule engine) — unless `CLAUDE_FORCE=true`
- `max_tokens` capped at 900
- Short, focused prompt (recent messages + decision context only)

```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-4-5-20251001   # cheapest, fast
# CLAUDE_MODEL=claude-sonnet-4-6         # better quality
# CLAUDE_FORCE=false
```

AI provider routing summary:
| `AI_PROVIDER` | Where | Cost |
|---|---|---|
| `local` (default) | Rule engine, zero network | Free |
| `ollama` | Local LLM via Ollama | Free (GPU/CPU) |
| `claude` | Anthropic API | ~$0.001/msg on Haiku |

---

## 4. Plugin System  ★ MEDIUM-HIGH

**File:** `src/plugins/index.js`  
**Updated:** `src/server.js` (new `/api/plugins` routes)

### What was done
A lightweight synchronous plugin registry. Each plugin is a plain object with `{ name, description, enabled, async run(input) }`.

**Built-in plugins (zero config):**

| Plugin | What it does |
|---|---|
| `datetime` | Current date/time in `USER_TIMEZONE` |
| `calculator` | Safe math expression evaluator |
| `web_search` | DuckDuckGo Instant Answers (no API key) |
| `reminder` | In-memory reminder stub (extend for calendar) |

**API:**
```
GET  /api/plugins              → list all plugins + enabled status
POST /api/plugins/:name/run    → { ...input }  →  { ok, summary, result }
```

**Adding your own:**
```js
const plugins = require('./src/plugins');
plugins.register({
  name: 'my_tool',
  description: 'Does X',
  enabled: true,
  async run({ query }) {
    return { result: 'data', summary: 'short string for AI context' };
  },
});
```

**Disable a built-in:**
```env
PLUGIN_WEB_SEARCH=false
PLUGIN_REMINDER=false
```

---

## 5. Multi-Channel Architecture (unified)

**Files:** `src/bridge/agent-manager.js`, `src/db/index.js`

### What was done
- `agent-manager.js` now registers **3 channels**: `whatsapp`, `telegram`, `wechat`
- `db.assertSupportedChannel()` accepts `wechat` / `wx` / `weixin`
- `db.normalizeChannel()` maps all WeChat aliases to `'wechat'`
- Dashboard agent-status cards updated to show WeChat

The `BaseAgent` contract is unchanged — adding a 4th platform requires only creating a new file that extends `BaseAgent` and adding it to `AGENT_CLASSES` in `agent-manager.js`.

---

## 6. Safety & Guardrails (unchanged, verified)

**File:** `src/safety/guardrails.js`

No regressions. The media pipeline adds `media_risk` to the decision output but the existing `risk_level` field (which gates autopilot) is the primary control. High-risk media messages:
- Are never auto-sent
- Surface in the dashboard with a `⚠ high-risk media` badge (planned in dashboard v2)
- Always require human approval

---

## Roadmap — what's next

### Short-term (next sprint)
- [x] Dashboard v2: media type badge, memory indicator (🧠), tool result pills, context_summary on cards
- [x] Telegram agent: media type detection (mirrors WhatsApp v2)
- [ ] Dashboard plugin runner: call plugins directly from the UI

### Medium-term
- [x] RAG / conversation memory: TF-IDF + optional Ollama embeddings (`src/memory/index.js`)
- [x] Tool-calling before reply: agentic pre-reply pipeline (`src/ai/tool-caller.js`)
- [x] Telegram media parity: photo/audio/video/sticker/document detection mirrors WhatsApp v2
- [ ] Calendar plugin: real integration (Google Calendar via OAuth or local ICS)

### Long-term
- [ ] ACP protocol client: allow ReplyWise to act as a bridge agent for Claude Code or other ACP-compatible agents
- [ ] Electron/mobile dashboard: phone-first approval UI (React Native or Tauri)
- [ ] Privacy-first sync: encrypted store for multi-device access without a cloud backend

---

## Quick upgrade from v3

```bash
# 1. Copy your .env (most variables are compatible)
cp v3/.env .env

# 2. Add new variables
echo "ENABLED_AGENTS=whatsapp,telegram" >> .env
echo "WHATSAPP_DOWNLOAD_MEDIA=false"    >> .env
echo "PLUGIN_WEB_SEARCH=true"           >> .env

# 3. Install (no new required deps — all new features degrade gracefully)
npm install

# 4. Start as usual
npm run dev        # orchestrator
npm run agents     # browser agents (separate terminal)
```

**No database migration needed.** The JSON store automatically gains the new `media_type` / `media_summary` fields on the next write.

---

## 7. WeChat Agent v2 — Media Detection Parity  ★ HIGH PRIORITY

**File:** `src/bridge/wechat-agent.js`

### What was done

WeChat agent now detects and classifies media in incoming messages, matching the
feature parity already present in the WhatsApp and Telegram agents.

#### Architecture

Two parallel sets of helpers exist by design:

| Layer | Functions | Context |
|---|---|---|
| Browser (DOM) | `_wcResolveMediaType(node)`, `_wcBuildMediaSummary(node, type)` | Runs inside `page.evaluate()` — has access to live `HTMLElement` nodes |
| Node.js (module) | `resolveWeChatMediaType(msgData)`, `buildWeChatMediaSummary(msgData, type)` | Runs in `onIncomingMessage()` — normalises/validates the serialised object from `__rosOnMessage` |

#### Media types detected

| Type | DOM indicators |
|---|---|
| `sticker` | `[class*="sticker"]`, `[class*="emoji_type"]`, `[class*="msgEmoji"]`, `img[class*="emoji"]` |
| `image` | `.img`, `.message-img`, `img.msg-img`, `.msg_thumb`, `.msg-image`, `[class*="msgImg"]`, `picture` |
| `audio` | `[class*="voice"]`, `[class*="audio"]`, `.J_VoiceBtn`, `[class*="voice_msg"]`, `audio`, `[class*="icon_voice"]` |
| `video` | `[class*="video"]`, `[class*="msg_video"]`, `video`, `[class*="play_btn"]` |
| `file` | `[class*="file"]`, `[class*="attach"]`, `[class*="doc_icon"]`, `[class*="msg_file"]` |
| `unknown` | Non-text bubble with child elements but no matched class |
| `text` | Default — no media indicators found |

**Note:** Sticker is checked before image intentionally — WeChat renders stickers as
`<img>` tags, so the sticker guard must run first or stickers fall through as images.

#### Summary extraction (`_wcBuildMediaSummary`)

| Type | Extracted metadata |
|---|---|
| `image` | Caption text (`.img_caption`), `<img alt>` |
| `audio` | Duration (`[class*="voice_time"]`, `[class*="duration"]`) |
| `video` | Duration (`[class*="video_time"]`, `[class*="duration"]`) |
| `file` | File name (`.file-name`, `[class*="fileName"]`), file size (`[class*="fileSize"]`) |
| `sticker` | Static label `"sticker"` |

All lookups have multi-class fallbacks so detection degrades gracefully when
WeChat Web's DOM structure changes between releases.

#### Body fallback

Media-only messages (voice note, sticker, image with no caption) previously
returned an empty body and were silently dropped by `BaseAgent.onIncomingMessage`.
Now `extractMessage()` sets `body = "[audio]"` / `"[image]"` / etc., matching the
WhatsApp pattern and ensuring the Decision Engine always receives the message.

#### `onIncomingMessage` override

Overrides `BaseAgent.onIncomingMessage` to destructure `media_type` and
`media_summary` from the incoming data, run them through the Node.js helpers,
and POST the full enriched payload to `/api/ingest/wechat` — identical field
names to WhatsApp and Telegram.

### Ingest payload shape (v2)

```json
{
  "from": "wc_...",
  "externalContactId": "wc_...",
  "displayName": "Contact Name",
  "body": "[image]",
  "timestamp": "2026-05-27T...",
  "media_type": "image",
  "media_summary": "caption: \"check this out\""
}
```

### No breaking changes

All existing text detection, deduplication, login flow, and `sendMessageViaUI`
are unchanged. The `media_type` field defaults to `"text"` for all plain text
messages, so downstream handlers that don't yet read the field are unaffected.

---

# ReplyWise v6 — Realtime, Learning, Scheduled Sends

> v6 builds on v5 (WeChat media polish) and addresses the four biggest gaps
> identified in the engineering audit: stale dashboard, wasted feedback signal,
> orphaned "wait" advice, and missing response-cadence intelligence.

## 8. Realtime Dashboard via SSE  ★ HIGH PRIORITY

**Files:** `src/realtime/event-bus.js` (new), `src/server.js`

### Problem
Dashboard reloaded every 20s. A new suggestion could sit invisible for up to
20 seconds before the user saw it.

### What was done
- `src/realtime/event-bus.js` — singleton `EventEmitter` + Express SSE handler
- `GET /api/events/stream` — long-lived SSE connection with hello frame,
  25 s keep-alive pings, and proxy-safe headers (`X-Accel-Buffering: no`)
- Dashboard `<script>` replaces `setTimeout(reload, 20000)` with an
  `EventSource` that listens for typed events

### Events emitted
| Event | When |
|---|---|
| `suggestion.created` | New suggestion ready for review |
| `suggestion.approved` | User picked an option / sent custom reply |
| `suggestion.skipped` | User clicked Wait or Skip |
| `agent.status` | Bridge agent status changed (login required, connected, etc.) |
| `schedule.created` | A deferred send was queued |
| `schedule.fired` | A scheduled send just dispatched |
| `schedule.cancelled` | A scheduled send was cancelled |

### Dashboard UI
A live indicator next to "Pending Decisions": `🟢 live` / `🔴 disconnected — retrying`.
EventSource auto-reconnects; a 60s hard-reload fallback handles stuck proxies.

---

## 9. Feedback Loop / Preference Learner  ★ HIGH PRIORITY

**File:** `src/learning/preference-learner.js` (new)

### Problem
Every approval wrote `chosen_text` to the DB and `feedback_events` was an empty
array that was never written to. The user's tone preferences were being thrown
away.

### What was done
Three connected pieces:

1. **`recordFeedback(db, ...)`** — writes one row to `feedback_events` per approval,
   capturing chosen tone (+2), skipped tones (-1 each), reply length, and whether
   it was a custom-written reply
2. **`getPreferenceProfile(db, contactId)`** — aggregates last 30 events per contact,
   computes `topTones`, `avoidTones`, `avgChosenLen`, `customRate`, and builds a
   text prompt block (cached 60 s per contact)
3. **`reorderOptionsByPreference(options, profile)`** — after the AI returns options,
   boosts scores of preferred tones (+8) and demotes avoided ones (-12), re-sorts

### Wired into
- `/api/suggestions/:id/approve` — records feedback on every approval
- `/api/suggestions/:id/approve-and-schedule` — same
- `processIncomingMessage()` — pulls profile, injects `preferenceBlock`
  into the AI prompt, then reorders options by preference before persisting

### Dashboard
Suggestion cards with applied preferences show a `🎯 learned` badge and a
small caption: "Learned preferences applied (12 samples): prefers casual, warm,
avoids playful."

---

## 10. Scheduled Sends  ★ HIGH PRIORITY

**File:** `src/schedule/scheduler.js` (new)

### Problem
Decision engine said "wait 30 minutes" but there was no way to actually queue
that reply. User either ignored the advice or set a phone timer.

### What was done
A "delayed flip" scheduler that doesn't touch the agent send-path:

1. User approves a reply and picks delay (15 m / 30 m / 1 h / 3 h / 12 h)
2. `POST /api/outgoing/:queueId/schedule` writes `scheduled_at` and flips
   status to `'scheduled'` — agents skip these
3. Every 30 s, scheduler scans for `scheduled_at <= now()` and flips status
   back to `'queued'` — existing agent polling picks them up normally

### Routes
- `POST /api/outgoing/:queueId/schedule {minutes}` — defer existing queue item
- `POST /api/outgoing/:queueId/cancel-schedule` — abort before it fires
- `GET /api/schedule/list` — pending scheduled items (sorted by next-to-fire)
- `POST /api/suggestions/:id/approve-and-schedule {chosenText, minutes}` —
  one-step approve+schedule for the per-option `⏰ Schedule` button

### Dashboard
- New `⏰ Scheduled Sends` section with live count, body preview, scheduled
  time, and Cancel button per row
- Per-option `⏰ Schedule` dropdown on every reply suggestion
- Live updates via SSE when items fire (`schedule.fired` event)

### Env vars
```
SCHEDULER_ENABLED=true
SCHEDULER_TICK_MS=30000
SCHEDULER_MAX_DELAY_HOURS=24
```

---

## 11. Response Cadence + Momentum (Stats Engine v3)  ★ MEDIUM-HIGH

**File:** `src/brain/stats-engine.js`

### Problem
The warmth score was 50 ± keyword count. It didn't know whether they replied
in 3 minutes or 3 hours, or whether the conversation was growing or dying.
Timestamps were already in the DB, just unused.

### What was done

**`computeResponseCadence(messages)`** walks the history and computes:
- `theirAvgMin` — avg minutes between *your* outgoing and *their* reply
- `yourAvgMin` — avg minutes between *their* incoming and *your* reply
- `ratio` — `yourAvgMin / theirAvgMin` (>1 = you reply slower than them)
- `trend` — comparing last 4 gaps to prior 4: `speeding_up` / `slowing_down` / `stable`

**`computeMomentum(messages)`** compares message volume:
- `last24h` vs `prior24h` counts
- `score` — normalised diff (−100 to +100)
- `label` — `growing` / `steady` / `cooling` / `dying` / `dormant`

**`computeWarmthScore()`** now uses these:
- Fast replies (<5 min avg) → +15 warmth
- Slow replies (>3 h avg) → −8 warmth
- `trend = speeding_up` → +10
- `trend = slowing_down` → −10
- `label = growing` → +8, `cooling` → −8, `dying` → −15

### Dashboard
Suggestion cards show a new cadence pill row: `Their avg reply: 4m`,
`Your avg reply: 12m`, `↘ replying slower`, `📈 growing`.

### Prompt injection
All three AI clients (Claude, Ollama, OpenAI-compat) now include cadence stats
in their prompts:
```
- theirAvgResponseMin: 4
- yourAvgResponseMin: 12
- responseTimeRatio: 3.0
- cadenceTrend: slowing_down
- momentumLabel: cooling
```

---

## 12. Expanded Guardrails  ★ MEDIUM

**File:** `src/safety/guardrails.js`

### Problem
13 hardcoded phrases. Missed most real manipulation patterns.

### What was done
- **Phrase list: 13 → ~70 substrings** across 7 categories: manipulation,
  guilt-tripping, possessiveness, sexual coercion, secrecy, stalking,
  threats, isolation
- **NEW: 9 regex patterns** for variations the substring list misses:
  ```
  /if you (really|truly|actually) (loved|cared|liked|valued)/
  /you (always|never) (listen|reply|answer|respond|care|understand|ignore|...)/
  /(prove|show) (me )?(your|you) love/
  /nobody (has to|needs to|will) know/
  /you (are|'re) (mine|my property|nothing without)/
  ...
  ```

### Smoke test results
- "send me pics" → blocked (substring)
- "if you really loved me" → blocked (regex)
- "you always ignore me" → blocked (regex)
- "nobody has to know" → blocked (substring)
- "hey hows your day going" → safe ✓

---

## Roadmap — what's still open

### Worth building next
- [ ] Voice transcription via Whisper/Ollama — turn `[audio]` into real text
- [ ] Group chat mode in decision engine — `is_group` is passed but ignored
- [ ] Per-contact custom persona — currently only one global persona

### Skip (low ROI)
- [ ] ACP protocol client — impressive but no clear payoff for a solo user
- [ ] Electron desktop wrapper — web dashboard is fine
- [ ] pgvector / sqlite-vec — TF-IDF is good enough at chat-history scale

---

## Quick upgrade from v5

```bash
cp v5/.env .env                     # all existing vars compatible
npm install                          # no new required deps
npm run dev && npm run agents        # SSE auto-activates, scheduler starts
```

No database migration. `feedback_events` and `scheduled_at` are added
automatically on the next write.
