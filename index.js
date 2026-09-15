// memecoin-alert-bot
//
// Watches newly-created Solana tokens and posts a Discord alert when a token
// shows an EARLY VOLUME + LIQUIDITY SPIKE while it's still young.
//
// This is a momentum/early-signal scanner, not a prediction engine. Nothing
// can reliably call a pump "before" it happens - what this does is surface
// tokens the moment real trading activity + liquidity start ramping, which
// is usually as early as any human is realistically going to catch it.
// Treat every alert as a lead to research, not a buy signal. Meme coins are
// extremely high risk and most go to zero - this is not financial advice.
//
// Data source: DexScreener's public REST API (no key required).
// Docs: https://docs.dexscreener.com/api/reference

import 'dotenv/config';
import http from 'node:http'; import { openPaperTrade, startMonitoring } from './paperTrading.js';

// ---------- Config ----------
const CFG = {
  webhookUrl: requireEnv('DISCORD_WEBHOOK_URL'),
  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 60_000),
  minLiquidityUsd: num(process.env.MIN_LIQUIDITY_USD, 4000),
  minLiquidityGrowthPct: num(process.env.MIN_LIQUIDITY_GROWTH_PCT, 25),
  volumeSpikeMultiplier: num(process.env.VOLUME_SPIKE_MULTIPLIER, 4),
  minVolumeM5Usd: num(process.env.MIN_VOLUME_M5_USD, 300),
  maxMarketCapUsd: num(process.env.MAX_MARKET_CAP_USD, 0), // 0 = no ceiling
  maxTokenAgeMinutes: num(process.env.MAX_TOKEN_AGE_MINUTES, 360),
  alertCooldownMinutes: num(process.env.ALERT_COOLDOWN_MINUTES, 180),
  watchlistTtlMinutes: num(process.env.WATCHLIST_TTL_MINUTES, 240),
  chain: process.env.REQUIRE_CHAIN || 'solana',
  botName: process.env.ALERT_BOT_NAME || 'Meme Radar',
  botAvatarUrl: process.env.ALERT_BOT_AVATAR_URL || undefined,
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- State (in-memory) ----------
// address -> { firstSeen: ms, firstLiquidity: number, lastLiquidity: number }
const watchlist = new Map();
// address -> ms timestamp of last alert
const alerted = new Map();

// ---------- DexScreener helpers ----------
const DEX_BASE = 'https://api.dexscreener.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

// Discover freshly created/boosted tokens on our target chain.
async function discoverCandidates() {
  const addresses = new Set();

  try {
    const profiles = await getJson(`${DEX_BASE}/token-profiles/latest/v1`);
    for (const p of Array.isArray(profiles) ? profiles : []) {
      if (p.chainId === CFG.chain && p.tokenAddress) addresses.add(p.tokenAddress);
    }
  } catch (err) {
    console.warn('token-profiles/latest failed:', err.message);
  }

  try {
    const boosts = await getJson(`${DEX_BASE}/token-boosts/latest/v1`);
    for (const b of Array.isArray(boosts) ? boosts : []) {
      if (b.chainId === CFG.chain && b.tokenAddress) addresses.add(b.tokenAddress);
    }
  } catch (err) {
    console.warn('token-boosts/latest failed:', err.message);
  }

  return [...addresses];
}

// Fetch full pair data for up to 30 token addresses at a time.
async function fetchPairsForTokens(addresses) {
  const out = [];
  const chunkSize = 30;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    try {
      const data = await getJson(`${DEX_BASE}/latest/dex/tokens/${chunk.join(',')}`);
      if (Array.isArray(data.pairs)) out.push(...data.pairs);
    } catch (err) {
      console.warn('token pair lookup failed:', err.message);
    }
  }
  return out;
}

// For each token address, pick its highest-liquidity pair (the "main" pool).
function pickBestPairPerToken(pairs) {
  const best = new Map(); // baseTokenAddress -> pair
  for (const pair of pairs) {
    if (pair.chainId !== CFG.chain) continue;
    const addr = pair.baseToken?.address;
    if (!addr) continue;
    const liq = pair.liquidity?.usd || 0;
    const current = best.get(addr);
    if (!current || liq > (current.liquidity?.usd || 0)) {
      best.set(addr, pair);
    }
  }
  return best;
}

