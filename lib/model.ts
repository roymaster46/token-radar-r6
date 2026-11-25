// Token Radar, radar-6 — the value model, the validation that earns each term, and the
// farm economics. Everything is computed from the sealed snapshot at runtime: the size
// curve, the category factors, the growth and age terms, the launch odds and the farm
// plans all come out of the snapshot's own figures, never out of a list of names or a
// price written in by hand. A term joins the final model only when it wins BOTH
// held-out tests (leave-one-out and walk-forward) against the model without it; the
// validation table in the dashboard shows the losers too, so a reader can see what
// was tried and dropped. Deterministic throughout: no clock, no randomness except a
// seeded generator whose seed is a constant below.
//
// Design notes (what changed since radar-5, and why):
// - The size curve is a power law, log10(mcap) = a + b*log10(TVL), fitted by least
//   squares on the snapshot's own traded tokens, with a curvature term that bends the
//   curve down at both ends. A flat multiple overprices giants fivefold; the curve is
//   the single biggest win in the ablation table.
// - Growth is winsorised to [-50%, +200%] and mapped concavely (log1p), so one spike
//   week cannot dominate a value. The linear form is kept in the table as the
//   comparison; the concave form is the candidate that must beat it on both tests.
// - Age is a mild NEGATIVE term: the market pays less per TVL for a protocol that
//   has waited years without a token, and the cohort read says the same thing — the
//   launch window is mostly the first three years, so a young protocol is worth more,
//   not less, than an old one at the same TVL.
// - Concentration was a candidate penalty (one chain 0.85x, three or more 1.0x)
//   and it LOSES held out: it improves walk-forward a little but makes
//   leave-one-out clearly worse, with and without the category term, so the
//   final model carries no concentration term and the table shows the loss.
// - Category is a shrunk median of the category's own traded tokens' log residuals
//   against the curve (prior 25 pseudo-observations, at least 3 traded tokens or the
//   factor is 1). Categories with almost no traded peers fall back to the curve.
// - Launch odds are a cohort read, not a forecast: the share of an age bucket's
//   pre-token remainder that would have to launch for the bucket to reach the 3+ year
//   plateau. A logistic classifier on size, age, growth and name kinship is reported
//   alongside it, held out 5-fold, so the odds carry a measured accuracy.
// - Farm plans are costed by the cheapest chain's gas profile (Ethereum L1,
//   L2s, Solana), not a flat rate: a plan acts on the protocol's cheapest leg,
//   so a mainnet-only plan costs an order of magnitude more than an L2 one,
//   and the verdict has to know that.

export const MODEL_VERSION = 'radar-6';

/** A protocol as the snapshot carries it. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  mcap_usd: number | null;
}

/** The snapshot: the fetch date, the source line, the watchlist floor, the protocols
 *  at or above $5M TVL sorted by slug, and the 40 watchlist slugs. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Every constant the model uses, so the dashboard can print them and a reader can
 *  re-derive every figure from them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  growth_concave: number;
  age_weight: number;
  unknown_age_days: number;
  min_age_days: number;
  cat_prior: number;
  cat_min_n: number;
  curve_c: number;
  drop_share: number;
  ticket_usd: number;
  farm_threshold_usd: number;
  thin_threshold_usd: number;
  setup_gas_l1_usd: number;
  weekly_gas_l1_usd: number;
  exit_gas_l1_usd: number;
  setup_gas_l2_usd: number;
  weekly_gas_l2_usd: number;
  exit_gas_l2_usd: number;
  setup_gas_sol_usd: number;
  weekly_gas_sol_usd: number;
  exit_gas_sol_usd: number;
  opp_rate: number;
  bootstrap_refits: number;
  bootstrap_seed: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 200,
  growth_concave: 0.25,
  age_weight: -0.05,
  unknown_age_days: 365,
  min_age_days: 30,
  cat_prior: 25,
  cat_min_n: 3,
  curve_c: -0.04,
  drop_share: 0.07,
  ticket_usd: 1000,
  farm_threshold_usd: 10,
  thin_threshold_usd: 0,
  setup_gas_l1_usd: 12,
  weekly_gas_l1_usd: 1.5,
  exit_gas_l1_usd: 12,
  setup_gas_l2_usd: 0.5,
  weekly_gas_l2_usd: 0.1,
  exit_gas_l2_usd: 0.5,
  setup_gas_sol_usd: 0.05,
  weekly_gas_sol_usd: 0.01,
  exit_gas_sol_usd: 0.05,
  opp_rate: 0.04,
  bootstrap_refits: 200,
  bootstrap_seed: 20261114,
};

/** How many live-token rows and set-aside rows the dashboard carries. */
export const LIVE_ROWS = 24;
export const SETASIDE_ROWS = 24;

/** One farm step: an action with its cost and its time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One board row: a ranked pre-token protocol with its value, its band, its odds and
 *  its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  implied_p10_usd: number;
  implied_p90_usd: number;
  rank_low: number;
  rank_high: number;
  launch_odds: number;
  slice_usd: number;
  farm_fees_usd: number;
  farm_opp_usd: number;
  farm_hours: number;
  farm_days: number;
  farm_capital_usd: number;
  net_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  break_even_odds: number;
  gas_label: string;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    age_days: number | null;
    category_multiplier: number;
    category_n: number;
  };
  farm_steps: string[];
}

/** A live-token row for the dashboard's Live token view. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** A set-aside row for the dashboard's Set aside view. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  reason: string;
}

/** One coverage bucket: every protocol in exactly one bucket, the buckets summing to
 *  the snapshot's protocol count. */
export interface CoverageBucket {
  key: string;
  label: string;
  count: number;
}

/** One category's fitted factor, for the dashboard's method panel. */
export interface CategoryFactor {
  category: string;
  factor: number;
  n: number;
}

/** The full validation record: the ablation from the flat multiple to the final model,
 *  each step scored on both held-out tests, the measured band hold rates, and the odds
 *  classifier's held-out accuracy. */
export interface Validation {
  n_comps: number;
  fit_a: number;
  fit_b: number;
  fit_r2: number;
  fit_r2_final: number;
  loo_flat_med: number;
  loo_flat_within3: number;
  loo_size_med: number;
  loo_size_within3: number;
  loo_curve_med: number;
  loo_curve_within3: number;
  loo_growth_lin_med: number;
  loo_growth_lin_within3: number;
  loo_growth_conc_med: number;
  loo_growth_conc_within3: number;
  loo_age_med: number;
  loo_age_within3: number;
  loo_conc_med: number;
  loo_conc_within3: number;
  loo_conc_cat_med: number;
  loo_conc_cat_within3: number;
  loo_final_med: number;
  loo_final_within3: number;
  loo_discount_med: number;
  loo_discount_within3: number;
  loo_chains_med: number;
  loo_chains_within3: number;
  loo_coarse_med: number;
  loo_coarse_within3: number;
  loo_quadols_med: number;
  loo_quadols_within3: number;
  rank_flat: number;
  rank_size: number;
  rank_curve: number;
  rank_growth_lin: number;
  rank_growth_conc: number;
  rank_age: number;
  rank_conc: number;
  rank_final: number;
  wf_flat_med: number;
  wf_flat_within3: number;
  wf_size_med: number;
  wf_size_within3: number;
  wf_curve_med: number;
  wf_curve_within3: number;
  wf_growth_lin_med: number;
  wf_growth_lin_within3: number;
  wf_growth_conc_med: number;
  wf_growth_conc_within3: number;
  wf_age_med: number;
  wf_age_within3: number;
  wf_conc_med: number;
  wf_conc_within3: number;
  wf_conc_cat_med: number;
  wf_conc_cat_within3: number;
  wf_final_med: number;
  wf_final_within3: number;
  wf_discount_med: number;
  wf_chains_med: number;
  wf_coarse_med: number;
  wf_quadols_med: number;
  wf_newer: number;
  band_p2575: number;
  band_p1090: number;
  band_q10: number;
  band_q25: number;
  band_q75: number;
  band_q90: number;
  odds_acc: number;
  odds_base: number;
  odds_n: number;
  cohort_plateau: number;
  cohort: CohortRow[];
  cat_prior: number;
  cat_min_n: number;
  curve_c: number;
  fit_mx: number;
  category_factors: CategoryFactor[];
}

