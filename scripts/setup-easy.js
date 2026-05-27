#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

function question(rl, q) {
  return new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));
}

function setEnv(lines, key, value) {
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(lines)) return lines.replace(re, line);
  return lines.trimEnd() + `\n${line}\n`;
}

function mask(v) {
  if (!v) return '';
  return v.length <= 8 ? '***' : v.slice(0, 4) + '…' + v.slice(-4);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let content = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : fs.readFileSync(examplePath, 'utf8');

  console.log('\nReplyWise Easy Setup');
  console.log('This creates/updates .env. Ollama is optional, not required.\n');

  const channelsAns = await question(rl, 'Channels? [1] WhatsApp only  [2] WhatsApp+Telegram  [3] WhatsApp+Telegram+WeChat  (default 1): ');
  const channels = channelsAns === '3' ? 'whatsapp,telegram,wechat' : channelsAns === '2' ? 'whatsapp,telegram' : 'whatsapp';

  const gemini = await question(rl, 'Paste Gemini API key, or press Enter to use local-only fallback: ');
  const openrouter = await question(rl, 'Optional OpenRouter API key for fallback, or Enter: ');
  const groq = await question(rl, 'Optional Groq API key for fallback, or Enter: ');

  content = setEnv(content, 'AI_PROVIDER', 'easy');
  content = setEnv(content, 'AI_PROVIDER_CHAIN', 'gemini,openrouter,groq,local');
  content = setEnv(content, 'ENABLED_AGENTS', channels);
  content = setEnv(content, 'MAX_CLOUD_CALLS_PER_DAY', '80');
  content = setEnv(content, 'FALLBACK_TO_LOCAL_ON_LIMIT', 'true');
  content = setEnv(content, 'AUTO_SEND_ENABLED', 'false');
  content = setEnv(content, 'BROWSER_HEADLESS', 'false');
  if (gemini) content = setEnv(content, 'GEMINI_API_KEY', gemini);
  if (openrouter) content = setEnv(content, 'OPENROUTER_API_KEY', openrouter);
  if (groq) content = setEnv(content, 'GROQ_API_KEY', groq);

  fs.writeFileSync(envPath, content);
  rl.close();

  console.log('\nSaved .env');
  console.log(`Channels: ${channels}`);
  console.log(`Gemini: ${mask(gemini) || 'not set — local fallback only'}`);
  console.log(`OpenRouter: ${mask(openrouter) || 'not set'}`);
  console.log(`Groq: ${mask(groq) || 'not set'}`);
  console.log('\nNext:');
  console.log('  npm install');
  console.log('  npm run dev');
  console.log('  npm run agents');
  console.log('\nOpen dashboard: http://localhost:3000\n');
}

main().catch(err => { console.error(err); process.exit(1); });