// ---------- Signal logic ----------
function evaluateSignal(address, pair, entry) {
  const now = Date.now();
  const ageMin = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : Infinity;
  const liquidityUsd = pair.liquidity?.usd || 0;
  const volumeM5 = pair.volume?.m5 || 0;
  const volumeH1 = pair.volume?.h1 || 0;
  const marketCapUsd = pair.marketCap || pair.fdv || 0;

  if (ageMin > CFG.maxTokenAgeMinutes) return { pass: false, reason: 'too old' };
  if (liquidityUsd < CFG.minLiquidityUsd) return { pass: false, reason: 'liquidity below floor' };
  if (volumeM5 < CFG.minVolumeM5Usd) return { pass: false, reason: 'volume below floor' };
  if (CFG.maxMarketCapUsd > 0 && marketCapUsd > CFG.maxMarketCapUsd) {
    return { pass: false, reason: 'market cap above ceiling' };
  }

  const expectedM5FromHourly = volumeH1 / 12;
  const isVolumeSpike =
    expectedM5FromHourly === 0
      ? volumeM5 >= CFG.minVolumeM5Usd // brand new, no hourly baseline yet
      : volumeM5 >= expectedM5FromHourly * CFG.volumeSpikeMultiplier;

  const liquidityGrowthPct =
    entry.firstLiquidity > 0 ? ((liquidityUsd - entry.firstLiquidity) / entry.firstLiquidity) * 100 : 0;
  const isLiquiditySpike = liquidityGrowthPct >= CFG.minLiquidityGrowthPct;

  return {
    pass: isVolumeSpike && isLiquiditySpike,
    ageMin,
    liquidityUsd,
    volumeM5,
    volumeH1,
    liquidityGrowthPct,
  };
}

function isOnCooldown(address) {
  const last = alerted.get(address);
  if (!last) return false;
  return Date.now() - last < CFG.alertCooldownMinutes * 60_000;
}

// ---------- Discord ----------

// Builds a short auto-generated "why this fired" line, standing in for a
// human caller's thesis in the "top caller" style layouts.
function buildThesis(signal) {
  const volX = signal.volumeH1 > 0 ? (signal.volumeM5 / (signal.volumeH1 / 12)).toFixed(1) : 'n/a';
  return (
    `5-min volume is running ~${volX}x its hourly pace, and liquidity is up ` +
    `${signal.liquidityGrowthPct.toFixed(0)}% since first spotted ${Math.round(signal.ageMin)} min ago. ` +
    `Automated signal - not a call, verify before trading.`
  );
}