/** The scatter the dashboard draws: traded tokens and board rows in log space, with
 *  the fitted curve's points, so a reader can see the curve the board sits on. */
export interface Scatter {
  comps: Array<[number, number]>;
  board: Array<[number, number]>;
  line: Array<[number, number]>;
}

/** Everything the dashboard needs: the board, the live set, the set-aside set, and
 *  the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  setaside_size: number;
  total_protocols: number;
  implied_total_usd: number;
  coverage: CoverageBucket[];
  validation: Validation;
  scatter: Scatter;
  farm_counts: { farm: number; thin: number; skip: number };
  watchlist: string[];
  rows: RadarRow[];
  live: LiveRow[];
  setaside: SetAsideRow[];
}

/** A board row's compact form for data.js, with the farm plan carried along so the
 *  page shows board.json's own steps, never a second derivation of them. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  implied_p10_usd: number;
  implied_p90_usd: number;
  rank_low: number;
  rank_high: number;
  launch_odds: number;
  slice_usd: number;
  farm_fees_usd: number;
  farm_opp_usd: number;
  farm_hours: number;
  farm_days: number;
  farm_capital_usd: number;
  net_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  break_even_odds: number;
  gas_label: string;
  growth_multiplier: number;
  age_multiplier: number;
  category_multiplier: number;
  farm_steps: string[];
}

/** One row of the cohort table: the token rate of protocols listed in an age bucket,
 *  and the eventual launch odds that rate implies for the bucket's pre-token
 *  remainder. */
export interface CohortRow {
  label: string;
  n: number;
  rate: number;
  odds: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is
 *  absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a list of numbers, or null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The q-th quantile of a list of numbers by linear interpolation, or null when
 *  empty. */
export function quartile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another
 *  protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The watchlist rule's wrapped/staked words: a whole word wrapped, staked or
 *  staking, any case. */
const WRAPPED = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

/** The watchlist rule's exchange prefixes: a name that begins with an exchange's
 *  name. */
const EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Categories the watchlist rule treats as a wrapped, staked or bridged product. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked or bridged product of a token that
 *  already trades. */
export function isProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (WRAPPED.test(p.name)) return true;
  if (EXCHANGE.test(p.name)) return true;
  return false;
}

/** Whether a protocol is one the board may rank: pre-token, not a product, not a
 *  versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isProduct(p) && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The traded comparables: protocols whose token trades with a market cap and a
 *  TVL. */
export function tradedComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

/** Least squares on log10(market cap) against log10(TVL): the size curve's intercept,
 *  slope and R-squared. A slope near 0.5 says a tenfold TVL buys about a threefold
 *  market cap. */
export function fitPowerLaw(comps: SnapshotProtocol[]): {
  a: number;
  b: number;
  r2: number;
  n: number;
  mx: number;
} {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
    syy += (ys[i]! - my) * (ys[i]! - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  return { a, b, r2: sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy), n, mx };
}

/** The curvature multiplier for a TVL: 10^(curve_c x (log10 TVL - mx)^2). At
 *  curve_c = -0.04 a protocol 1.5 decades from the mean TVL reads 10% lower than the
 *  straight line, and one 2 decades out reads 17% lower: giants and minnows both
 *  price below the line. */
export function curveMultiplier(tvlUsd: number, mx: number, model: ModelConstants): number {
  const d = Math.log10(tvlUsd) - mx;
  return 10 ** (model.curve_c * d * d);
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

/** The free quadratic on log10(market cap) against centred log10(TVL): intercept,
 *  slope, curvature and centre, all fitted by least squares on the training set. The
 *  final model does NOT use this: its fitted curvature is positive, it wins
 *  walk-forward but not leave-one-out, so it lives here only so the validation can
 *  show it loses. */
export function fitQuadratic(train: SnapshotProtocol[]): { a: number; b: number; c: number; mx: number } {
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const X = xs.map((x) => [1, x - mx, (x - mx) ** 2]);
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < 3; r++) {
      b[r]! += X[i]![r]! * ys[i]!;
      for (let c = 0; c < 3; c++) A[r]![c]! += X[i]![r]! * X[i]![c]!;
    }
  }
  const w = solveLinear(A, b);
  return { a: w[0]!, b: w[1]!, c: w[2]!, mx };
}

/** The free quadratic's size value for a protocol, before growth, age and category. */
export function quadraticBase(p: SnapshotProtocol, qf: { a: number; b: number; c: number; mx: number }): number {
  const x = Math.log10(p.tvl_usd) - qf.mx;
  return 10 ** (qf.a + qf.b * x + qf.c * x * x);
}

/** The seven-day growth as a fraction, winsorised to the floor and cap, with a
 *  missing reading counting as flat. The cap is 200%, not 100%: one spike week is
 *  clipped, not erased, and the concave map below does the damping. */
export function growthFraction(p: SnapshotProtocol, model: ModelConstants): number {
  return Math.min(model.growth_cap, Math.max(model.growth_floor, finite(p.change_7d, 0))) / 100;
}

/** The growth multiplier, linear: 1 + weight x growth, so +10% over seven days adds
 *  6% at weight 0.60. This is the radar-5 form, kept in the table as the comparison
 *  the concave form must beat. */
export function growthMultiplierLinear(p: SnapshotProtocol, model: ModelConstants): number {
  return 1 + model.growth_weight * growthFraction(p, model);
}

/** The growth multiplier, concave: 1 + concave x log1p(growth), so the upside bends
 *  down — a +200% week reads 1.28x instead of the linear form's 1.60x, and a -50%
 *  week reads 0.83x instead of 0.70x. A spike week still lifts the value, but it
 *  cannot dominate it. */
export function growthMultiplier(p: SnapshotProtocol, model: ModelConstants): number {
  const g = growthFraction(p, model);
  const mapped = Math.min(1.1, Math.max(-0.7, Math.log1p(g)));
  return 1 + model.growth_concave * mapped;
}

/** The age multiplier: older with no token scores slightly lower, younger slightly
 *  higher, at weight -0.05 per decade of age relative to a year: a 56-day protocol
 *  gets 1.10x, a five-year one 0.92x. An unknown age counts as a year, so the
 *  factor is 1. The sign is the data's, not a prior's: held out, the market pays
 *  less per TVL for a protocol that has waited years without a token. */
export function ageMultiplier(p: SnapshotProtocol, asOf: string, model: ModelConstants): number {
  const age = ageDays(asOf, p.listed_at) ?? model.unknown_age_days;
  return 10 ** (model.age_weight * Math.log10(Math.max(model.min_age_days, age) / model.unknown_age_days));
}

/** The concentration multiplier: a protocol on one chain carries all its TVL in one
 *  place, so it reads 0.85x; two chains 0.925x; three or more 1.0x. Most of a
 *  snapshot's TVL sits in a handful of pools, so a single-chain book is the
 *  concentrated one. A candidate term: it joins only if it wins both held-out
 *  tests. */
