# ReplyWise Local

<p align="center">
  <img src="images/1.png" alt="ReplyWise Local hero preview" width="100%">
</p>

<h3 align="center">A local-first WhatsApp CRM dashboard with safe Nano Bots, manual approval, and per-contact AI memory.</h3>

<p align="center">
  <strong>ReplyWise helps you decide whether to reply, what to reply, when to reply, and whether it is safe to send.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v7.3_dashboard_safe-blue">
  <img alt="Mode" src="https://img.shields.io/badge/mode-local--first-green">
  <img alt="Dashboard" src="https://img.shields.io/badge/dashboard-real--time-purple">
  <img alt="Manual Approval" src="https://img.shields.io/badge/manual_approval-default-important">
  <img alt="AI" src="https://img.shields.io/badge/AI-easy%20%2B%20local%20fallback-lightgrey">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-black">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#dashboard-system">Dashboard System</a> ·
  <a href="#nano-bots-architecture">Nano Bots</a> ·
  <a href="#safety-first-rules">Safety</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## What is ReplyWise?

ReplyWise Local is a **local-first AI communication assistant** for WhatsApp browser sessions, with optional Telegram and experimental WeChat support.

It is not just a chatbot that writes replies. It is designed as a **CRM-style control center** for personal or business messaging:

- Incoming chat inbox
- Per-contact memory
- AI reply suggestions
- Manual approval queue
- Auto-reply rules
- Smart routing
- Scheduled sends
- Logs and error monitor
- AI usage/cost visibility
- Safety guardrails before anything is sent

The main question ReplyWise answers is:

> **“Should I reply, and is it safe to send this reply to this exact contact?”**

---

## Why ReplyWise?

Most AI reply tools only answer:

> “What should I reply?”

ReplyWise answers the more important questions first:

```txt
Should I reply?
Should I wait?
Should this be manual approval?
Is this a group message?
Is the contact blocked?
Is the AI mixing up contacts?
Is the reply safe to send?
```

It analyzes timing, tone, emotional state, urgency, lead quality, group context, boundaries, and per-contact memory before suggesting or sending anything.

<p align="center">
  <img src="images/2.png" alt="ReplyWise Local dashboard preview" width="100%">
</p>

---

## Dashboard System

ReplyWise is designed to feel like an operational dashboard, not only a terminal bot.

### Chat Views

| Section | Purpose |
|---|---|
| **All Chats** | Every private and group conversation |
| **Unread** | Chats that need attention |
| **Groups** | Group conversations with stricter rules |
| **Mentions** | Group messages that directly mention you |
| **Starred** | Important contacts or conversations |
| **Blocked** | Contacts where automation must not reply |

### Automation

| Section | Purpose |
|---|---|
| **AI Agents** | Shows WhatsApp/Telegram/WeChat agent health |
| **Auto Reply Rules** | Per-contact and global auto-reply controls |
| **Smart Routing** | Routes leads, support, personal, group, spam, or unknown messages |
| **Scheduled** | Delayed replies waiting to be sent |
| **Manual Approval** | Drafts that need human review before sending |

### Intelligence

| Section | Purpose |
|---|---|
| **Leads** | Lead score, stage, urgency, and intent |
| **Analytics** | Message volume, reply rate, confidence, errors, usage |
| **Contact Memory** | Style, language, tone, boundaries, and notes per contact |

### System

| Section | Purpose |
|---|---|
| **Settings** | AI provider, auto-send, fallback, session, and privacy settings |
| **Logs** | Real system events, AI failures, safety blocks, and send status |
| **Billing & Usage** | Local AI/cloud usage counters and estimated cost, not payment billing |

---

## Core Product Idea

ReplyWise is built around one powerful idea:

> **Different contact = different memory = different reply style.**

The same message can produce different replies depending on who sent it.

| Contact | Style Memory | Example Reply Style |
|---|---|---|
| Ayesha | Roman Urdu, playful, light emojis | “Weekend ka plan abhi pending hai 😂 tumhara?” |
| Sara | Mature English, low emojis | “Nothing fixed yet. Probably a quiet weekend. What about you?” |
| Hina | Short, direct, busy | “Nothing fixed yet. You?” |
| Noor | Sarcastic, meme energy | “Survive, eat, repeat. Very ambitious plan 😂” |

