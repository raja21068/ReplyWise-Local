# ReplyWise Local

<p align="center">
  <img src="images/1.png" alt="ReplyWise Local hero preview" width="100%">
</p>

<h3 align="center">It does not just write replies. It tells you whether replying is a good idea.</h3>

<p align="center">
  <strong>Local-first AI reply assistant for WhatsApp, Telegram, and experimental WeChat browser sessions.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v7.2-blue">
  <img alt="Mode" src="https://img.shields.io/badge/mode-local--first-green">
  <img alt="Human Approval" src="https://img.shields.io/badge/manual_approval-default-important">
  <img alt="Ollama" src="https://img.shields.io/badge/Ollama-optional-lightgrey">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-black">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-replywise">Why ReplyWise</a> ·
  <a href="#features">Features</a> ·
  <a href="#easy-ai-mode">Easy AI Mode</a> ·
  <a href="#safety">Safety</a>
</p>

---

## Why ReplyWise?

Most AI reply tools only answer:

> “What should I reply?”

ReplyWise answers the more important question first:

> **“Should I reply at all?”**

It analyzes timing, tone, emotional state, energy balance, boundaries, conversation momentum, group context, and per-contact memory before suggesting anything.

<p align="center">
  <img src="images/2.png" alt="ReplyWise Local dashboard preview" width="100%">
</p>

---

## Core Product Idea

ReplyWise is built around one powerful idea:

> **Different contact = different memory = different reply style.**

The same message can produce different replies depending on the person.

| Contact | Style Memory | Example Reply Style |
|---|---|---|
| Ayesha | Roman Urdu, playful, light emojis | “Weekend ka plan abhi pending hai 😂 tumhara?” |
| Sara | Mature English, low emojis | “Nothing fixed yet. Probably a quiet weekend. What about you?” |
| Hina | Short, direct, busy | “Nothing fixed yet. You?” |
| Noor | Sarcastic, meme energy | “Survive, eat, repeat. Very ambitious plan 😂” |

This makes ReplyWise feel like a **personal communication brain**, not a generic chatbot.

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

Group messages use different rules:

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

If an API limit is hit, it falls back safely.

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

## Architecture

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
Voice Transcription / Media Context
        ↓
Conversation Engine
        ↓
Should-I-Reply Decision
        ↓
Per-Contact Memory + Custom Persona
        ↓
Reply Generator
        ↓
Safety / Group Rules / Autopilot Guardrails
        ↓
Mobile Approval Dashboard
        ↓
Outgoing Queue
        ↓
Browser Agent Sends Through Web UI
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/replywise-local.git
cd replywise-local
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard helps you choose:

- Local-only mode
- Gemini key
- OpenRouter fallback
- Groq fallback
- Daily cloud call limit
- Enabled agents

### 3. Start the dashboard

```bash
npm run dev
```

Open:

```txt
http://localhost:3000
```

### 4. Start an agent

```bash
npm run agent:whatsapp
```

Other options:

```bash
npm run agent:telegram
npm run agent:wechat
npm run agent:all
npm run agents
```

---

## Easy AI Mode

ReplyWise v7.2 is designed for normal users who do **not** want to install Ollama.

Recommended `.env`:

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
```

How the fallback works:

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
```

Local mode still supports:

- Should-I-reply decisions
- Basic reply templates
- Energy matching
- Group rules
- Anti-cringe checks
- Manual approval dashboard

---

## Voice Transcription

Voice notes can be handled without Ollama.

```env
TRANSCRIBE_ENABLED=false
TRANSCRIBE_BACKEND=auto
TRANSCRIBE_COMMAND=
TRANSCRIBE_HTTP_URL=
```

Recommended privacy-first approach:

```txt
whisper.cpp local → best privacy
Python faster-whisper → good local option
Local HTTP service → good for advanced users
Cloud STT → easiest but external/private-data risk
```

If transcription fails, ReplyWise does not blindly generate a fake reply. It asks for review or uses media-aware safe logic.

---

## Group Chat Logic

Group chats are not treated like private chats.

| Situation | Decision |
|---|---|
| Random group message, no mention | Usually no reply |
| Direct @mention | Short neutral reply allowed |
| Question to everyone | Optional short reply |
| Flirty context in group | Block/avoid |
| Conflict in group | Calm repair or no reply |
| Unknown media/file in group | Review manually |

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

## Recommended Test Flow

Start with WhatsApp and one test contact.

```txt
1. Start dashboard
2. Start WhatsApp agent
3. Scan WhatsApp Web QR
4. Ask a test contact to message you
5. Confirm message appears in dashboard
6. Check should-reply decision
7. Approve/edit a reply
8. Confirm browser agent sends it
9. Confirm outgoing status becomes sent
```

Success means:

- Incoming message detected
- Decision created
- Reply options shown
- Manual approval required
- Outgoing message queued
- Browser agent sends through web UI
- No screenshot/OCR used for message reading

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
npm run v71-test
npm run easy-test
npm test
```

---

## Verification Checklist

```txt
✅ Same message to 4 contacts gives 4 different reply styles
✅ Audio-only message does not crash ingest pipeline
✅ Group message without mention gives no-reply decision
✅ Direct group mention gives short neutral reply
✅ Contact custom persona overrides global persona
✅ API provider limit falls back to local safe mode
✅ WhatsApp/Telegram/WeChat dashboard controls appear correctly
```

---

## Safety

ReplyWise is a human-in-the-loop communication assistant.

Do not use it for:

- Spam
- Harassment
- Manipulation
- Impersonation
- Fully autonomous messaging
- Bypassing platform enforcement
- Sending messages without human review

Hard rules:

```txt
No auto-send by default.
No stealth/bypass logic.
No screenshot reading loop.
No OCR-based message reading.
No official messaging API-key dependency for browser-agent MVP.
No reply after clear rejection or boundary.
No flirty or romantic replies in group chats.
No blind replies to audio/video/file messages without enough context.
Stop cloud AI calls when daily limit is reached.
Fallback to local safe mode when API providers fail.
```

---

## Platform Risk Notice

Browser automation may violate the terms of service of some platforms. Sessions can break, selectors can change, and accounts may face restrictions.

Use this project for personal experimentation and local prototyping only. Prefer read-only mode during testing. Use a secondary account where appropriate.

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

---

## License

MIT License.

---

## Disclaimer

ReplyWise Local is an experimental local-first assistant. It is not affiliated with WhatsApp, Telegram, WeChat, Meta, Tencent, or any messaging platform. Use responsibly, respect privacy, and always remain the author of your own messages.