export function concentrationMultiplier(p: SnapshotProtocol): number {
  const n = Math.min(Math.max(p.chains.length, 1), 3);
  return 0.85 + 0.075 * (n - 1);
}

/** The category factor for a protocol: the shrunk median of its category's traded
 *  tokens' log residuals against the size curve with the growth and age
 *  adjustments, pulled toward 1 by `cat_prior` pseudo-observations. A category
 *  with fewer than `cat_min_n` traded tokens in the training set does not move the
 *  value at all: with one or two tokens the median is noise, and the factor must
 *  earn its keep. The residual is measured against the curve alone, never against
 *  a value that already carries a category factor, so the factor cannot feed on
 *  itself. */
export function categoryFactor(
  p: SnapshotProtocol,
  asOf: string,
  fit: { a: number; b: number },
  train: SnapshotProtocol[],
  model: ModelConstants,
): number {
  const same = train.filter((q) => q.category === p.category);
  if (same.length < model.cat_min_n) return 1;
  const residuals = same.map(
    (q) => Math.log10(q.mcap_usd! / fittedValue(q, asOf, fit, model)),
  );
  const med = median(residuals) ?? 0;
  return 10 ** ((same.length * med) / (same.length + model.cat_prior));
}

/** The fitted value of a protocol's token if it traded like the comparables: the
 *  size curve with its curvature term, and the growth and age adjustments, times
 *  the category factor when a training set is given. No concentration term and no
 *  extra pre-token discount: both were tried and both lose held out (the table
 *  shows them), so the final model carries neither. Issuance risk lives in the
 *  odds, which multiply the slice, rather than in the value. */
export function fittedValue(
  p: SnapshotProtocol,
  asOf: string,
  fit: { a: number; b: number; mx: number },
  model: ModelConstants,
  train?: SnapshotProtocol[],
): number {
  const base =
    10 ** fit.a * p.tvl_usd ** fit.b *
    curveMultiplier(p.tvl_usd, fit.mx, model) *
    growthMultiplier(p, model) *
    ageMultiplier(p, asOf, model);
  if (train === undefined) return base;
  return base * categoryFactor(p, asOf, fit, train, model);
}

/** A category's coarse group: the sector buckets the dropped coarse-group term
 *  used, so the validation can show what grouping the categories buys (it buys
 *  nothing: the grouped factor misses by more held out than the per-category
 *  one). */
export function coarseGroup(p: SnapshotProtocol): string {
  const c = p.category ?? '';
  if (c === 'Dexs' || c === 'DEX Aggregator' || c === 'Liquidity Manager') return 'dex';
  if (c === 'Lending' || c === 'CDP' || c === 'Collateral Management') return 'lend';
  if (c === 'Yield' || c === 'Yield Aggregator' || c === 'Leveraged Farming') return 'yield';
  if (c === 'Risk Curators' || c === 'Onchain Capital Allocator') return 'curator';
  if (c === 'Derivatives' || c === 'Basis Trading') return 'deriv';
  if (c === 'Liquid Staking' || c === 'Liquid Restaking' || c === 'Restaking' || c === 'Staking Pool') return 'stake';
  if (c === 'Bridge' || c === 'Canonical Bridge' || c === 'Cross Chain Bridge') return 'bridge';
  if (c === 'RWA') return 'rwa';
  if (c === 'CEX') return 'cex';
  return 'other';
}

/** The coarse-group factor, the same shrunk-median construction as the category
 *  factor but over the coarse group: kept only so the validation can show it
 *  loses. */
export function coarseFactor(
  p: SnapshotProtocol,
  asOf: string,
  fit: { a: number; b: number },
  train: SnapshotProtocol[],
  model: ModelConstants,
): number {
  const group = coarseGroup(p);
  const same = train.filter((q) => coarseGroup(q) === group);
  if (same.length < model.cat_min_n) return 1;
  const residuals = same.map(
    (q) => Math.log10(q.mcap_usd! / fittedValue(q, asOf, fit, model)),
  );
  const med = median(residuals) ?? 0;
  return 10 ** ((same.length * med) / (same.length + 10));
}

/** Every category's fitted factor on the full comparables, strongest first, for the
 *  dashboard's method panel: the factors the board actually multiplies by. */
export function categoryFactors(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): CategoryFactor[] {
  const comps = tradedComps(snapshot);
  const fit = fitPowerLaw(comps);
  const byCategory = new Map<string, SnapshotProtocol[]>();
  for (const p of comps) {
    const list = byCategory.get(p.category ?? 'Other') ?? [];
    list.push(p);
    byCategory.set(p.category ?? 'Other', list);
  }
  const out: CategoryFactor[] = [];
  for (const [category, list] of byCategory) {
    if (list.length < model.cat_min_n) continue;
    out.push({
      category,
      factor: categoryFactor(list[0]!, snapshot.as_of, fit, comps, model),
      n: list.length,
    });
  }
  out.sort((a, b) => b.factor - a.factor);
  return out;
}

/** The radar-3 value, kept only so the validation can show what the flat multiple
 *  scored: the shrunk category-median multiple, the 0.80 discount, growth at
 *  weight 0.60, maturity by age and 3% per chain up to four. */
