// scripts/bench/alchemy-arb-warm.cjs
// Usage: ALCH_ARB_KEY=... node scripts/bench/alchemy-arb-warm.cjs [N]
// Sends N JSON-RPC POSTs over one kept-alive connection and reports latency stats.

const { Agent, setGlobalDispatcher, request } = require('undici');

const N = parseInt(process.argv[2] || process.env.N || '50', 10);
const key = process.env.ALCH_ARB_KEY;
if (!key) {
  console.error('ERROR: Set ALCH_ARB_KEY (your Alchemy Arbitrum API key).');
  process.exit(1);
}

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  pipelining: 1
}));

const url = https://arb-mainnet.g.alchemy.com/v2/${key};
const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

(async () => {
  const times = [];

  // Warm-up to establish TCP/TLS
  const warm = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  await warm.body.text();

  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    const { body } = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    });
    await body.text();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    times.push(ms);
    await new Promise(r => setTimeout(r, 150)); // small spacing
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
})();
