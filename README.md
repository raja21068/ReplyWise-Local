# ConversationOS Local — Killer MVP

**It does not just write replies. It tells you whether replying is a good idea.**

ConversationOS Local is a free-cost, local-first communication co-pilot for **WhatsApp + Telegram**.

- No official messaging API keys
- No bot tokens
- No cloud AI required
- No screenshot/OCR reading loop
- Browser-session agents only
- Manual approval before every outgoing message
- Local JSON store by default for simple free testing

## What it does

Incoming message → judgment engine → decision card → reply options → manual approve/edit/wait/skip → browser agent sends through the real web UI.

Decision actions:

- `yes` — reply now
- `wait` — do not chase; wait first
- `repair` — fix tension calmly
- `no` — respect boundary / do not reply
- `end` — end politely if needed

## Quick start

```bash
cp .env.example .env
npm install
npm run reset
npm run seed
npm run dev
```

Open:

```text
http://localhost:3000
```

Use the sandbox form first. Try messages like:

```text
So what's your weekend plan?
hmm ok
I'm really stressed about exams
please stop, I'm not comfortable
```

## Run browser agents

In another terminal:

```bash
npm run agents
```

For lower cost, run one agent only:

```bash
npm run agent:whatsapp
# or
npm run agent:telegram
```

## Login

Use:

```env
BROWSER_HEADLESS=false
```

WhatsApp prints QR in the terminal. Telegram opens a browser login flow. Sessions persist inside `data/sessions/`.

## Free-cost rules

Normal operation uses:

1. WhatsApp event listener or Telegram WebSocket/DOM watcher
2. Local rule engine
3. Local memory stats
4. Manual approval

Screenshots are disabled by default:

```env
SCREENSHOT_ON_ERROR=false
ENABLE_LIVE_SCREENSHOTS=false
```

Only enable screenshots temporarily for debugging.

## Safety promise

ConversationOS Local will not auto-send. `ALLOW_AUTOSEND=true` is blocked intentionally. Approved text is queued and sent only by the browser agent after the user clicks Send.

## Product focus

This MVP intentionally supports only WhatsApp and Telegram. More channels are not the goal yet. The goal is to make 1–2 channels reliable, cheap, and useful.