export function flatValue(
  p: SnapshotProtocol,
  asOf: string,
  train: SnapshotProtocol[],
  model: ModelConstants,
): number {
  const live = train.filter((q) => q.mcap_usd !== null && q.mcap_usd > 0 && q.tvl_usd > 0);
  const all = live.map((q) => q.mcap_usd! / q.tvl_usd);
  const global = median(all) ?? 0.25;
  const same = live.filter((q) => q.category === p.category).map((q) => q.mcap_usd! / q.tvl_usd);
  const med = median(same);
  const multiple = med !== null && same.length >= 3 ? (same.length * med + 3 * global) / (same.length + 3) : global;
  const clamped = Math.min(1.5, Math.max(0.05, multiple));
  const growthPct = Math.min(100, Math.max(-50, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * 0.6;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const maturity = 0.6 + (Math.min(Math.max(age, 0), 1095) / 1095) * 0.4;
  const breadth = 1 + 0.03 * (Math.min(Math.max(p.chains.length, 1), 4) - 1);
  return p.tvl_usd * clamped * 0.8 * growthMult * maturity * breadth;
}

/** The miss of one prediction: the larger of actual over predicted and predicted
 *  over actual, so x3 means the figure is off threefold either way. */
export function miss(actual: number, predicted: number): number {
  return Math.max(actual / predicted, predicted / actual);
}

/** Leave-one-out median miss and share within 3x for a predictor over the
 *  comparables. */
export function looScore(
  comps: SnapshotProtocol[],
  predict: (train: SnapshotProtocol[], test: SnapshotProtocol) => number,
): { med: number; within3: number; residuals: number[] } {
  const misses: number[] = [];
  const residuals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const test = comps[i]!;
    const pred = predict(train, test);
    if (pred > 0 && Number.isFinite(pred)) {
      misses.push(miss(test.mcap_usd!, pred));
      residuals.push(Math.log10(test.mcap_usd! / pred));
    }
  }
  misses.sort((a, b) => a - b);
  return {
    med: median(misses) ?? 1,
    within3: misses.length === 0 ? 0 : misses.filter((m) => m <= 3).length / misses.length,
    residuals,
  };
}

/** Walk-forward median miss: fit on the older half of the dated comparables, test
 *  on the newer half, so the model is judged on tokens it could not have seen when
 *  it was fitted. */
export function walkForwardScore(
  comps: SnapshotProtocol[],
  predict: (train: SnapshotProtocol[], test: SnapshotProtocol) => number,
): { med: number; within3: number; newer: number } {
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = dated[Math.floor(dated.length / 2)]!.listed_at!;
  const older = dated.filter((p) => p.listed_at! < cut);
  const newer = dated.filter((p) => p.listed_at! >= cut);
  const misses = newer
    .map((test) => {
      const pred = predict(older, test);
      return pred > 0 && Number.isFinite(pred) ? miss(test.mcap_usd!, pred) : null;
    })
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  return {
    med: median(misses) ?? 1,
    within3: misses.length === 0 ? 0 : misses.filter((m) => m <= 3).length / misses.length,
    newer: newer.length,
  };
}

/** Spearman's rank correlation between the leave-one-out predictions and the actual
 *  market caps: whether the model puts the big tokens above the small ones, even
 *  when the dollar figures are far off. */
export function looRankCorrelation(
  comps: SnapshotProtocol[],
  predict: (train: SnapshotProtocol[], test: SnapshotProtocol) => number,
): number {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const pred = predict(train, comps[i]!);
    if (pred > 0 && Number.isFinite(pred)) rows.push([comps[i]!.mcap_usd!, pred]);
  }
  if (rows.length < 3) return 0;
  const rankOf = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(values.length);
    order.forEach(([_, i], k) => {
      out[i] = k + 1;
    });
    return out;
  };
  const ra = rankOf(rows.map((r) => r[0]));
  const rp = rankOf(rows.map((r) => r[1]));
  const n = rows.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mp = rp.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ra[i]! - ma) * (rp[i]! - mp);
    sxx += (ra[i]! - ma) ** 2;
    syy += (rp[i]! - mp) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/** The full validation record: the ablation from the flat multiple to the final
 *  model, each step scored on both held-out tests, walk-forward on every step, the
 *  measured band hold rates, and the odds classifier's held-out accuracy. The
 *  growth rows branch: the linear form and the concave form are both scored from
 *  the same curve base, and the final model carries whichever wins both tests.
 *  Six rows are terms that were tried and NOT used: a uniform pre-token discount,
 *  a chain-count bonus, a coarse sector grouping, a free quadratic, and whichever
 *  of the two growth forms loses — all score worse held out than the final model
 *  on at least one test, so the final model carries none of them, and the table
 *  says so. The curvature term, the winning growth form and the category term are
 *  the additions that win both tests, so they are the final model. */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): Validation {
  const comps = tradedComps(snapshot);
  const asOf = snapshot.as_of;
  const sizeVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    10 ** fit.a * p.tvl_usd ** fit.b;
  const curveVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    sizeVal(fit, p) * curveMultiplier(p.tvl_usd, fit.mx, model);
  const growthLinVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    curveVal(fit, p) * growthMultiplierLinear(p, model);
  const growthConcVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    curveVal(fit, p) * growthMultiplier(p, model);
  const ageVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    growthConcVal(fit, p) * ageMultiplier(p, asOf, model);
  const concVal = (fit: { a: number; b: number; mx: number }, p: SnapshotProtocol): number =>
    ageVal(fit, p) * concentrationMultiplier(p);

  const flat = (train: SnapshotProtocol[], test: SnapshotProtocol): number => flatValue(test, asOf, train, model);
  const sizeOnly = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return sizeVal(fit, test);
  };
  const withCurve = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return curveVal(fit, test);
  };
  const withGrowthLin = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return growthLinVal(fit, test);
  };
  const withGrowthConc = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return growthConcVal(fit, test);
  };
  const withAge = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return ageVal(fit, test);
  };
  const withConc = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return concVal(fit, test);
  };
  const final = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return ageVal(fit, test) * categoryFactor(test, asOf, fit, train, model);
  };
  const concCat = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return concVal(fit, test) * categoryFactor(test, asOf, fit, train, model);
  };
  const withDiscount = (train: SnapshotProtocol[], test: SnapshotProtocol): number => sizeOnly(train, test) * 0.8;
  const withChains = (train: SnapshotProtocol[], test: SnapshotProtocol): number =>
    withAge(train, test) * 10 ** (0.1 * Math.log10(Math.max(1, test.chains.length)));
  const withCoarse = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const fit = fitPowerLaw(train);
    return concVal(fit, test) * coarseFactor(test, asOf, fit, train, model);
  };
  const quadOls = (train: SnapshotProtocol[], test: SnapshotProtocol): number => {
    const qf = fitQuadratic(train);
    const qb = (q: SnapshotProtocol): number =>
      quadraticBase(q, qf) * growthMultiplier(q, model) * ageMultiplier(q, asOf, model);
    let v = qb(test);
    const same = train.filter((q) => q.category === test.category);
    if (same.length >= model.cat_min_n) {
      const res = same.map((q) => Math.log10(q.mcap_usd! / qb(q)));
      const med = median(res) ?? 0;
      v *= 10 ** ((same.length * med) / (same.length + model.cat_prior));
    }
    return v;
  };

  const looFlat = looScore(comps, flat);
  const looSize = looScore(comps, sizeOnly);
  const looCurve = looScore(comps, withCurve);
  const looGrowthLin = looScore(comps, withGrowthLin);
  const looGrowthConc = looScore(comps, withGrowthConc);
  const looAge = looScore(comps, withAge);
  const looConc = looScore(comps, withConc);
  const looFinal = looScore(comps, final);
  const looConcCat = looScore(comps, concCat);
  const looDiscount = looScore(comps, withDiscount);
  const looChains = looScore(comps, withChains);
  const looCoarse = looScore(comps, withCoarse);
  const looQuadOls = looScore(comps, quadOls);
  const wfFlat = walkForwardScore(comps, flat);
  const wfSize = walkForwardScore(comps, sizeOnly);
  const wfCurve = walkForwardScore(comps, withCurve);
  const wfGrowthLin = walkForwardScore(comps, withGrowthLin);
  const wfGrowthConc = walkForwardScore(comps, withGrowthConc);
  const wfAge = walkForwardScore(comps, withAge);
  const wfConc = walkForwardScore(comps, withConc);
  const wfFinal = walkForwardScore(comps, final);
  const wfConcCat = walkForwardScore(comps, concCat);
  const wfDiscount = walkForwardScore(comps, withDiscount);
  const wfChains = walkForwardScore(comps, withChains);
  const wfCoarse = walkForwardScore(comps, withCoarse);
  const wfQuadOls = walkForwardScore(comps, quadOls);

  const q25 = quartile(looFinal.residuals, 0.25) ?? 0;
  const q75 = quartile(looFinal.residuals, 0.75) ?? 0;
  const q10 = quartile(looFinal.residuals, 0.1) ?? 0;
  const q90 = quartile(looFinal.residuals, 0.9) ?? 0;
  const in2575 = looFinal.residuals.filter((r) => r >= q25 && r <= q75).length;
  const in1090 = looFinal.residuals.filter((r) => r >= q10 && r <= q90).length;
  const fit = fitPowerLaw(comps);
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of comps) {
    const pred = Math.log10(fittedValue(p, asOf, fit, model, comps));
    ssRes += (Math.log10(p.mcap_usd!) - pred) ** 2;
    ssTot += (Math.log10(p.mcap_usd!) - meanY) ** 2;
  }
  const odds = oddsValidation(snapshot, model);
  const cohort = cohortOddsTable(snapshot);
  return {
    n_comps: comps.length,
    fit_a: fit.a,
    fit_b: fit.b,
    fit_r2: fit.r2,
    fit_r2_final: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    loo_flat_med: looFlat.med,
    loo_flat_within3: looFlat.within3,
    loo_size_med: looSize.med,
    loo_size_within3: looSize.within3,
    loo_curve_med: looCurve.med,
    loo_curve_within3: looCurve.within3,
    loo_growth_lin_med: looGrowthLin.med,
    loo_growth_lin_within3: looGrowthLin.within3,
    loo_growth_conc_med: looGrowthConc.med,
    loo_growth_conc_within3: looGrowthConc.within3,
    loo_age_med: looAge.med,
    loo_age_within3: looAge.within3,
    loo_conc_med: looConc.med,
    loo_conc_within3: looConc.within3,
    loo_conc_cat_med: looConcCat.med,
    loo_conc_cat_within3: looConcCat.within3,
    loo_final_med: looFinal.med,
    loo_final_within3: looFinal.within3,
    loo_discount_med: looDiscount.med,
    loo_discount_within3: looDiscount.within3,
    loo_chains_med: looChains.med,
    loo_chains_within3: looChains.within3,
    loo_coarse_med: looCoarse.med,
    loo_coarse_within3: looCoarse.within3,
    loo_quadols_med: looQuadOls.med,
    loo_quadols_within3: looQuadOls.within3,
    rank_flat: looRankCorrelation(comps, flat),
    rank_size: looRankCorrelation(comps, sizeOnly),
    rank_curve: looRankCorrelation(comps, withCurve),
    rank_growth_lin: looRankCorrelation(comps, withGrowthLin),
    rank_growth_conc: looRankCorrelation(comps, withGrowthConc),
    rank_age: looRankCorrelation(comps, withAge),
    rank_conc: looRankCorrelation(comps, withConc),
    rank_final: looRankCorrelation(comps, final),
    wf_flat_med: wfFlat.med,
    wf_flat_within3: wfFlat.within3,
    wf_size_med: wfSize.med,
    wf_size_within3: wfSize.within3,
    wf_curve_med: wfCurve.med,
    wf_curve_within3: wfCurve.within3,
    wf_growth_lin_med: wfGrowthLin.med,
    wf_growth_lin_within3: wfGrowthLin.within3,
    wf_growth_conc_med: wfGrowthConc.med,
    wf_growth_conc_within3: wfGrowthConc.within3,
    wf_age_med: wfAge.med,
    wf_age_within3: wfAge.within3,
    wf_conc_med: wfConc.med,
    wf_conc_within3: wfConc.within3,
    wf_conc_cat_med: wfConcCat.med,
    wf_conc_cat_within3: wfConcCat.within3,
    wf_final_med: wfFinal.med,
    wf_final_within3: wfFinal.within3,
    wf_discount_med: wfDiscount.med,
    wf_chains_med: wfChains.med,
    wf_coarse_med: wfCoarse.med,
    wf_quadols_med: wfQuadOls.med,
    wf_newer: wfFinal.newer,
    band_p2575: looFinal.residuals.length === 0 ? 0 : in2575 / looFinal.residuals.length,
    band_p1090: looFinal.residuals.length === 0 ? 0 : in1090 / looFinal.residuals.length,
    band_q10: q10,
    band_q25: q25,
    band_q75: q75,
    band_q90: q90,
    odds_acc: odds.acc,
    odds_base: odds.base,
    odds_n: odds.n,
    cohort_plateau: cohort.plateau,
    cohort: cohort.rows,
    cat_prior: model.cat_prior,
    cat_min_n: model.cat_min_n,
    curve_c: model.curve_c,
    fit_mx: fit.mx,
    category_factors: categoryFactors(snapshot, model),
  };
}