async function sendAlert(pair, signal) {
  const name = pair.baseToken?.name || 'Unknown';
  const symbol = pair.baseToken?.symbol || '?';
  const address = pair.baseToken?.address;
  const priceUsd = pair.priceUsd ? `$${Number(pair.priceUsd).toPrecision(4)}` : 'n/a';
  const mcap = pair.marketCap ? `$${Math.round(pair.marketCap).toLocaleString()}` : 'n/a';
  const dexUrl = pair.url || `https://dexscreener.com/${CFG.chain}/${pair.pairAddress}`;
  const solscanUrl = `https://solscan.io/token/${address}`;
  const axiomUrl = `https://axiom.trade/t/${address}`;
  const image = pair.info?.imageUrl;

  const embed = {
    author: { name: 'Early Spike Alert' },
    title: `$${symbol} — ${name}`,
    url: axiomUrl,
    color: 0x8b5cf6,
    thumbnail: image ? { url: image } : undefined,
    description: `\`${address}\`\n\n**Thesis**\n${buildThesis(signal)}`,
    fields: [
      { name: 'Market Cap', value: mcap, inline: true },
      { name: 'Price', value: priceUsd, inline: true },
      { name: 'Age', value: `${Math.round(signal.ageMin)} min`, inline: true },
      {
        name: 'Liquidity',
        value: `$${Math.round(signal.liquidityUsd).toLocaleString()} (+${signal.liquidityGrowthPct.toFixed(0)}%)`,
        inline: true,
      },
      { name: 'Vol (5m)', value: `$${Math.round(signal.volumeM5).toLocaleString()}`, inline: true },
      { name: 'Vol (1h)', value: `$${Math.round(signal.volumeH1).toLocaleString()}`, inline: true },
    ],
    footer: { text: 'Not financial advice. Extremely high risk - DYOR before trading.' },
    timestamp: new Date().toISOString(),
  };

  // Link-style buttons only (style 5) - these just open a URL and don't
  // need any interaction handling, so a plain webhook can send them.
  const components = [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 5, label: 'Trade on Axiom', url: axiomUrl },
        { type: 2, style: 5, label: 'DexScreener', url: dexUrl },
        { type: 2, style: 5, label: 'Solscan', url: solscanUrl },
      ],
    },
  ];

  const res = await fetch(CFG.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: CFG.botName,
      avatar_url: CFG.botAvatarUrl,
      embeds: [embed],
      components,
    }),
  });

  if (!res.ok) {
    console.error(`Discord webhook failed: HTTP ${res.status} ${await res.text()}`);
  } else {
    console.log(`Alerted on ${symbol} (${address})`);openPaperTrade(address, symbol);
  }
}

// ---------- Main loop ----------
async function tick() {
  const now = Date.now();

  // 1. Discover new candidates and add them to the watchlist.
  const candidates = await discoverCandidates();
  for (const addr of candidates) {
    if (!watchlist.has(addr)) {
      watchlist.set(addr, { firstSeen: now, firstLiquidity: 0, lastLiquidity: 0 });
    }
  }

  // 2. Drop stale watchlist entries.
  for (const [addr, entry] of watchlist) {
    if (now - entry.firstSeen > CFG.watchlistTtlMinutes * 60_000) {
      watchlist.delete(addr);
    }
  }

  if (watchlist.size === 0) {
    console.log('No candidates on watchlist yet.');
    return;
  }

  // 3. Pull fresh pair data for everything we're tracking.
  const pairs = await fetchPairsForTokens([...watchlist.keys()]);
  const bestByToken = pickBestPairPerToken(pairs);

  // 4. Evaluate signal for each tracked token.
  for (const [addr, entry] of watchlist) {
    const pair = bestByToken.get(addr);
    if (!pair) continue;

    if (entry.firstLiquidity === 0) {
      entry.firstLiquidity = pair.liquidity?.usd || 0;
    }
    entry.lastLiquidity = pair.liquidity?.usd || 0;

    if (isOnCooldown(addr)) continue;

    const signal = evaluateSignal(addr, pair, entry);
    if (signal.pass) {
      alerted.set(addr, now);
      await sendAlert(pair, signal);
    }
  }
}

// Tiny HTTP server, only needed so free hosts that require a web port
// (like Render's free tier) have something to check is "alive." An
// external pinger hitting this URL every few minutes also keeps the
// service from spinning down on hosts that sleep idle web services.
// Does not affect the bot's actual scanning logic at all.
function startHeartbeatServer() {
  const port = process.env.PORT;
  if (!port) return; // not running on a host that needs this - skip it
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('memecoin-alert-bot is running');
    })
    .listen(port, () => {
      console.log(`Heartbeat server listening on port ${port}`);
    });
}

async function main() {
  console.log('memecoin-alert-bot starting.');
  console.log(`Chain: ${CFG.chain} | Poll interval: ${CFG.pollIntervalMs}ms`);
  console.log('Reminder: this surfaces early momentum, it does not predict outcomes. Not financial advice.');

  startHeartbeatServer();
    startMonitoring();

  // Run immediately, then on the configured interval.
  await tick().catch((err) => console.error('tick failed:', err));
  setInterval(() => {
    tick().catch((err) => console.error('tick failed:', err));
  }, CFG.pollIntervalMs);
}

main();
