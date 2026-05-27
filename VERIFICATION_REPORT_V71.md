# ReplyWise v7.1 Stability Patch Verification Report

## Patch goal

v7.1 focuses on stability and product correctness, not new channels or major new features.

## Fixed / improved

1. **Audio-only and media-only message flow**
   - Media type normalization now uses the decision engine normalizer.
   - Voice labels such as `voice`, `ptt`, `ogg`, and `voice_note` route as `audio`.
   - Audio/media-only messages no longer fail just because `body` is empty.
   - If transcription exists, the transcript is copied into `media_summary`.

2. **Group chat no-reply behavior**
   - Unaddressed group messages now return instruction-style options only.
   - The system no longer offers boundary/apology text for a normal unaddressed group message.
   - Direct mentions still allow short neutral group-safe replies.

3. **Per-contact custom persona stability**
   - The existing `custom_persona` route and textarea remain active.
   - The v7.1 test verifies that contact rules can steer style to mature English/no emoji.

4. **WeChat dashboard visibility**
   - Dashboard channel cards now include experimental WeChat where supported.
   - Sandbox tester includes WeChat as a selectable channel.

5. **Sandbox test controls**
   - Sandbox tester now includes media type, media summary/transcript, group chat, and direct mention flags.

## Verification commands run

```txt
npm run syntax      ✅
npm run v7-test     ✅
npm run v71-test    ✅
npm run style-test  ✅
```

## Not tested here

- Live WhatsApp QR login.
- Live Telegram Web login.
- Live WeChat Web login.
- Real whisper.cpp/Python Whisper audio transcription.

Those require local accounts/sessions and optional local transcription binaries.