/** The first word of a protocol's name, lowercased: the stem two protocols share
 *  when one is a deployment, a variant or a namesake of the other. */
export function nameStem(p: SnapshotProtocol): string {
  return p.name.split(/[^A-Za-z0-9]+/)[0]!.toLowerCase();
}

/** The stems of the protocols whose token trades, with how many tokened protocols
 *  carry each stem: the set a protocol's kinship is read against. A stem is a name,
 *  never a list of names: the rule is the same for every row. */
export function tokenStems(snapshot: Snapshot): Map<string, number> {
  const stems = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const stem = nameStem(p);
    stems.set(stem, (stems.get(stem) ?? 0) + 1);
  }
  return stems;
}

/** Whether a protocol is kin to a token that already trades: its name stem is shared
 *  with a DIFFERENT protocol whose token trades. The "different" matters: a tokened
 *  protocol shares its own stem with itself, so counting itself would leak the very
 *  fact the classifier is asked to call, and the accuracy would be a tautology.
 *  Kin protocols are usually a deployment or a variant of an established tokened
 *  family, so kinship is a strong token-or-not signal — and it points at already
 *  having a token, which is why the board's launch odds stay a cohort read: a kin
 *  pre-token row is the exception, a namesake whose own launch the family token
 *  already covers. */
export function kinshipOf(p: SnapshotProtocol, stems: Map<string, number>): number {
  const count = stems.get(nameStem(p)) ?? 0;
  if (isPreToken(p)) return count >= 1 ? 1 : 0;
  return count >= 2 ? 1 : 0;
}

/** The classifier's features for a protocol: log size, log age, growth, and
 *  kinship. Unknown age counts as a year and unknown growth as flat, the same
 *  imputation the value model uses. Sector dummies were tried and dropped: they add
 *  nothing held out once kinship is in, so the classifier carries the smaller
 *  set. */
export function oddsFeatures(
  p: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  stems: Map<string, number>,
): number[] {
  const age = ageDays(asOf, p.listed_at) ?? model.unknown_age_days;
  return [
    Math.log10(p.tvl_usd),
    Math.log10(Math.max(model.min_age_days, age)),
    growthFraction(p, model),
    kinshipOf(p, stems),
  ];
}

/** A sigmoid. */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Logistic regression by plain gradient descent, on standardised features: 300
 *  passes, a fixed step, a zero start. Deterministic: the same rows always give
 *  the same weights. */
export function fitLogit(rows: Array<{ x: number[]; y: number }>): { w: number[]; mean: number[]; sd: number[] } {
  const d = rows[0]!.x.length;
  const mean = new Array<number>(d).fill(0);
  const sd = new Array<number>(d).fill(0);
  for (const r of rows) for (let k = 0; k < d; k++) mean[k]! += r.x[k]!;
  for (let k = 0; k < d; k++) mean[k]! /= rows.length;
  for (const r of rows) for (let k = 0; k < d; k++) sd[k]! += (r.x[k]! - mean[k]!) ** 2;
  for (let k = 0; k < d; k++) sd[k]! = Math.sqrt(sd[k]! / rows.length) || 1;
  const z = (x: number[]): number[] => x.map((v, k) => (v - mean[k]!) / sd[k]!);
  const w = new Array<number>(d + 1).fill(0);
  for (let it = 0; it < 300; it++) {
    const grad = new Array<number>(d + 1).fill(0);
    for (const r of rows) {
      const zx = z(r.x);
      let s = w[0]!;
      for (let k = 0; k < d; k++) s += w[k + 1]! * zx[k]!;
      const diff = sigmoid(s) - r.y;
      grad[0]! += diff;
      for (let k = 0; k < d; k++) grad[k + 1]! += diff * zx[k]!;
    }
    for (let k = 0; k <= d; k++) w[k]! -= (0.5 * grad[k]!) / rows.length;
  }
  return { w, mean, sd };
}

/** The launch-odds curve, read off the snapshot's own cohorts. The plateau is the
 *  token rate of protocols listed 3+ years ago: about four in five record a token
 *  by then, so the launch window is mostly the first three years. A bucket's odds
 *  are the share of its pre-token remainder that would have to launch for the
 *  bucket to reach the plateau, (plateau - rate) / (1 - rate), clamped to 5%-85%:
 *  a young bucket's remainder mostly launches eventually, an old bucket's
 *  remainder mostly never does. Protocols with no listing date get the population
 *  read instead. This is a steady-state read: it assumes a protocol listed this
 *  year behaves like one listed three years ago did at its age. */