This makes ReplyWise feel like a **personal communication brain**, not a generic chatbot.

---

## Nano Bots Architecture

ReplyWise should not let one big AI directly read a message and send a reply.

Instead, the system uses small **Nano Bots**. Each bot has one job, and only the Sender Bot can send messages.

```txt
WhatsApp Message
   ↓
Receiver Bot
   ↓
Identity Bot
   ↓
Triage Bot
   ↓
Memory Bot
   ↓
Reply Bot
   ↓
Safety Bot
   ↓
Approval Bot
   ↓
Sender Bot
```

### Bot Responsibilities

| Bot | Responsibility | Can Send? |
|---|---|---|
| **Receiver Bot** | Receives message and stores chatId, messageId, sender, text, timestamp | No |
| **Identity Bot** | Detects private/group chat, blocked status, mention status, known contact | No |
| **Triage Bot** | Classifies intent: greeting, lead, support, complaint, spam, personal, unknown | No |
| **Memory Bot** | Loads memory only for the same `chatId` | No |
| **Reply Bot** | Generates a suggested reply | No |
| **Safety Bot** | Blocks unsafe, wrong-contact, rude, risky, or group-misbehaviour replies | No |
| **Approval Bot** | Decides auto-send vs manual approval | No |
| **Sender Bot** | Sends only after all checks pass | **Yes** |

### Critical Safety Rule

Every message must carry its own isolated context:

```json
{
  "messageId": "wa_msg_123",
  "chatId": "9198xxxxxx@c.us",
  "contactName": "Raja",
  "channel": "whatsapp",
  "text": "Hi",
  "receivedAt": "2026-05-28T18:00:00.000Z"
}
```

Before sending, the Sender Bot must verify:

```txt
same chatId
same messageId or linked source message
single recipient only
contact is not blocked
reply is not empty
reply passed safety
reply was not already sent
```

This prevents dangerous bugs like:

```txt
one reply sent to all contacts
reply sent to wrong contact
same reply sent twice
AI mixing memory between contacts
group auto-reply without mention
```

---

## Features

<table>
<tr>
<td width="50%">

### 🧠 Should-I-Reply Engine

Every incoming message gets a structured decision:

```json
{
  "decision": "reply_now | wait | no_reply | repair | end",
  "confidence": 87,
  "risk": "low | medium | high",
  "reason": "They asked a warm open-ended question.",
  "best_move": "Answer lightly and ask back.",
  "avoid": "Do not over-flirt or write a long reply."
}
```

</td>
<td width="50%">

### 🎭 Per-Contact Style Memory

ReplyWise remembers:

- Preferred language
- Emoji style
- Conversation stage
- Inside jokes
- Boundaries
- Reply length preference
- Custom persona per contact

</td>
</tr>
<tr>
<td width="50%">

### 🎙 Voice Note Transcription

Voice messages can be transcribed before the reply pipeline runs.

Supported options:

- Local `whisper.cpp`
- Local Python Whisper / Faster Whisper
- Local HTTP transcription service
- Custom transcription command

</td>
<td width="50%">

### 👥 Group Chat Mode

Group messages use stricter rules:

- Do not reply to every group message
- Reply only when directly mentioned or clearly relevant
- Keep replies shorter
- Never use flirty/romantic tone in groups
- Avoid bot-like behavior

</td>
</tr>
<tr>
<td width="50%">

### ⚡ Easy AI Mode

No Ollama required.

ReplyWise can use:

- Gemini
- OpenRouter
- Groq
- Local fallback

If an API limit or provider error happens, it falls back safely.

</td>
<td width="50%">

### 🛡 Human-in-the-Loop Safety

By default:

- No auto-send
- No hidden sending
- No screenshot/OCR reading loop
- No spam behavior
- No reply after clear boundary/rejection
- Manual approval before sending

</td>
</tr>
</table>

---

## Supported Channels

| Channel | Mode | Status |
|---|---|---|
| WhatsApp | `whatsapp-web.js` browser session | Primary MVP channel |
| Telegram | Playwright browser session | Secondary MVP channel |
| WeChat | Playwright browser session / WeChat Web | Experimental |

