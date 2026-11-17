// btc-race-bot: a fee-aware trend-following bot for cbBTC/USDC on the
// agent-fun/bars-replay/v1 protocol.
//
// The bot reads one batch per 1-minute bar and answers with at most one
// order. It is long only, holds at most one position, and never trades on
// a signal that cannot pay for the round trip: a full-size round trip
// costs about 26 bps once the 4 bps fee, the 2 bps modelled slippage and
// the constant-product price impact are all counted, so entries demand a
// trend that promises more than that, and sizing shrinks as the expected
// impact grows.
//
// Everything here is a pure function of the bars seen so far: no wall
// clock, no network, no files, no randomness. Two runs over the same
// window produce the same orders byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (bps are basis points of price or equity) ---
const EMA_FAST_BARS = 12; // fast EMA length, in bars
const EMA_SLOW_BARS = 48; // slow EMA length, in bars
const TRAIL_BARS = 60; // trailing-return lookback, in bars
const VOL_BARS = 60; // volatility lookback, in bars
const ENTRY_TRAIL_BPS = 30; // enter only above this trailing return
const EXIT_TRAIL_BPS = -10; // exit when the trailing return falls under this
const TRAIL_STOP_BPS = 45; // exit this far under the best close since entry
const COOLDOWN_BARS = 5; // flat bars required after an exit before re-entry
const MIN_SIZE_FRAC = 0.4; // smallest entry, as a share of equity
const MAX_SIZE_FRAC = 1.0; // largest entry, as a share of equity
const REF_VOL_BPS = 5; // volatility the sizing is calibrated against
const STRENGTH_SPAN_BPS = 120; // trailing return span mapped onto full size
const MAX_SLIPPAGE_BPS = 100; // every order carries this cap
const LAST_ENTRY_BAR = 1380; // no fresh entries this late in a 1,440-bar window
const MIN_NOTIONAL_UNITS = 1_000_000n; // a buy spends at least 1 USDC

// --- running state, all derived from the bars of this run ---
const closes: number[] = []; // every close seen, oldest first, as a float price
let emaFast = 0;
let emaSlow = 0;
let indicatorsReady = false;
let barsSeen = 0; // scored bars answered so far (warm-up excluded)
let lastBarT = -1; // close time of the newest bar folded in
let pending: 'buy' | 'sell' | null = null; // an order sent, not yet reported
let flatBars = COOLDOWN_BARS; // bars since the last exit; starts tradeable
let highestCloseSinceEntry = 0; // best close since the position was opened
let inPosition = false;

const fastK = 2 / (EMA_FAST_BARS + 1);
const slowK = 2 / (EMA_SLOW_BARS + 1);

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// The trailing return over the last TRAIL_BARS bars, in bps, or null while
// the history is too short to say.
function trailingReturnBps(): number | null {
  if (closes.length <= TRAIL_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - TRAIL_BARS]!;
  return (now / then - 1) * 10_000;
}

// Mean absolute 1-bar return over the last VOL_BARS bars, in bps: the
// volatility gauge the position size is scaled against.
function volatilityBps(): number | null {
  if (closes.length <= VOL_BARS) return null;
  let sum = 0;
  for (let i = closes.length - VOL_BARS; i < closes.length; i++) {
    sum += Math.abs(closes[i]! / closes[i - 1]! - 1);
  }
  return (sum / VOL_BARS) * 10_000;
}

// The share of equity to put on an entry: grows with the strength of the
// trailing trend, shrinks as volatility (and with it the cost of getting
// in and out) rises, and stays inside [MIN_SIZE_FRAC, MAX_SIZE_FRAC].
function entryFraction(trailBps: number, volBps: number): number {
  const strength = clamp((trailBps - ENTRY_TRAIL_BPS) / STRENGTH_SPAN_BPS, 0, 1);
  const bySignal = MIN_SIZE_FRAC + (MAX_SIZE_FRAC - MIN_SIZE_FRAC) * strength;
  const byVol = bySignal * clamp(REF_VOL_BPS / volBps, 0.5, 1.25);
  return clamp(byVol, MIN_SIZE_FRAC, MAX_SIZE_FRAC);
}

// Fold one batch's bar (when it carries a fresh one) into the indicators.
function foldBar(state: BarsState): boolean {
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined || bar.t === lastBarT) return false;
  lastBarT = bar.t;
  const close = Number(bar.c);
  closes.push(close);
  if (!indicatorsReady) {
    emaFast = close;
    emaSlow = close;
    indicatorsReady = true;
  } else {
    emaFast += fastK * (close - emaFast);
    emaSlow += slowK * (close - emaSlow);
  }
  if (inPosition && close > highestCloseSinceEntry) highestCloseSinceEntry = close;
  return true;
}

// Watch the fills the batch reports: they settle the pending order, start
// the trailing-stop bookkeeping on an entry, and start the cooldown clock
// on an exit.
function foldFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy' && pending === 'buy') {
      pending = null;
      inPosition = true;
      highestCloseSinceEntry = closes.length > 0 ? closes[closes.length - 1]! : 0;
    } else if (fill.side === 'sell' && pending === 'sell') {
      pending = null;
      inPosition = false;
      flatBars = 0;
    }
  }
  // A rejected order also settles the pending flag: the account in this
  // batch is the truth about what is held.
  if (pending !== null && batch.fills.some((f) => f.symbol === SYMBOL && f.status === 'rejected')) {
    pending = null;
  }
}

function decide(state: BarsState, batch: Batch): OrderInput[] {
  foldFills(batch);
  const fresh = foldBar(state);
  if (!fresh || state.warmingUp) return [];
  barsSeen += 1;

  // Trust the account over the bookkeeping: if the harness says there is
  // no position, there is none, whatever a missed fill suggested.
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty === 0n) {
    if (inPosition) {
      inPosition = false;
      flatBars = 0;
    }
  } else if (!inPosition && pending === null) {
    inPosition = true;
    if (highestCloseSinceEntry === 0) {
      highestCloseSinceEntry = closes[closes.length - 1]!;
    }
  }

  const close = closes[closes.length - 1]!;
  const trail = trailingReturnBps();
  const vol = volatilityBps();
  if (trail === null || vol === null) return [];

  if (inPosition) {
    if (pending !== null) return [];
    const stopHit = highestCloseSinceEntry > 0 && close < highestCloseSinceEntry * (1 - TRAIL_STOP_BPS / 10_000);
    if (emaFast < emaSlow || trail < EXIT_TRAIL_BPS || stopHit) {
      pending = 'sell';
      return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: count the cooldown, then look for an entry worth its fees.
  if (pending !== null) return [];
  flatBars += 1;
  if (flatBars < COOLDOWN_BARS) return [];
  if (barsSeen > LAST_ENTRY_BAR) return [];
  if (emaFast <= emaSlow || trail <= ENTRY_TRAIL_BPS) return [];

  const frac = entryFraction(trail, vol);
  let notional = BigInt(Math.floor(Number(state.equity) * frac));
  const room = state.weightRoom(SYMBOL);
  if (notional > room) notional = room;
  if (notional > state.cash) notional = state.cash;
  if (notional < MIN_NOTIONAL_UNITS) return [];

  pending = 'buy';
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    return decide(state, batch);
  },
});