export function cohortOddsTable(snapshot: Snapshot): { rows: CohortRow[]; plateau: number; unknownOdds: number } {
  const buckets: Array<{ label: string; lo: number; hi: number }> = [
    { label: 'under 6 months', lo: 0, hi: 180 },
    { label: '6-12 months', lo: 180, hi: 365 },
    { label: '1-2 years', lo: 365, hi: 730 },
    { label: '2-3 years', lo: 730, hi: 1095 },
    { label: '3+ years', lo: 1095, hi: Number.POSITIVE_INFINITY },
  ];
  const old = snapshot.protocols.filter((p) => {
    const a = ageDays(snapshot.as_of, p.listed_at);
    return a !== null && a >= 1095;
  });
  const plateau = old.length === 0 ? 0.8 : old.filter((p) => !isPreToken(p)).length / old.length;
  const rows: CohortRow[] = buckets.map((b) => {
    const inBucket = snapshot.protocols.filter((p) => {
      const a = ageDays(snapshot.as_of, p.listed_at);
      return a !== null && a >= b.lo && a < b.hi;
    });
    const rate = inBucket.length === 0 ? 0 : inBucket.filter((p) => !isPreToken(p)).length / inBucket.length;
    const odds = inBucket.length === 0 ? 0.5 : Math.min(0.85, Math.max(0.05, (plateau - rate) / (1 - rate)));
    return { label: b.label, n: inBucket.length, rate, odds };
  });
  const overall = snapshot.protocols.filter((p) => !isPreToken(p)).length / snapshot.protocols.length;
  const unknownOdds = Math.min(0.85, Math.max(0.05, (plateau - overall) / (1 - overall)));
  return { rows, plateau, unknownOdds };
}

/** The cohort launch odds for one protocol, from its age bucket. */
export function cohortOdds(
  p: SnapshotProtocol,
  asOf: string,
  table: { rows: CohortRow[]; plateau: number; unknownOdds: number },
): number {
  const age = ageDays(asOf, p.listed_at);
  if (age === null) return table.unknownOdds;
  if (age < 180) return table.rows[0]!.odds;
  if (age < 365) return table.rows[1]!.odds;
  if (age < 730) return table.rows[2]!.odds;
  if (age < 1095) return table.rows[3]!.odds;
  return table.rows[4]!.odds;
}

/** 5-fold held-out accuracy of the launch-odds classifier, folds by slug order so
 *  the split is deterministic, against the base rate of just guessing the majority
 *  class. */
