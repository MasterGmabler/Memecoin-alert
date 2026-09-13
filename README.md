# memecoin-alert-bot

Watches newly-created Solana tokens and posts a Discord alert when a token
shows **early volume + liquidity growth** while it's still young. Built for
your trader Discord as a "here's something moving" feed, not a buy signal.

No prediction here is guaranteed - the goal is to surface real trading
momentum as early as it's realistically detectable. Most young meme coins
still go to zero even with early volume. Post it with that framing.

## How it works

1. Every poll, it pulls freshly-listed/boosted Solana tokens from
   [DexScreener's public API](https://docs.dexscreener.com/api/reference)
   (free, no API key).
2. It keeps tracking each token for a while (`WATCHLIST_TTL_MINUTES`),
   re-checking its liquidity and volume on every poll.
3. It alerts when, for a still-young token:
   - 5-minute volume is far above its own hourly run-rate (a spike), **and**
   - liquidity has grown a meaningful % since it was first spotted.
4. Alerts go to a Discord channel via **webhook** - no bot token, no
   gateway connection, nothing to invite. Just a URL.
5. Each token only alerts once per cooldown window so you don't get spammed.

## Setup

1. Install [Node.js 18+](https://nodejs.org).
2. In your Discord server: **Server Settings → Integrations → Webhooks →
   New Webhook**, pick the channel, copy the URL.
3. In this folder:
   ```bash
   npm install
   cp .env.example .env
   ```
4. Paste your webhook URL into `.env` as `DISCORD_WEBHOOK_URL`.
5. Run it:
   ```bash
   npm start
   ```
   Leave it running (a small VPS, a Raspberry Pi, Railway/Render's free
   tier, etc. all work - it's a single lightweight Node process).

## Tuning it

Everything in `.env.example` is adjustable. The two that matter most:

- `VOLUME_SPIKE_MULTIPLIER` - lower it to catch more (noisier) alerts,
  raise it to only see strong spikes.
- `MIN_LIQUIDITY_USD` - raise this if you're tired of seeing tokens with
  almost no real liquidity behind them.

If alerts feel too frequent or too rare, adjust these first before touching
the code.

## Known limitations (read before trusting alerts)

- **This cannot tell a real pump from a rug pull.** A liquidity + volume
  spike is also exactly what a coordinated pump looks like right before a
  dump. Nothing in here checks whether mint/freeze authority is renounced,
  whether liquidity is locked, or holder concentration - those are the next
  things worth adding if you want to filter harder before posting to a
  trading audience.
- DexScreener's discovery endpoints (`token-profiles`, `token-boosts`)
  surface tokens that were recently *boosted or had a profile submitted* -
  that's a good proxy for "new and trying to get attention" but it will
  miss tokens that never boost/submit a profile. If you want closer to
  every single new pump.fun launch, you'd swap the discovery step for a
  pump.fun or Solana on-chain data provider instead - ask if you want that
  version built out.
- It's in-memory only: restarting the process clears the watchlist and
  cooldowns.

## Customizing the Discord embed

The `sendAlert` function in `index.js` builds the embed. Good next additions:
a direct trade link (e.g. your Axiom referral pattern), a reaction-based
"claim this call" for your mods, or routing different confidence levels to
different channels.
