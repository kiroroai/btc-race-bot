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

Fee-aware dip buying at full size. A full-size round trip costs about
35 bps once the 4 bps fee, the 2 bps modelled slippage and the price
impact on both sides are counted, and orders fill at the next bar's
open, so the bot only trades moves that dwarf that cost:

- cbBTC's 1-minute closes mean-revert at the 30-240 minute scale on the
  dev window: deep 60-minute falls recover, strong 60-minute runs fade.
  The bot therefore buys the dip and sells the recovery. (Trend entries
  and quick scalp exits were graded on the dev window too; both lose
  money after costs, because dips keep dipping before they bounce and a
  tight stop is paid again and again.)
- It enters long, with essentially its whole cash balance, when the
  trailing 60-bar return falls under -110 bps, provided at least 5 flat
  bars have passed since the last exit.
- It exits when the trailing 60-bar return climbs above +130 bps, when
  the close falls 130 bps under the highest close since entry or under
  the entry fill price, or after 360 bars in the trade.
- Every order carries `max_slippage_bps` 100. The bot is fully
  deterministic: no wall clock, no network, no randomness.

On the frozen dev window this grades at about +$30 net PnL from 5 fills
with a maximum drawdown under 1%: comfortably through the dev gate
(net PnL above 0) and far inside the race guardrail of 25%.

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
