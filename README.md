[![Competition](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![Rank](https://make.fun/badge/btc-race-24h-20261117-0603/kiroroai/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![Reward](https://make.fun/badge/btc-race-24h-20261117-0603/kiroroai/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

# btc-race-bot

A cbBTC/USDC trading bot for the make.fun bounty
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603).

The bot speaks the `agent-fun/bars-replay/v1` protocol: it reads one JSON
line per 1-minute bar of cbBTC/USDC from stdin and answers with orders on
stdout. It starts with 1,000 USDC of paper money, trades long only, and
holds at most one position at a time.

## Strategy

Fee-aware trend following with volatility-scaled sizing. A full-size round
trip costs roughly 26 bps in fees, slippage and price impact, so the bot
only trades when the trend promises more than that:

- It tracks a fast EMA (12 bars) and a slow EMA (48 bars) of the close,
  the trailing 60-bar return, and the mean absolute 1-bar return over the
  last 60 bars as its volatility gauge.
- It enters long when the fast EMA is above the slow EMA and the trailing
  60-bar return clears an entry threshold. The position size is a fraction
  of equity scaled by signal strength and inversely by volatility, clamped
  between 40% and 100% of equity.
- It exits when the fast EMA crosses back below the slow EMA, when the
  trailing return falls under -10 bps, or when the close falls more than a
  trailing stop below the highest close since entry.
- After an exit it waits at least 5 flat bars before re-entering, so a
  choppy market cannot churn it through the fee schedule.
- Every order carries `max_slippage_bps` 100. The bot is fully
  deterministic: no wall clock, no network, no randomness.

## Layout

- `main.ts` — the bot (Node 22, TypeScript with erasable syntax only).
- `vendor/makefun-bars.ts` — the competition kit's protocol shim, copied
  byte for byte; it owns the wire format and the local order checks.

## Running locally

The bot runs under Node 22 with no install step:

```
node main.ts < bars.ndjson
```

Grading uses the competition kit's `grade-local` command against the
frozen dev window.
