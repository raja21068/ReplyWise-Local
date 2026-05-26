# ReplyWise Local — Smart Autopilot MVP

**It does not just write replies. It tells you whether replying is a good idea.**

ReplyWise Local is a free-cost, local-first communication co-pilot for **WhatsApp + Telegram**. It uses browser/session agents, not official messaging API keys. It reads incoming text through browser events/DOM/WebSocket methods, analyzes whether replying is a good idea, auto-chooses the safest reply when possible, and can optionally auto-send only very low-risk messages.

## What changed in this version

This build adds **Smart Autopilot** with three levels:

| Level | Behavior | Use case |
|---|---|---|
| Manual | You choose and send manually | safest default |
| Auto-Choose | ReplyWise chooses the best option, but you still tap Send | recommended mode |
| Safe Auto-Send | ReplyWise chooses and sends only simple low-risk replies | optional, whitelist only |

Risky messages are never treated like simple messages.

```txt
Low risk     → auto-send can be allowed
Medium risk  → auto-choose only, manual send required
High risk    → manual choose + manual send required
```

## Core promise

Most AI tools ask:

> What should I reply?

ReplyWise asks first:

> Should I reply at all?

Every incoming message produces:

```json
{
  "decision": "yes | wait | no | repair | end",
  "confidence": 87,
  "reason": "They asked a warm open-ended question.",
  "best_move": "Answer lightly and ask back.",
  "avoid": "Do not over-flirt or write a long reply.",
  "automation": {
    "mode": "auto_choose | auto_send_safe | manual",
    "recommended_text": "...",
    "auto_send": {
      "allowed": false,
      "blocked_reasons": ["open questions require human approval"]
    }
  }
}
```

## Channels

This MVP intentionally focuses on two channels only:

| Channel | Method | Status |
|---|---|---|
| WhatsApp | `whatsapp-web.js` browser session | primary |
| Telegram | Playwright browser session | secondary |

No WhatsApp Cloud API key.  
No Telegram Bot API token.  
No official messaging API keys by default.

## Architecture

```txt
WhatsApp Web / Telegram Web
        ↓
Browser Agent
        ↓
/api/ingest/:channel
        ↓
Decision Engine
        ↓
Smart Autopilot
        ↓
Dashboard Decision Card
        ↓
Manual Send OR Safe Auto-Send
        ↓
Outgoing Queue
        ↓
Browser Agent sends through web UI
```

## Quick start

```bash
cp .env.example .env
npm install
npm run reset
npm run seed
npm run dev
```

Open:

```txt
http://localhost:3000
```

Run agents in another terminal:

```bash
npm run agents
```

Or run one channel only:

```bash
npm run agent:whatsapp
npm run agent:telegram
```

## Recommended first test

Use the sandbox form before connecting real accounts.

Try:

```txt
So what's your weekend plan?
hmm ok
haha
thank you
I'm really stressed about exams
please stop, I'm not comfortable
```

Expected behavior:

| Message type | Expected result |
|---|---|
| `haha`, `ok`, `thanks` | auto-choose; auto-send can be allowed if enabled + whitelisted |
| open question | auto-choose only; manual approval required |
| emotional/stressed | manual review required |
| boundary/rejection | no auto-send; respect boundary |
| conflict | repair mode; manual review required |

## Smart Autopilot settings

Default `.env` is safe:

```env
AUTO_CHOOSE_ENABLED=true
AUTO_SEND_ENABLED=false
AUTO_SEND_WHITELIST_ONLY=true
AUTO_SEND_CONFIDENCE_MIN=97
AUTO_SEND_MAX_LENGTH=80
AUTO_SEND_DAILY_LIMIT=20
AUTO_SEND_ALLOW_OPEN_QUESTIONS=false
AUTO_SEND_ALLOW_EMOTIONAL=false
```

### Auto-Choose

Auto-choose highlights the best option and adds a **Send Auto-Chosen** button.

It does not send by itself.

```env
AUTO_CHOOSE_ENABLED=true
AUTO_SEND_ENABLED=false
```

### Safe Auto-Send

Auto-send should be tested only with sandbox first, then one whitelisted contact.

```env
AUTO_SEND_ENABLED=true
AUTO_SEND_WHITELIST_ONLY=true
AUTO_SEND_CONFIDENCE_MIN=97
```

Then open the dashboard and set a contact to:

```txt
auto-send safe + whitelist
```

Auto-send is blocked for:

- open questions
- emotional messages
- conflict
- boundaries/rejection
- flirting
- date planning
- low confidence
- over-investing / double-text risk
- replies over the max length
- non-whitelisted contacts when whitelist mode is on

## Dashboard actions

Each card shows:

```txt
Contact · Channel
Incoming message

Decision:
Reply now / Wait / No reply / Repair / End

Why
Best move
Avoid

Smart Autopilot:
Auto-chosen option
Auto-send allowed or blocked reason

Actions:
Send Auto-Chosen
Send option
Edit / custom send
Wait
Skip
```

## Free-cost mode

Normal operation uses:

1. WhatsApp event listener or Telegram WebSocket/DOM watcher
2. Local rule engine
3. Local memory stats
4. Smart Autopilot policy
5. Dashboard approval or safe auto-send

Screenshots and OCR are not part of normal reading:

```env
SCREENSHOT_ON_ERROR=false
ENABLE_LIVE_SCREENSHOTS=false
OCR_ENABLED=false
```

## Safety model

ReplyWise uses three gates:

### Gate 1 — Should reply?

Decides:

```txt
yes / wait / no / repair / end
```

### Gate 2 — Auto-choose allowed?

Allowed for most messages because it does not send.

### Gate 3 — Auto-send allowed?

Allowed only when all conditions pass:

```txt
AUTO_SEND_ENABLED=true
contact is whitelisted
risk is low
confidence is high
message is simple/greeting/thanks/acknowledgment
reply is short
no emotional signal
no flirty/date-planning signal
no boundary/conflict signal
no over-investing warning
```

## Important warning

Browser automation may violate platform terms of service. Use for personal experimentation and local prototyping only. Sessions can break, selectors can change, and accounts may be restricted. Prefer sandbox and read-only testing before live use.

## Scripts

```bash
npm run dev              # start dashboard/API
npm run agents           # start enabled browser agents
npm run agent:whatsapp   # WhatsApp only
npm run agent:telegram   # Telegram only
npm run reset            # reset local JSON store
npm run seed             # seed sample contacts/messages
npm run syntax           # JS syntax check
npm run smoke            # sandbox smoke test, requires server running
```

## Product principle

Do not add more channels yet.

Make WhatsApp + Telegram reliable, cheap, and useful first.

The killer product is:

```txt
Runs free.
Reads safely.
Costs nothing by default.
Auto-chooses when helpful.
Auto-sends only when obviously safe.
Tells you when not to reply.
```
