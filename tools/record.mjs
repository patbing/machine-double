// Records real model replies for the "Play a recording" button.
// Usage: POLLINATIONS_KEY=sk_... node tools/record.mjs [maxPollen]
// The key is read from the environment and never printed. Stops when the running cost passes maxPollen (default 0.1).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const M = require('../js/machines.js');
const KEY = process.env.POLLINATIONS_KEY;
if (!KEY) { console.error('Set POLLINATIONS_KEY'); process.exit(1); }
const MAX = Number(process.argv[2] || 0.1);
const API = 'https://gen.pollinations.ai';
const MODELS = ['openai/gpt-5.4-nano', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'];
const TAPES = [
  { machine: 'calculator', mode: 'dream', lines: ['17 * 23', '2^64', '987654321 * 123456789', '1/7', '0.1 + 0.2', '-2^2', '(3 + 4) / 0', '99999999999 * 99999999999', '2^100 - 1', '355/113'] },
  { machine: 'kv', mode: 'dream', lines: M.byId.kv.probes.concat(['EXISTS visits', 'INCRBY score 7', 'GET score']) },
  { machine: 'text', mode: 'dream', lines: M.byId.text.probes }
];

const list = (await (await fetch(API + '/v1/models')).json()).data;
const info = Object.fromEntries(list.map((m) => [m.id, m]));
for (const id of MODELS) if (!info[id]) { console.error('model not listed: ' + id); process.exit(1); }
const price = (id, u) => u ? u.prompt_tokens * Number(info[id].pricing.promptTextTokens) + u.completion_tokens * Number(info[id].pricing.completionTextTokens) : 0;

let spent = 0;
async function ask(id, messages) {
  const body = { model: id, messages, max_tokens: 3000 };
  if ((info[id].supported_parameters || []).includes('reasoning_effort')) body.reasoning_effort = 'low';
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(API + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => null);
      const ms = Date.now() - t0;
      if (!res.ok) { if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 3000)); continue; } return { error: 'HTTP ' + res.status + (j?.error?.message ? ': ' + j.error.message : ''), ms }; }
      const cost = price(id, j.usage);
      spent += cost;
      const text = M.cleanReply(j.choices?.[0]?.message?.content || '');
      return text ? { text, ms, cost: Number(cost.toPrecision(3)) } : { error: 'empty reply', ms, cost };
    } catch (e) { if (attempt === 0) continue; return { error: String(e.message || e), ms: Date.now() - t0 }; }
  }
}

const out = { app: 'machine-double', recordedAt: new Date().toISOString(), tapes: [] };
for (const t of TAPES) {
  const mc = M.byId[t.machine];
  let state = mc.init();
  const steps = [];
  for (const input of t.lines) {
    if (spent > MAX) { console.error('budget reached, stopping'); break; }
    const real = M.runReal(mc, state, input); state = real.state;
    const replies = {};
    await Promise.all(MODELS.map(async (id) => {
      const hist = steps.map((s) => ({ input: s.input, real: s.real, reply: s.replies[id]?.text ?? null }));
      replies[id] = await ask(id, M.buildMessages(mc, hist, t.mode, input));
    }));
    steps.push({ input, real: real.out, replies });
    const marks = MODELS.map((id) => replies[id].text != null ? (mc.same(real.out, replies[id].text) ? 'ok ' : 'SLIP') : 'ERR ').join(' ');
    console.log(`${t.machine.padEnd(10)} ${marks}  ${input}`);
  }
  out.tapes.push({ machine: t.machine, mode: t.mode, models: MODELS.map((id) => ({ id, title: info[id].title })), steps: steps.map((s) => ({ input: s.input, replies: s.replies })) });
}
writeFileSync(new URL('../recordings/tapes.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('total cost (Pollen, from usage x listed prices):', spent.toFixed(6));