> WeChat support is included, but treat it as experimental until tested with your own WeChat Web session.

---

## System Architecture

<p align="center">
  <img src="images/3.png" alt="Per-contact reply intelligence system diagram" width="100%">
</p>

```txt
WhatsApp / Telegram / WeChat Web
        ↓
Browser Agent
        ↓
Incoming Message Ingest API
        ↓
Per-Contact Queue + Duplicate Guard
        ↓
Nano Bot Pipeline
        ↓
Should-I-Reply Decision
        ↓
Per-Contact Memory + Custom Persona
        ↓
Reply Generator
        ↓
Safety / Group Rules / Sender Guard
        ↓
Manual Approval Dashboard
        ↓
Outgoing Queue
        ↓
Browser Agent Claims One Pending Message
        ↓
Browser Agent Sends Through Web UI
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/raja21068/ReplyWise-Local.git
cd ReplyWise-Local
npm install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Recommended safe first-run `.env`:

```env
PORT=3000
APP_BASE_URL=http://localhost:3000

AI_PROVIDER=local
AI_PROVIDER_CHAIN=local
ALLOW_AUTOSEND=false
DRY_RUN_SEND=true

ENABLED_AGENTS=whatsapp
BROWSER_HEADLESS=false
SESSION_DIR=./data/sessions

SCREENSHOT_ON_ERROR=false
LIVE_SCREENSHOT=false
OCR_ENABLED=false
```

### 3. Start the dashboard

```bash
npm run dev
```

Open:

```txt
http://localhost:3000
```

### 4. Start WhatsApp agent

```bash
npm run agent:whatsapp
```

Scan the WhatsApp Web QR code, then test with one trusted contact first.

---

## Safe Test Flow

Use this before real auto-send:

```txt
1. Start dashboard with AI_PROVIDER=local and DRY_RUN_SEND=true
2. Start WhatsApp agent
3. Send one message from a trusted test contact
4. Confirm the message appears in All Chats
5. Confirm the Nano Bot pipeline creates a decision
6. Confirm the reply appears in Manual Approval
7. Approve/edit the reply
8. Confirm outgoing queue changes pending → sending → sent or dry-run sent
9. Send 3 quick messages from the same contact
10. Confirm they process one-by-one and do not get stuck
```

Success means:

- Incoming message detected
- Contact isolated by `chatId`
- Decision created
- Reply suggestion shown
- Manual approval required by default
- Outgoing message queued once
- Browser agent sends only one claimed message
- No reply is sent to the wrong contact

---

## Easy AI Mode

For cloud AI with local fallback:

```env
AI_PROVIDER=easy
AI_PROVIDER_CHAIN=gemini,openrouter,groq,local

GEMINI_API_KEY=
OPENROUTER_API_KEY=
GROQ_API_KEY=

MAX_CLOUD_CALLS_PER_DAY=200
DAILY_AI_BUDGET_USD=1.00
FALLBACK_TO_LOCAL_ON_LIMIT=true
ALLOW_AUTOSEND=false
DRY_RUN_SEND=true
```

Fallback flow:

```txt
Try Gemini
  ↓ if no key / rate limit / error
Try OpenRouter
  ↓ if no key / rate limit / error
Try Groq
  ↓ if no key / rate limit / error
