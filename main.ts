// btc-race-bot: a fee-aware dip-buying bot for cbBTC/USDC on the
// agent-fun/bars-replay/v1 protocol.
//
// The bot reads one batch per 1-minute bar and answers with at most one
// order. It is long only, holds at most one position, and puts on
// essentially its whole cash balance when it trades: the user asked for
// maximum size, and the rules allow one position of up to 100% of equity.
//
// Why dips, and why patient exits: at full size a round trip costs about
// 35 bps once the 4 bps fee, the 2 bps modelled slippage and the
// constant-product price impact on both sides are counted, and orders
// fill at the next bar's open. On the dev window, cbBTC's 1-minute closes
// mean-revert at the 30-240 minute scale: after a strong 60-minute run
// the next hour falls more often than it rises, and after a deep
// 60-minute fall it recovers. Trend entries and quick scalp exits
// (take-profit +50, stop -25, out within ~15 bars) were both graded on
// the dev window and both lose money after costs: dips keep dipping
// before they bounce, so a tight stop is paid again and again. What the
// dev grades reward is buying a deep dip at full size and holding until
// the recovery shows in the trailing return itself.
//
// The strategy, in full:
// - Flat, with at least COOLDOWN_BARS bars since the last exit, it buys
//   when the trailing 60-bar return falls under ENTRY_TRAIL_BPS: a drop
//   steep enough that the expected recovery dwarfs the round-trip cost.
// - In a position, it sells when the trailing 60-bar return climbs above
//   EXIT_TRAIL_BPS (the recovery has run), when the close falls
//   TRAIL_STOP_BPS under the highest close since entry or under the
//   entry fill price (the dip became a collapse), or after TIME_STOP_BARS
//   bars in the trade, whichever comes first.
// - Every order carries max_slippage_bps 100.
//
// Everything here is a pure function of the bars seen so far: no wall
// clock, no network, no files, no randomness. Two runs over the same
// window produce the same orders byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (bps are basis points of price) ---
const TRAIL_BARS = 60; // trailing-return lookback, in bars
const ENTRY_TRAIL_BPS = -110; // buy when the trailing return falls under this
const EXIT_TRAIL_BPS = 130; // sell when the trailing return climbs above this
const TRAIL_STOP_BPS = 130; // sell this far under the best close / entry fill
const TIME_STOP_BARS = 360; // sell after this many bars in a trade
const COOLDOWN_BARS = 5; // flat bars required after an exit before re-entry
const SIZE_FRAC = 0.999; // share of the cash balance a buy deploys
const MAX_SLIPPAGE_BPS = 100; // every order carries this cap
const LAST_ENTRY_BAR = 1380; // no fresh entries this late in a 1,440-bar window
const MIN_NOTIONAL_UNITS = 1_000_000n; // a buy spends at least 1 USDC

// --- running state, all derived from the bars of this run ---
const closes: number[] = []; // every close seen, oldest first, raw price units
let barsSeen = 0; // scored bars answered so far (warm-up excluded)
let lastBarT = -1; // close time of the newest bar folded in
let pending: 'buy' | 'sell' | null = null; // an order sent, not yet reported
let flatBars = COOLDOWN_BARS; // bars since the last exit; starts tradeable
let inPosition = false;
let entryFillPrice = 0; // raw price the open position filled at
let highestCloseSinceEntry = 0; // best close since the position was opened
let barsInTrade = 0; // bars since the position was opened

// The trailing return over the last TRAIL_BARS bars, in bps, or null while
// the history is too short to say.
function trailingReturnBps(): number | null {
  if (closes.length <= TRAIL_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - TRAIL_BARS]!;
  return (now / then - 1) * 10_000;
}

// Fold one batch's bar (when it carries a fresh one) into the history.
function foldBar(state: BarsState): boolean {
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined || bar.t === lastBarT) return false;
  lastBarT = bar.t;
  closes.push(Number(bar.c));
  return true;
}

// Watch the fills the batch reports: they settle the pending order, open
// the trade bookkeeping on an entry (the fill's own price is the level
// the hard stop is measured from), and start the cooldown clock on an
// exit. A rejection settles the pending flag too: the account in this
// batch is the truth about what is held.
function foldFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status === 'filled' && fill.side === 'buy' && pending === 'buy') {
      pending = null;
      inPosition = true;
      entryFillPrice = Number(fill.price);
      highestCloseSinceEntry = closes.length > 0 ? closes[closes.length - 1]! : 0;
      barsInTrade = 0;
    } else if (fill.status === 'filled' && fill.side === 'sell' && pending === 'sell') {
      pending = null;
      inPosition = false;
      flatBars = 0;
    } else if (fill.status === 'rejected' && pending !== null) {
      pending = null;
    }
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
    if (entryFillPrice === 0) entryFillPrice = closes[closes.length - 1]!;
    if (highestCloseSinceEntry === 0) highestCloseSinceEntry = closes[closes.length - 1]!;
  }

  const close = closes[closes.length - 1]!;
  if (inPosition && close > highestCloseSinceEntry) highestCloseSinceEntry = close;
  const trail = trailingReturnBps();
  if (trail === null) return [];

  if (inPosition) {
    barsInTrade += 1;
    if (pending !== null) return [];
    const recovered = trail > EXIT_TRAIL_BPS;
    const stopFromPeak = highestCloseSinceEntry > 0 && close < highestCloseSinceEntry * (1 - TRAIL_STOP_BPS / 10_000);
    const stopFromEntry = entryFillPrice > 0 && close < entryFillPrice * (1 - TRAIL_STOP_BPS / 10_000);
    const timedOut = barsInTrade >= TIME_STOP_BARS;
    if (recovered || stopFromPeak || stopFromEntry || timedOut) {
      pending = 'sell';
      return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: count the cooldown, then look for a dip deep enough to pay for
  // the round trip several times over.
  if (pending !== null) return [];
  flatBars += 1;
  if (flatBars < COOLDOWN_BARS) return [];
  if (barsSeen > LAST_ENTRY_BAR) return [];
  if (trail >= ENTRY_TRAIL_BPS) return [];

  let notional = BigInt(Math.floor(Number(state.cash) * SIZE_FRAC));
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
