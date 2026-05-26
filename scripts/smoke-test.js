const base = process.env.APP_BASE_URL || 'http://localhost:3000';

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const cases = [
    { body: "So what's your weekend plan?", expect: 'yes' },
    { body: 'hmm ok', expect: 'wait' },
    { body: "I'm really stressed about exams", expect: 'yes' },
    { body: "please stop, I'm not comfortable", expect: 'no' },
  ];
  for (const c of cases) {
    const data = await post('/api/sandbox/telegram/incoming', {
      externalContactId: `tg_smoke_${Math.random().toString(36).slice(2)}`,
      displayName: 'Smoke Test',
      body: c.body,
    });
    if (!data.suggestionId) throw new Error('missing suggestionId');
    if (!data.decision || !data.decision.action) throw new Error('missing decision');
    console.log(`✓ ${c.body} → decision=${data.decision.action}, confidence=${data.decision.confidence}`);
  }
  const root = await fetch(`${base}/`);
  if (!root.ok) throw new Error(`dashboard failed: ${root.status}`);
  console.log('✓ dashboard reachable');
}

main().catch(err => { console.error('Smoke test failed:', err); process.exit(1); });
