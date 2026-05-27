# ReplyWise v6 Verification Report

Date: 2026-05-27
Package checked: `replywise-v6.zip`
Verified package version after fixes: `6.0.1`

## Result

The uploaded package had the correct overall architecture, but it had one startup-breaking bug. I fixed it and added a dedicated per-contact style test.

## Fixed issue

### Startup crash in `src/ai/tool-caller.js`

The original tool trigger definitions referenced `body` at module-load time:

```js
tools: [{ name: 'calculator', input: { expression: extractMath(body) } }]
```

That caused:

```txt
ReferenceError: body is not defined
```

Fix: converted tool inputs to lazy functions evaluated inside `callTools()`:

```js
tools: [{ name: 'calculator', input: (body) => ({ expression: extractMath(body) }) }]
```

The same fix was applied to `web_search` and `reminder` tool inputs.

## Strengthened per-contact style behavior

`src/ai/local-rule-engine.js` now uses contact-specific memory more directly in free/local mode:

- `profile_summary`
- `preferred_language`
- `emoji_style`
- `conversation_stage`
- contact rules
- recent-message stats

The local engine now derives a per-contact style object:

```js
{
  language,
  emoji,
  emojiStyle,
  tone,
  length,
  stage,
  flirtAllowed,
  avoidHeavy,
  source: 'contact profile + recent stats'
}
```

This means the same incoming message can produce different replies for different contacts.

## Test results

Commands run successfully:

```bash
npm run syntax
npm run reset
npm run seed
node src/server.js
npm run smoke
npm run style-test
```

### Syntax check

All JavaScript files passed syntax validation.

### Smoke test

Passed:

```txt
✓ So what's your weekend plan? → decision=yes, automation=auto_choose, autoSent=false
✓ hmm ok → decision=wait, automation=auto_choose, autoSent=false
✓ I'm really stressed about exams → decision=yes, automation=auto_choose, autoSent=false
✓ please stop, I'm not comfortable → decision=no, automation=auto_choose, autoSent=false
✓ dashboard reachable
```

### Per-contact style test

Passed. Same message produced different replies for four different contact profiles:

```txt
Ayesha → playful Roman Urdu + emoji
Sara   → mature English + no emoji
Hina   → short/direct English
Noor   → sarcastic/meme-style mixed language
```

Example message:

```txt
So what's your weekend plan?
```

Example outputs:

```txt
Ayesha: Abhi kuch fixed nahi. Tumhara?
Sara: I haven't planned much yet. Probably a quiet weekend. What about you?
Hina: Nothing fixed yet. You?
Noor: Survive, eat, repeat. Bohot ambitious plan 😂
```

## Honest limitations

These tests confirm the local server, sandbox pipeline, decision engine, and per-contact local reply behavior. They do not confirm live WhatsApp/Telegram browser login because that requires real user sessions and interactive QR/OTP login.

## Recommendation

Next live test should be:

1. Run only WhatsApp first.
2. Use `BROWSER_HEADLESS=false`.
3. Login with QR.
4. Test with one contact.
5. Confirm incoming read → decision card → manual approve → browser send.
6. Then test Telegram.
