/**
 * paperTrading.js
 *
 * Drop-in paper trading module for the Memecoin-alert bot.
 * Simulates buys/sells with fixed TP/SL — no real funds, no wallet needed.
 *
 * Integration:
 *   const { openPaperTrade, startMonitoring } = require('./paperTrading');
 *
 *   // In your existing alert logic, right after you detect a signal
 *   // and post the alert to Discord, also open a paper trade:
 *   openPaperTrade(tokenAddress, tokenSymbol);
 *
 *   // Once, at bot startup:
 *   startMonitoring();
 *
 * Config via environment variables (set these in Render):
 *   DISCORD_WEBHOOK_URL   - same webhook you already use for alerts
 *   TAKE_PROFIT_PCT       - e.g. 50   (close at +50%)
 *   STOP_LOSS_PCT         - e.g. 20   (close at -20%)
 *   MAX_HOLD_HOURS        - e.g. 24   (force-close if neither hits)
 *   CHECK_INTERVAL_MS     - e.g. 60000 (how often to poll prices, default 1 min)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '50');
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '20');
const MAX_HOLD_HOURS = parseFloat(process.env.MAX_HOLD_HOURS || '24');
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);

// Positions persist to disk so a Render restart doesn't lose open trades.
const DATA_FILE = path.join(__dirname, 'paper-positions.json');

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { open: [], closed: [] };
  }
}

function savePositions(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('DISCORD_WEBHOOK_URL not set — skipping Discord post.');
    console.log(content);
    return;
  }
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error('Failed to post to Discord:', err.message);
  }
}

// Dexscreener's public API — no key required. Works for Solana pairs.
async function getCurrentPrice(tokenAddress) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener request failed: ${res.status}`);
  const data = await res.json();
  const pair = data.pairs && data.pairs[0];
  if (!pair) throw new Error('No pair data found for token');
  return {
    priceUsd: parseFloat(pair.priceUsd),
    url: pair.url,
  };
}

/**
 * Call this the moment your alert bot fires a signal on a token.
 */
async function openPaperTrade(tokenAddress, tokenSymbol = 'UNKNOWN') {
  try {
    const { priceUsd } = await getCurrentPrice(tokenAddress);
    if (!priceUsd) throw new Error('Could not fetch entry price');

    const data = loadPositions();
    const position = {
      id: `${tokenAddress}-${Date.now()}`,
      tokenAddress,
      tokenSymbol,
      entryPrice: priceUsd,
      entryTime: new Date().toISOString(),
    };
    data.open.push(position);
    savePositions(data);

    await postToDiscord(
      `📝 **Paper trade opened** — ${tokenSymbol}\n` +
      `Entry: $${priceUsd}\n` +
      `TP: +${TAKE_PROFIT_PCT}% · SL: -${STOP_LOSS_PCT}% · Max hold: ${MAX_HOLD_HOURS}h\n` +
      `https://axiom.trade/t/${tokenAddress}`
    );
  } catch (err) {
    console.error(`Failed to open paper trade for ${tokenSymbol}:`, err.message);
  }
}

async function checkOpenPositions() {
  const data = loadPositions();
  if (data.open.length === 0) return;

  const stillOpen = [];

  for (const pos of data.open) {
    try {
      const { priceUsd } = await getCurrentPrice(pos.tokenAddress);
      const changePct = ((priceUsd - pos.entryPrice) / pos.entryPrice) * 100;
      const hoursHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;

      let closeReason = null;
      if (changePct >= TAKE_PROFIT_PCT) closeReason = 'TAKE_PROFIT';
      else if (changePct <= -STOP_LOSS_PCT) closeReason = 'STOP_LOSS';
      else if (hoursHeld >= MAX_HOLD_HOURS) closeReason = 'MAX_HOLD_TIME';

      if (closeReason) {
        const closed = {
          ...pos,
          exitPrice: priceUsd,
          exitTime: new Date().toISOString(),
          pnlPct: changePct,
          closeReason,
        };
        data.closed.push(closed);

        const emoji = changePct >= 0 ? '✅' : '🔴';
        await postToDiscord(
          `${emoji} **Paper trade closed** — ${pos.tokenSymbol} (${closeReason})\n` +
          `Entry: $${pos.entryPrice} → Exit: $${priceUsd}\n` +
          `P/L: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% · Held: ${hoursHeld.toFixed(1)}h`
        );
      } else {
        stillOpen.push(pos);
      }
    } catch (err) {
      console.error(`Failed to check position ${pos.tokenSymbol}:`, err.message);
      stillOpen.push(pos); // keep it open, retry next cycle
    }
  }

  data.open = stillOpen;
  savePositions(data);
}

async function postSummary() {
  const data = loadPositions();
  const closed = data.closed;
  if (closed.length === 0) return;

  const wins = closed.filter((t) => t.pnlPct >= 0);
  const winRate = ((wins.length / closed.length) * 100).toFixed(1);
  const avgPnl = (closed.reduce((sum, t) => sum + t.pnlPct, 0) / closed.length).toFixed(1);
  const totalPnl = closed.reduce((sum, t) => sum + t.pnlPct, 0).toFixed(1);

  await postToDiscord(
    `📊 **Paper trading summary**\n` +
    `Closed trades: ${closed.length} · Open: ${data.open.length}\n` +
    `Win rate: ${winRate}% · Avg P/L per trade: ${avgPnl}%\n` +
    `Cumulative P/L (summed %): ${totalPnl}%`
  );
}

/**
 * Call once at bot startup. Polls open positions on an interval
 * and posts a summary every 20 checks (roughly every ~20 min at
 * the default 1-min interval — adjust to taste).
 */
function startMonitoring() {
  let tickCount = 0;
  setInterval(async () => {
    await checkOpenPositions();
    tickCount++;
    if (tickCount % 20 === 0) await postSummary();
  }, CHECK_INTERVAL_MS);

  console.log(
    `Paper trading monitor started. TP +${TAKE_PROFIT_PCT}% / SL -${STOP_LOSS_PCT}% / ` +
    `max hold ${MAX_HOLD_HOURS}h / checking every ${CHECK_INTERVAL_MS / 1000}s.`
  );
}

export { openPaperTrade, checkOpenPositions, postSummary, startMonitoring };