Use local safe fallback
```

This is **provider fallback**, not quota abuse or key rotation.

---

## Local-Only Mode

ReplyWise can run without any cloud API key:

```env
AI_PROVIDER=local
AI_PROVIDER_CHAIN=local
ALLOW_AUTOSEND=false
DRY_RUN_SEND=true
```

Local mode still supports:

- Should-I-reply decisions
- Basic reply templates
- Energy matching
- Group rules
- Anti-cringe checks
- Manual approval dashboard
- Error and queue visibility

---

## Group Chat Logic

Group chats are not treated like private chats.

| Situation | Decision |
|---|---|
| Random group message, no mention | Usually no reply |
| Direct @mention | Short neutral reply allowed |
| Question to everyone | Optional short reply or manual approval |
| Flirty context in group | Block/avoid |
| Conflict in group | Calm repair or no reply |
| Unknown media/file in group | Review manually |

Recommended group rule:

```txt
If group message does not mention you and is not a direct reply to you, do not auto-send.
```

---

## Per-Contact Custom Persona

Each contact can override the global persona.

Example:

```txt
Ayesha:
Reply in playful Roman Urdu, short messages, light emojis.
Do not over-flirt. Do not pressure during exams.
```

This lets ReplyWise adapt to different people naturally.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Dashboard/API port |
| `APP_BASE_URL` | `http://localhost:3000` | Orchestrator URL used by agents |
| `AI_PROVIDER` | `easy` | `easy`, `local`, `gemini`, `openrouter`, `groq`, or optional `ollama` |
| `AI_PROVIDER_CHAIN` | `gemini,openrouter,groq,local` | Provider fallback order |
| `GEMINI_API_KEY` | empty | Optional Gemini key |
| `OPENROUTER_API_KEY` | empty | Optional OpenRouter key |
| `GROQ_API_KEY` | empty | Optional Groq key |
| `MAX_CLOUD_CALLS_PER_DAY` | `200` | Daily cap for cloud AI calls |
| `DAILY_AI_BUDGET_USD` | `1.00` | Soft budget shown in dashboard/status |
| `FALLBACK_TO_LOCAL_ON_LIMIT` | `true` | Use local fallback on API limit/error |
| `ALLOW_AUTOSEND` | `false` | Keep false unless intentionally enabling safe autopilot |
| `DRY_RUN_SEND` | `true` | Recommended for first tests; simulates send without real delivery |
| `ENABLED_AGENTS` | `whatsapp` | Example: `whatsapp,telegram,wechat` |
| `BROWSER_HEADLESS` | `false` | Set true after login is stable |
| `SESSION_DIR` | `./data/sessions` | Persistent browser session folder |
| `SCREENSHOT_ON_ERROR` | `false` | Emergency debugging only |
| `LIVE_SCREENSHOT` | `false` | Keep off in free-cost mode |
| `OCR_ENABLED` | `false` | Keep off; not needed for normal reading |
| `TRANSCRIBE_ENABLED` | `false` | Enable local voice transcription |
| `TRANSCRIBE_BACKEND` | `auto` | `auto`, `whisper_cpp`, `python_whisper`, `http`, or `command` |
| `TRANSCRIBE_COMMAND` | empty | Custom transcription command |
| `TRANSCRIBE_HTTP_URL` | empty | Local transcription server URL |
| `BRIDGE_POLL_MS` | `5000` | Outgoing queue polling interval |
| `HEALTH_CHECK_INTERVAL` | `60` | Agent health interval in seconds |

---

## API Shape

The dashboard should be powered by real backend state, not static demo data.

Recommended API surface:

```txt
GET  /api/state
GET  /api/conversations
GET  /api/messages/:contactId
GET  /api/agents
GET  /api/logs
GET  /api/errors
GET  /api/outgoing
POST /api/ingest
POST /api/reply/approve
POST /api/reply/skip
POST /api/contact/:id/autopilot
POST /api/contact/:id/block
POST /api/outgoing/claim
POST /api/outgoing/:id/sent
POST /api/outgoing/:id/failed
```

---

## Example Decision Card

```txt
Ayesha · WhatsApp

"So what's your weekend plan?"

Decision:
✅ Reply now

Why:
She asked an open question and the tone is warm.

Best move:
Keep it light and ask back.

Avoid:
Do not over-flirt or write a long message.

Option 1:
"Nothing fixed yet, maybe food and rest. Tumhara kya scene hai?"

Option 2:
"Plan toh pending hai, agar koi acha idea mil gaya toh weekend bach jayega 😂"

Option 3:
"Weekend depends on company tbh 😄 tumhara kya plan?"

[Send] [Edit] [Wait] [Skip]
```

---

## Development Scripts

```bash
npm run setup
npm run dev
npm run reset
npm run seed
npm run agents
npm run agent:whatsapp
npm run agent:telegram
npm run agent:wechat
npm run agent:all
npm run syntax
npm run style-test
npm run v7-test
npm run easy-test
npm test
```

