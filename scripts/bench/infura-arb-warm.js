// Usage: INFURA_PROJECT_ID=... node scripts/bench/infura-arb-warm.js [N]
import { Agent, setGlobalDispatcher, request } from 'undici';

const N = parseInt(process.argv[2] || process.env.N || '50', 10);
const pid = process.env.INFURA_PROJECT_ID;
if (!pid) { console.error('Set INFURA_PROJECT_ID'); process.exit(1); }

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  pipelining: 1,
}));

const url = `https://arbitrum-mainnet.infura.io/v3/${pid}`;
const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

const times = [];
// warm-up
await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });

for (let i = 0; i < N; i++) {
  const start = process.hrtime.bigint();
  const { body } = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  await body.text(); // small body; total ~= TTFB for our purposes
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  times.push(ms);
  await new Promise(r => setTimeout(r, 150)); // tiny spacing to avoid rate bursts
}

times.sort((a,b)=>a-b);
const mean = times.reduce((a,b)=>a+b,0)/times.length;
const sd = Math.sqrt(times.reduce((s,x)=>s+(x-mean)**2,0)/times.length);
const p = q => times[Math.floor((times.length-1)*q)];
console.log(JSON.stringify({
  samples: times.length,
  mean_ms: +mean.toFixed(2),
  stddev_ms: +sd.toFixed(2),
  p50_ms: +p(0.50).toFixed(2),
  p90_ms: +p(0.90).toFixed(2),
  p99_ms: +p(0.99).toFixed(2),
  min_ms: +times[0].toFixed(2),
  max_ms: +times[times.length-1].toFixed(2)
}, null, 2));
