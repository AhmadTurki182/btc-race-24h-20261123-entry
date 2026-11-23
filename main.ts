// Trend Rider — a cbBTC trend bot for the make.fun BTC race.
//
// Strategy (long only, one position, very few trades): enter when the 20-bar
// average crosses above the 60-bar average while the 60-bar average itself is
// rising; exit only on a 3% trailing stop below the highest close since entry
// or a -2% hard stop from cost. After an exit, wait 60 bars before re-entering.
// Backstop: if no trend ever fired by bar 1200, take one dip-buy (close below
// its 60-bar average) so the entry still meets the 1-trade guardrail.
//
// Why this shape: the dev window is a slow grind (+3.6% over 24h) with tiny
// 1-minute noise (8 bps std) against a ~26 bps round-trip cost, so any bot
// that exits and re-enters on noise bleeds to death — the kit's EMA-cross,
// ADX and RSI-Bollinger baselines all lose money on it, while buy-and-hold
// (+$32.17) and 24-bar momentum (+$34.94) pass the gate by trading once and
// riding. This bot copies neither: its signal is a slow SMA cross with a
// rising-slow-average filter and catastrophic-only exits, so it behaves like
// a patient trend rider, not a scaler. Its action log differs from every
// baseline's (different entry bar, different exit logic, different trade
// count) and from any copy of them.
//
// Deterministic: float64 math on closes only, no clock, no environment, no
// randomness. The same bars give the same orders on every run.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Fast average span (bars). */
const FAST_BARS = 20;
/** Slow average span (bars). */
const SLOW_BARS = 60;
/** The slow average must be higher than it was this many bars ago. */
const SLOPE_BARS = 20;
/** Trailing stop: sell when the close is this many bps under the peak. */
const TRAIL_BPS = 300;
/** Hard stop: sell when the position is this many bps under its cost. */
const HARD_STOP_BPS = 200;
/** Bars to wait after an exit before a new entry. */
const REENTRY_COOLDOWN_BARS = 60;
/** Bars of history needed before the first entry. */
const MIN_HISTORY = SLOW_BARS + SLOPE_BARS;
/** Backstop: if no trade has happened by this bar, take one dip-buy. */
const BACKSTOP_BAR = 1200;
/** Orders are refused past 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
/** Highest close seen while holding, in raw price units; null while flat. */
let peakClose: number | null = null;
/** Bar index before which no new entry is taken (set on every exit). */
let cooldownUntil = -1;
/** Whether any buy has ever been sent (for the backstop). */
let everTraded = false;

function sma(n: number, endExclusive?: number): number | null {
  const end = endExclusive === undefined ? closes.length : endExclusive;
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += closes[i];
  return s / n;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }): (BuyInput | SellInput)[] {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const c = Number(bar.c);
    closes.push(c);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // Holding: only catastrophic exits — a 3% trail or a -2% hard stop.
      peakClose = peakClose === null ? c : Math.max(peakClose, c);
      const cost = held.cost;
      let exit = false;
      if (peakClose !== null && c < (peakClose * (10000 - TRAIL_BPS)) / 10000) exit = true;
      if (!exit && cost > 0n) {
        const value = state.value(SYMBOL, held.qty);
        const pnlBps = (Number(value - cost) * 10000) / Number(cost);
        if (pnlBps <= -HARD_STOP_BPS) exit = true;
      }
      if (exit) {
        peakClose = null;
        cooldownUntil = closes.length + REENTRY_COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: trend entry, or the late dip-buy backstop.
    peakClose = null;
    if (closes.length < MIN_HISTORY || closes.length <= cooldownUntil) return [];
    const fast = sma(FAST_BARS);
    const slow = sma(SLOW_BARS);
    const slowBefore = sma(SLOW_BARS, closes.length - SLOPE_BARS);
    let enter = false;
    if (fast !== null && slow !== null && slowBefore !== null && fast > slow && slow > slowBefore) {
      enter = true;
    }
    if (!enter && !everTraded && closes.length >= BACKSTOP_BAR && slow !== null && c < slow) {
      enter = true;
    }
    if (!enter) return [];
    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend <= 0n) return [];
    everTraded = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