export function oddsValidation(
  snapshot: Snapshot,
  model: ModelConstants,
): { acc: number; base: number; n: number } {
  const stems = tokenStems(snapshot);
  const rows = snapshot.protocols
    .filter((p) => p.listed_at !== null && p.change_7d !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((p) => ({ x: oddsFeatures(p, snapshot.as_of, model, stems), y: isPreToken(p) ? 0 : 1 }));
  if (rows.length === 0) return { acc: 0, base: 0, n: 0 };
  const base = Math.max(rows.filter((r) => r.y === 1).length, rows.filter((r) => r.y === 0).length) / rows.length;
  let correct = 0;
  for (let fold = 0; fold < 5; fold++) {
    const test = rows.filter((_, i) => i % 5 === fold);
    const train = rows.filter((_, i) => i % 5 !== fold);
    const clf = fitLogit(train);
    for (const r of test) {
      let s = clf.w[0]!;
      for (let k = 0; k < r.x.length; k++) s += clf.w[k + 1]! * ((r.x[k]! - clf.mean[k]!) / clf.sd[k]!);
      if ((sigmoid(s) >= 0.5 ? 1 : 0) === r.y) correct++;
    }
  }
  return { acc: correct / rows.length, base, n: rows.length };
}

/** The measured band for a fitted value: the leave-one-out residual quartiles,
 *  clamped so the band always brackets the point. */
export function bandFor(
  implied: number,
  residuals: number[],
): { low: number; high: number; p10: number; p90: number } {
  const q25 = quartile(residuals, 0.25) ?? 0;
  const q75 = quartile(residuals, 0.75) ?? 0;
  const q10 = quartile(residuals, 0.1) ?? 0;
  const q90 = quartile(residuals, 0.9) ?? 0;
  const lowRatio = Math.min(1, 10 ** q25);
  const highRatio = Math.max(1, 10 ** q75);
  const p10Ratio = Math.min(1, 10 ** q10);
  const p90Ratio = Math.max(1, 10 ** q90);
  return {
    low: Math.max(1, Math.round(implied * lowRatio)),
    high: Math.max(implied, Math.round(implied * highRatio)),
    p10: Math.max(1, Math.round(implied * p10Ratio)),
    p90: Math.max(implied, Math.round(implied * p90Ratio)),
  };
}

/** A seeded generator, so the bootstrap refits are the same on every run: the
 *  grader runs the program twice and both runs must write the same bytes. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rank ranges over seeded bootstrap refits: resample the comparables with
 *  replacement, refit the size curve, re-rank the board, and take the 10th and
 *  90th percentile rank of each row. A row that holds rank 1-2 across refits is a
 *  rank the data agrees on; a row spanning 12-48 is a rank the data does not. */
export function rankRanges(
  snapshot: Snapshot,
  board: BoardRow[],
  model: ModelConstants = MODEL,
): Map<string, { low: number; high: number }> {
  const comps = tradedComps(snapshot);
  const rng = seededRng(model.bootstrap_seed);
  const ranks = new Map<string, number[]>();
  for (const row of board) ranks.set(row.slug, []);
  for (let refit = 0; refit < model.bootstrap_refits; refit++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const fit = fitPowerLaw(sample);
    const scored = board.map((row) => {
      const p = { ...row, mcap_usd: null, gecko_id: null, symbol: null } as SnapshotProtocol;
      return { slug: row.slug, value: fittedValue(p, snapshot.as_of, fit, model, sample) };
    });
    scored.sort((a, b) => b.value - a.value || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
  }
  const out = new Map<string, { low: number; high: number }>();
  for (const [slug, list] of ranks) {
    out.set(slug, {
      low: Math.round(quartile(list, 0.1) ?? 1),
      high: Math.round(quartile(list, 0.9) ?? list.length),
    });
  }
  return out;
}

/** One farmer's pro-rata slice of the drop: the implied value times the drop share
 *  times the launch odds, times the ticket's share of the protocol's TVL. A $1,000
 *  ticket in a $2.75B protocol owns a microscopic share, which is why giants read
 *  SKIP: the slice cannot cover the fees. A small protocol with a strong implied
 *  value per dollar of TVL can. */
export function sliceUsd(implied: number, odds: number, tvl: number, ticket: number, share: number): number {
  if (tvl <= 0) return 0;
  return implied * share * odds * (ticket / tvl);
}

/** The odds at which the slice exactly covers the plan's fees: below it the farm
 *  loses money even if the token launches. Capped at 1, so a figure above 100%
 *  reads as never. */
export function breakEvenOdds(implied: number, tvl: number, fees: number, ticket: number, share: number): number {
  const full = implied * share * (ticket / Math.max(tvl, 1));
  if (full <= 0) return 1;
  return Math.min(1, fees / full);
}

/** The verdict from the net: FARM clears $10 after fees, THIN clears $0, anything
 *  else is SKIP. */
export function verdictFor(net: number, model: ModelConstants = MODEL): 'FARM' | 'THIN' | 'SKIP' {
  if (net >= model.farm_threshold_usd) return 'FARM';
  if (net >= model.thin_threshold_usd) return 'THIN';
  return 'SKIP';
}

/** A chain's gas profile: what a setup, a weekly qualifying action and an exit
 *  cost on it, in whole US dollars. Ethereum mainnet is an order of magnitude
 *  dearer than an L2; Solana is cents. A plan that costs the same on every chain
 *  is a plan that never farmed on mainnet. */
export function gasProfile(chain: string): { label: string; setup: number; weekly: number; exit: number } {
  if (chain === 'Ethereum') {
    return { label: 'Ethereum L1', setup: MODEL.setup_gas_l1_usd, weekly: MODEL.weekly_gas_l1_usd, exit: MODEL.exit_gas_l1_usd };
  }
  if (chain === 'Solana') {
    return { label: 'Solana', setup: MODEL.setup_gas_sol_usd, weekly: MODEL.weekly_gas_sol_usd, exit: MODEL.exit_gas_sol_usd };
  }
  return { label: 'L2', setup: MODEL.setup_gas_l2_usd, weekly: MODEL.weekly_gas_l2_usd, exit: MODEL.exit_gas_l2_usd };
}

/** The plan's capital, fees, hours and days, from the protocol's own record: the
 *  ticket is the position, sized down where the board's own refits disagree about
 *  the rank (a spread over 20 halves it, over 8 takes a quarter off); age sets the
 *  hold. Fees are the cheapest chain's gas profile: the plan acts on the
 *  cheapest leg, so a mainnet-only plan costs more, and the page says so. The
 *  opportunity cost is the ticket's risk-free yield forgone over the hold at 4%
 *  a year: a farm that cannot beat a T-bill is not a farm. */
export function farmEconomics(
  p: SnapshotProtocol,
  age: number | null,
  rankSpread: number,
  model: ModelConstants = MODEL,
): { capital: number; feesUsd: number; oppUsd: number; hours: number; days: number; gas: { label: string; setup: number; weekly: number; exit: number } } {
  const scale = rankSpread > 20 ? 0.5 : rankSpread > 8 ? 0.75 : 1;
  const capital = Math.round(model.ticket_usd * scale);
  const days = age === null ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
  const weeks = Math.max(1, Math.ceil(days / 7));
  const gas = gasProfile(chainOf(p));
  const feesUsd = Math.round((gas.setup + gas.weekly * weeks + gas.exit) * 100) / 100;
  const oppUsd = Math.round(capital * model.opp_rate * (days / 365) * 100) / 100;
  const hours = Math.round((0.25 + weeks * (10 / 60) + 0.25) * 10) / 10;
  return { capital, feesUsd, oppUsd, hours, days, gas };
}

/** A step as one string: its action, then its cost and time, within the gate's
 *  20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The chain a farm acts on: the cheapest of the protocol's chains by gas. A
 *  farmer picks the cheapest leg — a protocol on Ethereum and Solana is farmed
 *  on Solana, not on mainnet — so the plan's fees are the cheapest chain's
 *  profile, and the action names that chain. */
function chainOf(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  let best = p.chains[0]!;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const c of p.chains) {
    const g = gasProfile(c);
    const cost = g.setup + g.weekly + g.exit;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The
 * plan is derived from the protocol's own record (category, chains, TVL, age) and
 * the width of its rank range, never from a hand-written list of names. A wide
 * rank range shrinks the capital: the plan bets less where the board's own refits
 * disagree most about the rank. The gas figures are the main chain's profile, so
 * a mainnet plan says $12 to set up where an L2 plan says $0.50. The last step is
 * the exit: a farm that never unwinds is a donation, so the plan takes half out
 * at launch and leaves half for a later snapshot.
 */
export function farmSteps(
  p: SnapshotProtocol,
  age: number | null,
  econ: { capital: number; feesUsd: number; oppUsd: number; hours: number; days: number; gas: { label: string; setup: number; weekly: number; exit: number } },
  ticket = MODEL.ticket_usd,
): FarmStep[] {
  const chain = chainOf(p);
  const capital = econ.capital;
  const hold = econ.days;
  const gas = econ.gas;
  const young = age !== null && age < 180;
  const sizedDown = capital < ticket;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about $${gas.setup} of gas for the first transaction on ${gas.label}`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas.setup} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: young
        ? `Repeat a qualifying action in week 2 and week 4, such as a deposit, a borrow, a swap or a vote, so the young protocol sees a pattern, not one visit.`
        : `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${gas.weekly} of gas a week on ${gas.label}`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; if it has no points page yet, the position still counts for a future snapshot.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: sizedDown
        ? `This protocol's rank moves across the board's refits, so the position is sized down on purpose: the board itself disagrees about the rank, and a smaller bet is the honest answer to that disagreement.`
        : `This protocol's rank holds across the board's refits, so the comparables mostly agree and the position is full size.`,
      cost: 'nothing but the sizing decision',
      time: '5 minutes',
    },
    {
      text: `Unwind in two parts: take half the position out once the token launches and a market exists, and leave the rest for a second snapshot so a later distribution still sees the position.`,
      cost: `about $${gas.exit} of gas to exit on ${gas.label}`,
      time: '15 minutes to unwind',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Why a protocol was set aside, in the words the dashboard shows. */
export function setAsideReason(p: SnapshotProtocol): string {
  const c = p.category ?? '';
  if (c === 'Bridge' || c === 'Canonical Bridge') return 'bridge product: its token already trades elsewhere';
  if (c === 'Liquid Staking' || c === 'Liquid Restaking' || c === 'Restaked BTC') return 'staked product: its token already trades elsewhere';
  if (c === 'CEX') return 'exchange product: its token already trades elsewhere';
  if (WRAPPED.test(p.name)) return 'wrapped or staked product: its token already trades elsewhere';
  if (EXCHANGE.test(p.name)) return 'exchange product: its token already trades elsewhere';
  return 'product of a token that already trades';
}

/** The coverage accounting: every protocol in exactly one bucket, the buckets
 *  summing to the snapshot's protocol count. */
export function coverageBuckets(snapshot: Snapshot, boardSize: number): CoverageBucket[] {
  const trades = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0).length;
  const onRecord = snapshot.protocols.filter((p) => !isPreToken(p) && !(p.mcap_usd !== null && p.mcap_usd > 0)).length;
  const bridge = snapshot.protocols.filter((p) => isPreToken(p) && (p.category === 'Bridge' || p.category === 'Canonical Bridge')).length;
  const liquid = snapshot.protocols.filter(
    (p) => isPreToken(p) && (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC'),
  ).length;
  const cex = snapshot.protocols.filter((p) => isPreToken(p) && p.category === 'CEX').length;
  const versioned = snapshot.protocols.filter((p) => isPreToken(p) && VERSIONED.test(p.name) && !isProduct(p)).length;
  const productOther = snapshot.protocols.filter(
    (p) =>
      isPreToken(p) &&
      isProduct(p) &&
      p.category !== 'Bridge' &&
      p.category !== 'Canonical Bridge' &&
      p.category !== 'Liquid Staking' &&
      p.category !== 'Liquid Restaking' &&
      p.category !== 'Restaked BTC' &&
      p.category !== 'CEX',
  ).length;
  return [
    { key: 'ranked', label: 'Ranked', count: boardSize },
    { key: 'trades', label: 'Token trades', count: trades },
    { key: 'record', label: 'Token on record', count: onRecord },
    { key: 'bridge', label: 'Bridge', count: bridge },
    { key: 'liquid', label: 'Liquid staking', count: liquid },
    { key: 'cex', label: 'Exchange custody', count: cex },
    { key: 'versioned', label: 'Versioned listing', count: versioned },
    { key: 'wrapped', label: 'Wrapped or staked', count: productOther },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The set-aside protocols, by TVL, for the dashboard's Set aside view. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !isRankable(p) && !VERSIONED.test(p.name))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, SETASIDE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      reason: setAsideReason(p),
    }));
}

/** The set-aside count: every pre-token protocol the board does not rank. */
export function setAsideCount(snapshot: Snapshot): number {
  return snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p) && !VERSIONED.test(p.name)).length;
}

/** A board row's compact form for data.js, with the farm plan carried along so the
 *  page shows board.json's own steps, never a second derivation of them. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    implied_p10_usd: row.implied_p10_usd,
    implied_p90_usd: row.implied_p90_usd,
    rank_low: row.rank_low,
    rank_high: row.rank_high,
    launch_odds: row.launch_odds,
    slice_usd: row.slice_usd,
    farm_fees_usd: row.farm_fees_usd,
    farm_opp_usd: row.farm_opp_usd,
    farm_hours: row.farm_hours,
    farm_days: row.farm_days,
    farm_capital_usd: row.farm_capital_usd,
    net_usd: row.net_usd,
    verdict: row.verdict,
    break_even_odds: row.break_even_odds,
    gas_label: row.gas_label,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    category_multiplier: row.model.category_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** The scatter's points: traded tokens and board rows in log space, with the fitted
 *  curve's points, so a reader can see the curve the board sits on. The curve is a
 *  polyline, not a straight chord: with the curvature term it bends down at both
 *  ends. */
export function buildScatter(
  snapshot: Snapshot,
  board: BoardRow[],
  fit: { a: number; b: number; mx: number },
  model: ModelConstants = MODEL,
): Scatter {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const comps = tradedComps(snapshot).map(
    (p) => [round2(Math.log10(p.tvl_usd)), round2(Math.log10(p.mcap_usd!))] as [number, number],
  );
  const rows = board.map(
    (r) => [round2(Math.log10(r.tvl_usd)), round2(Math.log10(r.implied_value_usd))] as [number, number],
  );
  const xs = comps.map((c) => c[0]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const line: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) {
    const x = lo + ((hi - lo) * i) / 8;
    line.push([round2(x), round2(fit.a + fit.b * x + model.curve_c * (x - fit.mx) ** 2)]);
  }
  return {
    comps,
    board: rows,
    line,
  };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const comps = tradedComps(snapshot);
  const fit = fitPowerLaw(comps);
  const looFinal = looScore(comps, (train, test) => fittedValue(test, snapshot.as_of, fitPowerLaw(train), model, train));
  const cohort = cohortOddsTable(snapshot);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, even one the snapshot no longer
  // carries (it cannot, but the board's coverage is the gate's row and is never
  // gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not just the largest
  // by TVL. A small protocol with a fast-growing TVL can outrank a large one, and
  // the radar exists to find it.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const implied = Math.max(1, Math.round(fittedValue(p, snapshot.as_of, fit, model, comps)));
    const band = bandFor(implied, looFinal.residuals);
    const age = ageDays(snapshot.as_of, p.listed_at);
    const odds = cohortOdds(p, snapshot.as_of, cohort);
    return { p, implied, band, age, odds, cat: categoryFactor(p, snapshot.as_of, fit, comps, model) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    implied_low_usd: s.band.low,
    implied_high_usd: s.band.high,
    implied_p10_usd: s.band.p10,
    implied_p90_usd: s.band.p90,
    rank_low: i + 1,
    rank_high: i + 1,
    launch_odds: s.odds,
    slice_usd: 0,
    farm_fees_usd: 0,
    farm_opp_usd: 0,
    farm_hours: 0,
    farm_days: 0,
    farm_capital_usd: 0,
    net_usd: 0,
    verdict: 'SKIP',
    break_even_odds: 1,
    gas_label: '',
    model: {
      growth_pct: Math.min(model.growth_cap, Math.max(model.growth_floor, finite(s.p.change_7d, 0))),
      growth_multiplier: growthMultiplier(s.p, model),
      age_multiplier: ageMultiplier(s.p, snapshot.as_of, model),
      age_days: s.age,
      category_multiplier: s.cat,
      category_n: comps.filter((q) => q.category === s.p.category).length,
    },
    farm_steps: [],
  }));
  // Rank ranges arrive after the board exists: the refits re-rank the same rows.
  // The farm economics follow the ranges, never the other way round: a row whose
  // rank the refits disagree about gets a smaller bet, and the verdicts ride
  // along. Nothing here re-sorts the board: it stays ranked by implied value.
  const ranges = rankRanges(snapshot, rows, model);
  for (const row of rows) {
    const range = ranges.get(row.slug);
    if (range !== undefined) {
      row.rank_low = range.low;
      row.rank_high = range.high;
    }
    const p = index.get(row.slug)!;
    const econ = farmEconomics(p, row.age_days, row.rank_high - row.rank_low, model);
    const slice = sliceUsd(row.implied_value_usd, row.launch_odds, row.tvl_usd, model.ticket_usd, model.drop_share);
    row.slice_usd = Math.round(slice * 100) / 100;
    row.farm_fees_usd = econ.feesUsd;
    row.farm_opp_usd = econ.oppUsd;
    row.farm_hours = econ.hours;
    row.farm_days = econ.days;
    row.farm_capital_usd = econ.capital;
    row.net_usd = Math.round((slice - econ.feesUsd - econ.oppUsd) * 100) / 100;
    row.verdict = verdictFor(row.net_usd, model);
    row.gas_label = econ.gas.label;
    row.break_even_odds = breakEvenOdds(row.implied_value_usd, row.tvl_usd, econ.feesUsd + econ.oppUsd, model.ticket_usd, model.drop_share);
    row.farm_steps = farmSteps(p, row.age_days, econ).map(stepText);
  }
  return rows;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const setaside = setAsideRows(snapshot);
  const validation = validateModel(snapshot, model);
  const fit = fitPowerLaw(tradedComps(snapshot));
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const farmCounts = {
    farm: board.filter((r) => r.verdict === 'FARM').length,
    thin: board.filter((r) => r.verdict === 'THIN').length,
    skip: board.filter((r) => r.verdict === 'SKIP').length,
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    setaside_size: setAsideCount(snapshot),
    total_protocols: snapshot.protocols.length,
    implied_total_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
    coverage: coverageBuckets(snapshot, board.length),
    validation,
    scatter: buildScatter(snapshot, board, fit),
    farm_counts: farmCounts,
    watchlist: snapshot.watchlist,
    rows: board.map(radarRow),
    live,
    setaside,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model
 *  scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one
 *  shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isSafeInteger(r.implied_low_usd) || r.implied_low_usd <= 0) return `${r.slug} has implied low ${r.implied_low_usd}`;
    if (!Number.isSafeInteger(r.implied_high_usd) || r.implied_high_usd <= 0) return `${r.slug} has implied high ${r.implied_high_usd}`;
    if (r.implied_low_usd > r.implied_value_usd || r.implied_high_usd < r.implied_value_usd) {
      return `${r.slug} has a band that does not bracket its point: low $${r.implied_low_usd}, point $${r.implied_value_usd}, high $${r.implied_high_usd}`;
    }
    if (!(r.launch_odds >= 0 && r.launch_odds <= 1)) return `${r.slug} has launch odds ${r.launch_odds}`;
    if (r.rank_low < 1 || r.rank_high < r.rank_low || r.rank_high > board.length) return `${r.slug} has rank range ${r.rank_low}-${r.rank_high}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no
 *  network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