---

## Verification Checklist

```txt
✅ Dashboard opens at http://localhost:3000
✅ All Chats, Unread, Groups, Mentions, Starred, Blocked sections appear
✅ AI Agents, Auto Reply Rules, Smart Routing, Scheduled, Manual Approval sections appear
✅ Leads, Analytics, Contact Memory sections appear
✅ Settings, Logs, Billing & Usage sections appear
✅ Incoming WhatsApp message creates exactly one stored message
✅ Same contact sending 3 quick messages does not stuck the system
✅ Outgoing queue uses pending → sending → sent / failed
✅ Same outgoing message cannot be claimed twice
✅ Sender Guard blocks missing or multi-recipient destination
✅ Group message without mention gives no-reply decision
✅ Direct group mention gives short neutral reply or manual approval
✅ Contact custom persona overrides global persona
✅ API provider error falls back to local safe mode
✅ AI error appears in dashboard Logs
✅ Audio-only message does not crash ingest pipeline
```

---

## Troubleshooting

### Problem: terminal shows `decision: [object Object]`

The decision object is being logged without formatting.

Expected readable log:

```txt
Processed — decision: reply_now 87% risk:low — They asked a warm question.
```

### Problem: second message gets stuck

Use a per-contact queue and process by `chatId`:

```txt
Raja queue: msg1 → msg2 → msg3
Amit queue: msg1 → msg2
```

Never use a global `currentChat`, `lastChatId`, or `lastReply` for sending.

### Problem: one reply sent to all

This is usually a shared-state or outgoing-claim bug.

Required protections:

```txt
one outgoing row per reply
single recipient only
claim pending message before sending
change pending → sending before delivery
Sender Bot checks original chatId
block if destination has multiple recipients
block if contact is blocked
```

### Problem: cloud AI returns HTTP 400

Switch to local mode first:

```bash
AI_PROVIDER=local DRY_RUN_SEND=true npm run dev
```

Then check Logs in the dashboard before enabling cloud providers again.

---

## Safety First Rules

ReplyWise is a human-in-the-loop communication assistant.

Do not use it for:

- Spam
- Harassment
- Manipulation
- Impersonation
- Fully autonomous messaging without review
- Bypassing platform enforcement
- Sending messages without user intent

Hard rules:

```txt
No auto-send by default.
No stealth/bypass logic.
No screenshot reading loop.
No OCR-based message reading.
No global currentChat/currentReply for sending.
No multi-recipient sends from one AI reply.
No reply after clear rejection or boundary.
No flirty or romantic replies in group chats.
No blind replies to audio/video/file messages without enough context.
Stop cloud AI calls when daily limit is reached.
Fallback to local safe mode when API providers fail.
```

---

## Platform Risk Notice

Browser automation may violate the terms of service of some platforms. Sessions can break, selectors can change, and accounts may face restrictions.

Use this project for personal experimentation and local prototyping only. Prefer read-only or manual-approval mode during testing. Use a secondary account where appropriate.

---

## Roadmap

| Version | Focus |
|---|---|
| v0.1 | WhatsApp proof, dashboard, local decision engine |
| v0.2 | Telegram support |
| v0.2.5 | Experimental WeChat |
| v0.3 | Better memory, repair mode, feedback learning |
| v0.4 | Desktop app / local encrypted database |
| v0.5 | Easy AI mode, Gemini/OpenRouter/Groq fallback |
| v0.6 | Voice/media/group intelligence |
| v0.7 | Real CRM dashboard, Nano Bots, sender guard, queue safety |

---

## Contributing

Reliability and judgment are more important than channel count.

Before adding new platforms, improve:

- Decision quality
- Contact memory
- Safety rules
- WhatsApp reliability
- Telegram reliability
- WeChat experimental reliability
- Easy setup for non-technical users
- Voice/group/persona test coverage
- Dashboard logs and queue visibility

---

## License

MIT License.

---

## Disclaimer

ReplyWise Local is an experimental local-first assistant. It is not affiliated with WhatsApp, Telegram, WeChat, Meta, Tencent, or any messaging platform. Use responsibly, respect privacy, and always remain the author of your own messages.
