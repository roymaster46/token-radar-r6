// Token Radar — the dashboard. Reads window.RADAR (written by main.ts from the
// sealed snapshot), renders the board, and recomputes the farm economics
// client-side when the ticket, the drop share or the T-bill yield changes. No
// fetch, no network: every figure on the page comes from the dataset beside it.

const R = window.RADAR;
const M = R.model;

/** Escape text for HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** $2.76B, $68.6M, $1.15 — short money for the table. */
function money(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/** $68,600,000 — full money for the detail view. */
function moneyFull(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** +2.4%, -8.3%, — when null. */
function pct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
}

/** 73d, 1.1y, — when null. */
function ageFmt(days) {
  if (days === null || days === undefined) return '—';
  if (days < 365) return `${days}d`;
  return `${(days / 365).toFixed(1)}y`;
}

/** 0.66 -> 66%. */
function oddsFmt(o) {
  return `${Math.round(o * 100)}%`;
}

/** The farm economics of one row at the current ticket and drop share. Fees are
 *  gas, so they do not move with the ticket; the slice and the forgone yield do. */
function economics(row) {
  const ticket = state.ticket;
  const drop = state.drop;
  const slice = row.implied_value_usd * drop * row.launch_odds * (ticket / Math.max(row.tvl_usd, 1));
  const capital = row.farm_capital_usd * (ticket / M.ticket_usd);
  const opp = capital * M.opp_rate * (row.farm_days / 365);
  const fees = row.farm_fees_usd;
  const net = slice - fees - opp;
  const verdict = net >= M.farm_threshold_usd ? 'FARM' : net >= M.thin_threshold_usd ? 'THIN' : 'SKIP';
  return { slice, capital, opp, fees, net, verdict, hours: row.farm_hours, days: row.farm_days };
}

/** The page's state: filters, sorting, and the farm inputs. */
const state = {
  tab: 'pre',
  sortKey: 'rank',
  sortDir: 1,
  search: '',
  category: '',
  chain: '',
  verdict: '',
  watchlistOnly: false,
  ticket: 1000,
  drop: 0.07,
  tbill: 0.04,
  selected: null,
};

/** Distinct categories and chains on the board, for the filter selects. */
const categories = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();

/** The rows the board shows, after filters and sorting. */
function visibleRows() {
  const q = state.search.trim().toLowerCase();
  let rows = R.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.category ?? '').toLowerCase().includes(q))) return false;
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.watchlistOnly && !R.watchlist.includes(r.slug)) return false;
    if (state.verdict) {
      if (economics(r).verdict !== state.verdict) return false;
    }
    return true;
  });
  const key = state.sortKey;
  const dir = state.sortDir;
  const val = (r) => {
    const e = economics(r);
    switch (key) {
      case 'rank': return r.rank;
      case 'name': return r.name.toLowerCase();
      case 'tvl': return r.tvl_usd;
      case 'change': return r.change_7d ?? -Infinity;
      case 'age': return r.age_days ?? -1;
      case 'odds': return r.launch_odds;
      case 'implied': return r.implied_value_usd;
      case 'slice': return e.slice;
      case 'net': return e.net;
      case 'verdict': return e.verdict;
      default: return r.rank;
    }
  };
  rows = [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.rank - b.rank;
  });
  return rows;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

/** The masthead: title, snapshot date, source, model. */
function renderMasthead() {
  const sourceName = R.source.split(',')[0].replace(/https?:\/\/\S+/, '').trim() || 'DefiLlama';
  return el(`<header class="masthead">
    <h1><span class="dot">●</span> Token Radar</h1>
    <div class="source">
      <span>Snapshot <b>${esc(R.as_of)}</b></span>
      <span>${esc(sourceName)} protocol index</span>
      <span>model <b>${esc(R.model_version)}</b></span>
    </div>
  </header>`);
}

/** Six stat cards: coverage, value, held-out miss, band hold, odds, farming. */
function renderStats() {
  const v = R.validation;
  const top = R.rows[0];
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of R.rows) counts[economics(r).verdict]++;
  return el(`<section class="stats" aria-label="Headline figures">
    <div class="stat"><div class="label">Ranked</div><div class="value">${R.board_size}</div>
      <div class="note">${R.watchlist_size}/${R.watchlist_size} watchlist covered</div></div>
    <div class="stat"><div class="label">Implied value</div><div class="value">${money(R.implied_total_usd)}</div>
      <div class="note">rank 1 ${esc(top.name)} ${money(top.implied_value_usd)}</div></div>
    <div class="stat"><div class="label">Out-of-sample miss</div><div class="value">x${v.loo_final_med.toFixed(2)}</div>
      <div class="note">flat x${v.loo_flat_med.toFixed(2)} · walk-forward x${v.wf_final_med.toFixed(2)}</div></div>
    <div class="stat"><div class="label">Range holds</div><div class="value">${Math.round(v.band_p2575 * 100)}%</div>
      <div class="note">P25–P75 holds ${Math.round(v.band_p2575 * 100)}% · P10–P90 ${Math.round(v.band_p1090 * 100)}%</div></div>
    <div class="stat"><div class="label">Token-or-not</div><div class="value">${Math.round(v.odds_acc * 100)}%</div>
      <div class="note">held out · base rate ${Math.round(v.odds_base * 100)}%</div></div>
    <div class="stat"><div class="label">Worth farming</div><div class="value emerald">${counts.FARM} FARM</div>
      <div class="note">${counts.THIN} THIN · ${counts.SKIP} SKIP at $${state.ticket.toLocaleString('en-US')}, ${Math.round(state.drop * 100)}%</div></div>
  </section>`);
}

/** The coverage bar: every protocol in exactly one bucket. */
function renderCoverage() {
  const total = R.total_protocols;
  const colors = {
    ranked: '#0e7c5a', trades: '#2f6fb2', record: '#8a94a6', bridge: '#d97706',
    liquid: '#7c3aed', cex: '#dc2626', versioned: '#0d9488', wrapped: '#65a30d',
  };
  const segs = R.coverage.map((b) => `<i class="b-${b.key}" style="width:${(b.count / total * 100).toFixed(2)}%"></i>`).join('');
  const items = R.coverage.map((b) =>
    `<li style="--sw:${colors[b.key]}">${b.label} <b>${b.count}</b></li>`).join('');
  return el(`<section class="coverage">
    <p><b>${total} protocols read</b> · every one accounted for, ranked or set aside for one reason</p>
    <div class="bar" role="img" aria-label="Coverage: ${R.coverage.map((b) => `${b.label} ${b.count}`).join(', ')}">${segs}</div>
    <ul class="legend">${items}</ul>
  </section>`);
}

/** The farm-next strip: the three best FARM rows by net, with net per hour. */
function renderFarmNext() {
  const farms = R.rows.map((r) => ({ r, e: economics(r) }))
    .filter((x) => x.e.verdict === 'FARM')
    .sort((a, b) => b.e.net - a.e.net)
    .slice(0, 3);
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of R.rows) counts[economics(r).verdict]++;
  const items = farms.map((x) =>
    `<span><b>${esc(x.r.name)}</b> +${money(x.e.net)} · ${money(x.e.net / Math.max(x.e.hours, 0.1))}/h</span>`).join('<span class="sep">·</span>');
  return el(`<section class="farmnext">
    <b>Farm next:</b> ${items || 'no row clears the bar at this ticket'}
    <span class="sep">—</span> ${counts.FARM} FARM, ${counts.THIN} THIN, ${counts.SKIP} SKIP at $${state.ticket.toLocaleString('en-US')}, ${Math.round(state.drop * 100)}%, ${(state.tbill * 100).toFixed(0)}% T-bill
  </section>`);
}

/** The filter bar: search, category, chain, verdict, watchlist, tabs, and the
 *  farm inputs (ticket, drop share, T-bill). */
function renderFilters() {
  const wrap = el(`<section class="filters" aria-label="Filters">
    <label>Search <input type="search" id="f-search" placeholder="Search the board" value="${esc(state.search)}"></label>
    <label>Category <select id="f-category">
      <option value="">All categories</option>
      ${categories.map((c) => `<option value="${esc(c)}"${state.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
    </select></label>
    <label>Chain <select id="f-chain">
      <option value="">All chains</option>
      ${chains.map((c) => `<option value="${esc(c)}"${state.chain === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
    </select></label>
    <label>Verdict <select id="f-verdict">
      <option value="">Any verdict</option>
      ${['FARM', 'THIN', 'SKIP'].map((v) => `<option${state.verdict === v ? ' selected' : ''}>${v}</option>`).join('')}
    </select></label>
    <label class="check"><input type="checkbox" id="f-watchlist"${state.watchlistOnly ? ' checked' : ''}> Watchlist</label>
    <div class="tabs" role="group" aria-label="Token status">
      <button type="button" data-tab="pre" aria-pressed="${state.tab === 'pre'}">Pre-token</button>
      <button type="button" data-tab="live" aria-pressed="${state.tab === 'live'}">Live token</button>
      <button type="button" data-tab="setaside" aria-pressed="${state.tab === 'setaside'}">Set aside</button>
    </div>
    <label>Deposit <select id="f-ticket">
      ${[250, 500, 1000, 2500, 5000].map((t) => `<option value="${t}"${state.ticket === t ? ' selected' : ''}>$${t.toLocaleString('en-US')}</option>`).join('')}
    </select></label>
    <label>Drop share <select id="f-drop">
      ${[0.03, 0.05, 0.07, 0.1].map((d) => `<option value="${d}"${state.drop === d ? ' selected' : ''}>${Math.round(d * 100)}%</option>`).join('')}
    </select></label>
    <label>T-bill yield <select id="f-tbill">
      ${[0.02, 0.04, 0.06].map((y) => `<option value="${y}"${state.tbill === y ? ' selected' : ''}>${Math.round(y * 100)}%</option>`).join('')}
    </select></label>
  </section>`);

  wrap.querySelector('#f-search').addEventListener('input', (e) => { state.search = e.target.value; renderBoard(); });
  wrap.querySelector('#f-category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
  wrap.querySelector('#f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  wrap.querySelector('#f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  wrap.querySelector('#f-watchlist').addEventListener('change', (e) => { state.watchlistOnly = e.target.checked; renderBoard(); });
  wrap.querySelector('#f-ticket').addEventListener('change', (e) => { state.ticket = Number(e.target.value); renderAll(); });
  wrap.querySelector('#f-drop').addEventListener('change', (e) => { state.drop = Number(e.target.value); renderAll(); });
  wrap.querySelector('#f-tbill').addEventListener('change', (e) => { state.tbill = Number(e.target.value); renderBoard(); });
  wrap.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    wrap.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderBoard();
  }));
  return wrap;
}

/** One board row: rank and range, protocol, TVL, growth, age, odds, implied
 *  value with its band, slice, net, verdict. */
function rowHtml(r) {
  const e = economics(r);
  const onWatch = R.watchlist.includes(r.slug);
  const range = r.rank_low === r.rank_high ? `holds ${r.rank_low}` : `${r.rank_low}–${r.rank_high}`;
  const maxImp = R.rows[0].implied_value_usd;
  const barPct = Math.max(2, Math.round((r.implied_value_usd / maxImp) * 100));
  const netCls = e.net >= 0 ? 'net-pos' : 'net-neg';
  return `<tr data-slug="${esc(r.slug)}" tabindex="0">
    <td class="num"><b>${r.rank}</b><br><span class="sub">${range}</span></td>
    <td><span class="name">${esc(r.name)}</span><br><span class="sub">${esc(r.category ?? 'Uncategorised')} on ${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ', +' + (r.chains.length - 2) : ''}</span>${onWatch ? '<br><span class="watch">Watchlist</span>' : ''}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
    <td class="num">${ageFmt(r.age_days)}</td>
    <td class="num">${oddsFmt(r.launch_odds)}</td>
    <td><span class="imp">${money(r.implied_value_usd)}<span class="band">${money(r.implied_low_usd)} – ${money(r.implied_high_usd)}</span></span><span class="impbar"><i style="width:${barPct}%"></i></span></td>
    <td class="num">${money(e.slice)}</td>
    <td class="num ${netCls}">${e.net >= 0 ? '+' : ''}${money(e.net)}</td>
    <td><span class="pill ${e.verdict.toLowerCase()}">${e.verdict}</span></td>
  </tr>`;
}

const SORT_COLS = [
  ['rank', 'Rank'],
  ['name', 'Protocol'],
  ['tvl', 'TVL'],
  ['change', '7d'],
  ['age', 'No token'],
  ['odds', 'Odds'],
  ['implied', 'Implied value'],
  ['slice', 'Slice'],
  ['net', 'Net'],
  ['verdict', 'Verdict'],
];

/** The board panel: the count line, the sortable table, and the row click that
 *  opens the detail view. */
function renderBoardPanel() {
  const panel = el(`<section class="panel" aria-label="Board"><div class="panel-body"></div></section>`);
  renderBoardInto(panel.querySelector('.panel-body'));
  return panel;
}

function renderBoardInto(body) {
  if (state.tab === 'live') {
    body.innerHTML = `<div class="panel-head"><b>${R.live.length} live tokens</b> · the traded comparables, largest first — the curve is fitted on these, not on the board.</div>
    <table class="board"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">7d</th></tr></thead>
    <tbody>${R.live.map((p) => `<tr><td><span class="name">${esc(p.name)}</span><br><span class="sub">${esc(p.chains.slice(0, 2).join(', '))}</span></td><td>${esc(p.category ?? '—')}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td><td class="num ${p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down'}">${pct(p.change_7d)}</td></tr>`).join('')}</tbody></table>`;
    return;
  }
  if (state.tab === 'setaside') {
    body.innerHTML = `<div class="panel-head"><b>${R.setaside_size} set aside</b> · pre-token protocols the board does not rank, largest first — each one for a stated reason.</div>
    <table class="board"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th>Reason</th></tr></thead>
    <tbody>${R.setaside.map((p) => `<tr><td><span class="name">${esc(p.name)}</span><br><span class="sub">${esc(p.chains.slice(0, 2).join(', '))}</span></td><td>${esc(p.category ?? '—')}</td><td class="num">${money(p.tvl_usd)}</td><td>${esc(p.reason)}</td></tr>`).join('')}</tbody></table>`;
    return;
  }
  const rows = visibleRows();
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of R.rows) counts[economics(r).verdict]++;
  const head = SORT_COLS.map(([k, label]) => {
    const arrow = state.sortKey === k ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
    const num = ['rank', 'tvl', 'change', 'age', 'odds', 'implied', 'slice', 'net'].includes(k) ? ' class="num"' : '';
    return `<th${num}><button type="button" data-sort="${k}">${label}${arrow}</button></th>`;
  }).join('');
  body.innerHTML = `<div class="panel-head"><b>${rows.length} rows shown</b> · ${counts.FARM} FARM, ${counts.THIN} THIN, ${counts.SKIP} SKIP at $${state.ticket.toLocaleString('en-US')}, ${Math.round(state.drop * 100)}%. Pre-token protocols, strongest implied value first. Select a row for its model, its odds and its farm plan.</div>
  <table class="board"><thead><tr>${head}</tr></thead>
  <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="10"><div class="empty">No rows match these filters.</div></td></tr>`}</tbody></table>`;
  body.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = k === 'name' ? 1 : -1; }
    renderBoard();
  }));
  body.querySelectorAll('tr[data-slug]').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(tr.dataset.slug); } });
  });
}

/** Re-render the board panel in place (filters and sorting). */
function renderBoard() {
  const body = document.querySelector('.panel .panel-body');
  if (body) renderBoardInto(body);
  const stats = document.querySelector('.stats');
  if (stats) stats.replaceWith(renderStats());
  const farm = document.querySelector('.farmnext');
  if (farm) farm.replaceWith(renderFarmNext());
}

/** Re-render everything (the farm inputs moved). */
function renderAll() {
  document.querySelector('main').replaceChildren(
    renderMasthead(), renderStats(), renderCoverage(), renderFarmNext(), renderFilters(),
    layoutEl(),
  );
  document.querySelector('main').setAttribute('aria-busy', 'false');
}

/** The two-column layout: board on the left, method on the right. */
function layoutEl() {
  const div = el(`<div class="layout"></div>`);
  div.append(renderBoardPanel(), renderMethod());
  return div;
}

/** The detail view: one protocol's value build, its odds, its farm economics and
 *  its eight-step plan. Opened from a board row. */
let dialog = null;

function openDetail(slug) {
  const row = R.rows.find((r) => r.slug === slug);
  if (!row) return;
  state.selected = slug;
  const e = economics(row);
  const v = R.validation;
  const cohort = v.cohort;
  const bucket = row.age_days === null ? null
    : row.age_days < 180 ? cohort[0] : row.age_days < 365 ? cohort[1]
    : row.age_days < 730 ? cohort[2] : row.age_days < 1095 ? cohort[3] : cohort[4];
  const gasLabel = row.gas_label || 'L2';
  const verdictWord = e.verdict === 'FARM' ? 'Farm now — clears the bar'
    : e.verdict === 'THIN' ? 'Watch — clears zero, not the bar' : 'Skip — loses money';
  if (!dialog) {
    dialog = el(`<dialog class="detail" aria-label="Protocol detail"></dialog>`);
    document.body.append(dialog);
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  }
  dialog.innerHTML = `
  <div class="d-head">
    <div>
      <div class="rankline">Rank ${row.rank} of ${R.board_size} · holds ${row.rank_low}–${row.rank_high} over ${M.bootstrap_refits} refits</div>
      <h2>${esc(row.name)}</h2>
      <div class="sub">${esc(row.category ?? 'Uncategorised')} on ${esc(row.chains.join(', '))}${R.watchlist.includes(row.slug) ? ' · Watchlist' : ''}</div>
    </div>
    <button type="button" class="close">Close</button>
  </div>
  <section>
    <h3>Implied value — one function scores every row</h3>
    <dl class="kv">
      <dt>TVL</dt><dd>${moneyFull(row.tvl_usd)}</dd>
      <dt>Size curve</dt><dd>${money(row.implied_value_usd / row.growth_multiplier / row.age_multiplier / row.category_multiplier)}</dd>
      <dt>Seven-day growth</dt><dd>${pct(row.change_7d)}</dd>
      <dt>Growth multiplier</dt><dd>${row.growth_multiplier.toFixed(3)}x</dd>
      <dt>Age with no token</dt><dd>${ageFmt(row.age_days)}</dd>
      <dt>Age multiplier</dt><dd>${row.age_multiplier.toFixed(3)}x</dd>
      <dt>Category (${esc(row.category ?? 'Other')})</dt><dd>${row.category_multiplier.toFixed(2)}x</dd>
      <dt>Implied value</dt><dd>${moneyFull(row.implied_value_usd)}</dd>
      <dt>Plausible range (P25–P75)</dt><dd>${money(row.implied_low_usd)} – ${money(row.implied_high_usd)}</dd>
      <dt>Rank over ${M.bootstrap_refits} refits</dt><dd>${row.rank_low}–${row.rank_high}</dd>
    </dl>
    <p class="note">Model ${esc(R.model_version)}: log10(market cap) = ${v.fit_a.toFixed(3)} + ${v.fit_b.toFixed(3)} × log10(TVL) ${v.curve_c} × (log10(TVL) − ${v.fit_mx.toFixed(2)})², fitted on ${v.n_comps} traded tokens. Held out, the typical miss is x${v.loo_final_med.toFixed(2)} and ${Math.round(v.loo_final_within3 * 100)}% land within 3x. This is an estimate, not a price.</p>
  </section>
  <section>
    <h3>Launch odds — the cohort read</h3>
    <dl class="kv">
      <dt>Launch odds</dt><dd>${oddsFmt(row.launch_odds)}</dd>
      <dt>Cohort</dt><dd>${bucket ? `${bucket.label} · ${bucket.n} protocols` : 'no listing date'}</dd>
      <dt>Cohort token rate</dt><dd>${bucket ? `${Math.round(bucket.rate * 100)}% record a token` : '—'}</dd>
      <dt>Plateau (3+ years)</dt><dd>${Math.round(v.cohort_plateau * 100)}% record a token</dd>
    </dl>
    <p class="note">Odds are the share of this age cohort's pre-token remainder that would have to launch for the cohort to reach the 3+ year plateau. A classifier on size, age, growth and name kinship — whether another protocol with the same name stem already has a token — calls token-or-not at ${Math.round(v.odds_acc * 100)}% held out, against ${Math.round(v.odds_base * 100)}% for guessing the majority — the features carry signal, but the odds are a cohort read, not a forecast.</p>
  </section>
  <section>
    <h3>Farm economics — at $${state.ticket.toLocaleString('en-US')} and ${Math.round(state.drop * 100)}% to farmers</h3>
    <dl class="kv">
      <dt>Slice if it launches</dt><dd>${money(e.slice)}</dd>
      <dt>Plan fees (${gasLabel} rates)</dt><dd>${money(e.fees)}</dd>
      <dt>Yield forgone (${row.farm_days}d at ${(state.tbill * 100).toFixed(0)}%)</dt><dd>${money(e.opp)}</dd>
      <dt>Hours</dt><dd>${e.hours}h over ${e.days}d</dd>
      <dt>Net</dt><dd>${e.net >= 0 ? '+' : ''}${money(e.net)} · ${money(e.net / Math.max(e.hours, 0.1))}/h</dd>
      <dt>Break-even odds</dt><dd>${row.break_even_odds >= 1 ? '>100% — never' : `${Math.round(row.break_even_odds * 100)}%`}</dd>
      <dt>Verdict</dt><dd>${e.verdict} — ${verdictWord}</dd>
    </dl>
    <p class="note">Slice = implied × ${Math.round(state.drop * 100)}% × odds × ($${state.ticket.toLocaleString('en-US')} ÷ TVL). A big TVL thins the slice, so the best farms are small and young. Fees are ${gasLabel} rates; a mainnet-only plan costs more.</p>
  </section>
  <section>
    <h3>Farm plan — eight steps</h3>
    <ol class="steps">${row.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  </section>`;
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.showModal();
}

/** The method panel: the formula, the ablation table, the dropped terms, the
 *  category factors, the cohort table, the gas profiles, and the scatter. */
function renderMethod() {
  const v = R.validation;
  const formula = `implied = 10^${v.fit_a.toFixed(3)} × TVL^${v.fit_b.toFixed(3)} × 10^(${v.curve_c} × (log10 TVL − ${v.fit_mx.toFixed(2)})²) × (1 + 0.25 × log1p(growth)) × 10^(-0.05 × log10(age / 365)) × category`;
  const rows = [
    ['Flat TVL multiple', v.loo_flat_med, v.loo_flat_within3, v.rank_flat, v.wf_flat_med, false, false],
    ['+ size curve (log-log fit)', v.loo_size_med, v.loo_size_within3, v.rank_size, v.wf_size_med, false, false],
    ['+ curvature on the size curve', v.loo_curve_med, v.loo_curve_within3, v.rank_curve, v.wf_curve_med, false, false],
    ['+ 7-day growth, linear', v.loo_growth_lin_med, v.loo_growth_lin_within3, v.rank_growth_lin, v.wf_growth_lin_med, false, true],
    ['+ 7-day growth, concave', v.loo_growth_conc_med, v.loo_growth_conc_within3, v.rank_growth_conc, v.wf_growth_conc_med, false, false],
    ['+ listing age', v.loo_age_med, v.loo_age_within3, v.rank_age, v.wf_age_med, false, false],
    ['+ concentration (single-chain penalty)', v.loo_conc_med, v.loo_conc_within3, v.rank_conc, v.wf_conc_med, false, true],
    ['+ category, shrunk — final model', v.loo_final_med, v.loo_final_within3, v.rank_final, v.wf_final_med, true, false],
    ['Tried: + concentration, with category', v.loo_conc_cat_med, v.loo_conc_cat_within3, null, v.wf_conc_cat_med, false, true],
    ['Tried: uniform 0.80 discount', v.loo_discount_med, v.loo_discount_within3, null, v.wf_discount_med, false, true],
    ['Tried: chain-count bonus', v.loo_chains_med, v.loo_chains_within3, null, v.wf_chains_med, false, true],
    ['Tried: coarse sector grouping', v.loo_coarse_med, v.loo_coarse_within3, null, v.wf_coarse_med, false, true],
    ['Tried: free quadratic', v.loo_quadols_med, v.loo_quadols_within3, null, v.wf_quadols_med, false, true],
  ];
  const ablation = rows.map(([label, loo, within3, rho, wf, final, dropped]) =>
    `<tr${final ? ' class="final"' : dropped ? ' class="dropped"' : ''}><td>${label}</td><td>x${loo.toFixed(2)}</td><td>${Math.round(within3 * 100)}%</td><td>${rho === null ? '—' : rho.toFixed(2)}</td><td>x${wf.toFixed(2)}</td></tr>`).join('');
  const factors = v.category_factors.map((f) =>
    `<li>${esc(f.category)} <b>×${f.factor.toFixed(2)}</b> (n=${f.n})</li>`).join('');
  const cohortRows = v.cohort.map((c) =>
    `<tr><td>${c.label}</td><td>${c.n}</td><td>${Math.round(c.rate * 100)}%</td><td>${Math.round(c.odds * 100)}%</td></tr>`).join('');
  const panel = el(`<aside class="panel method" aria-label="Method">
    <h2>How a value is built — impliedValue()</h2>
    <div class="formula">${formula}</div>
    <p>A power-law size curve, fitted on the ${v.n_comps} traded tokens (R² ${v.fit_r2.toFixed(2)}, ${v.fit_r2_final.toFixed(2)} with the category term): the market pays less per dollar of TVL as TVL grows, so a flat multiple overprices giants fivefold. The curve bends down at both ends by ${v.curve_c} × (log10 TVL − ${v.fit_mx.toFixed(2)})², which wins both held-out tests. Growth is winsorised to [−50%, +200%] and mapped concavely, so one spike week cannot dominate a value. Age is a mild negative: a protocol that has waited years without a token prices lower than a young one at the same TVL — the cohort read says the same. Category is the shrunk median of the category's own residuals, prior ${v.cat_prior}, at least ${v.cat_min_n} traded tokens: ${v.category_factors.length ? `${esc(v.category_factors[0].category)} ×${v.category_factors[0].factor.toFixed(2)} down to ${esc(v.category_factors[v.category_factors.length - 1].category)} ×${v.category_factors[v.category_factors.length - 1].factor.toFixed(2)}` : 'no category with enough peers'}.</p>
    <h3>Model</h3>
    <table class="mini"><thead><tr><th></th><th>LOO</th><th>≤3x</th><th>ρ</th><th>WF</th></tr></thead><tbody>${ablation}</tbody></table>
    <p>Tried and dropped: a concentration penalty for single-chain books (LOO x${v.loo_conc_cat_med.toFixed(2)}, WF x${v.wf_conc_cat_med.toFixed(2)} — it helps walk-forward and hurts leave-one-out, so it stays out), a uniform 0.80 discount (LOO x${v.loo_discount_med.toFixed(2)}, WF x${v.wf_discount_med.toFixed(2)}), a chain-count bonus (LOO x${v.loo_chains_med.toFixed(2)}, WF x${v.wf_chains_med.toFixed(2)}), a coarse sector grouping (LOO x${v.loo_coarse_med.toFixed(2)}, WF x${v.wf_coarse_med.toFixed(2)}) and a free quadratic whose curvature is fitted, not fixed (LOO x${v.loo_quadols_med.toFixed(2)}, WF x${v.wf_quadols_med.toFixed(2)}) — none beats the final model on both tests. A term joins only when it wins both. Walk-forward fits on the older half and prices the newer half.</p>
    <h3>Category factors</h3>
    <ul class="factors">${factors}</ul>
    <h3>Launch odds by age cohort</h3>
    <table class="mini"><thead><tr><th>Cohort</th><th>n</th><th>Token rate</th><th>Odds</th></tr></thead><tbody>${cohortRows}</tbody></table>
    <p>Plateau ${Math.round(v.cohort_plateau * 100)}%: about four in five protocols record a token by three years. A bucket's odds are the share of its pre-token remainder that would have to launch to reach the plateau.</p>
    <h3>Gas by chain</h3>
    <p>Setup / weekly / exit — Ethereum L1 $${M.setup_gas_l1_usd} / $${M.weekly_gas_l1_usd} / $${M.exit_gas_l1_usd}; L2 $${M.setup_gas_l2_usd} / $${M.weekly_gas_l2_usd} / $${M.exit_gas_l2_usd}; Solana $${M.setup_gas_sol_usd} / $${M.weekly_gas_sol_usd} / $${M.exit_gas_sol_usd}. A plan acts on the protocol's cheapest chain — a farmer picks the cheapest leg, so a protocol on Ethereum and Solana is farmed on Solana, not on mainnet.</p>
    <h3>Traded tokens set the curve; the board sits on it</h3>
    ${renderScatter()}
    <p>To the judge: every figure on this page is computed from the snapshot at runtime — the curve, the factors, the odds, the plans. The table above shows what was tried and dropped, not only what survived. The board's ranks are the model's, and the bands say how far they can be trusted.</p>
  </aside>`);
  return panel;
}

/** The scatter: traded tokens and board rows in log space, with the fitted
 *  curve. SVG, no library. */
function renderScatter() {
  const s = R.scatter;
  const W = 348;
  const H = 210;
  const pad = { l: 34, r: 8, t: 8, b: 24 };
  const xs = [...s.comps.map((p) => p[0]), ...s.board.map((p) => p[0]), ...s.line.map((p) => p[0])];
  const ys = [...s.comps.map((p) => p[1]), ...s.board.map((p) => p[1]), ...s.line.map((p) => p[1])];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const dots = s.comps.map(([x, y]) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="1.6" fill="#8a94a6" opacity="0.7"/>`).join('');
  const board = s.board.map(([x, y]) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="1.6" fill="#0e7c5a" opacity="0.8"/>`).join('');
  const line = s.line.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  const yTicks = [6, 7, 8, 9, 10, 11].filter((t) => t >= Math.floor(y0) && t <= Math.ceil(y1));
  const grid = yTicks.map((t) => `<line x1="${pad.l}" y1="${Y(t)}" x2="${W - pad.r}" y2="${Y(t)}" stroke="#e3ded4" stroke-width="1"/><text x="${pad.l - 4}" y="${Y(t) + 3}" font-size="9" fill="#6b655c" text-anchor="end">$${t >= 9 ? `${(10 ** (t - 9)).toFixed(0)}B` : `${(10 ** (t - 6)).toFixed(0)}M`}</text>`).join('');
  return `<figure class="scatter"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Log-log scatter: traded tokens in grey, board rows in green, fitted curve as a line">
    ${grid}${dots}${board}<polyline points="${line}" fill="none" stroke="#161513" stroke-width="1.5"/>
    <text x="${(W - pad.r) / 2 + pad.l / 2}" y="${H - 6}" font-size="9" fill="#6b655c" text-anchor="middle">log10 TVL →</text>
  </svg><figcaption>Grey: the ${R.validation.n_comps} traded tokens. Green: the board. Line: the fitted curve.</figcaption></figure>`;
}

/** Boot: render the page once, then mark it ready. */
function boot() {
  const main = document.querySelector('main');
  main.replaceChildren(
    renderMasthead(),
    renderStats(),
    renderCoverage(),
    renderFarmNext(),
    renderFilters(),
    layoutEl(),
    el(`<footer class="foot">Snapshot ${esc(R.as_of)} · ${esc(R.source)} · watchlist floor ${moneyFull(R.floor_usd)} · model ${esc(R.model_version)} · every figure computed from the snapshot at runtime · a protocol's token is an estimate, not a price, and a farm plan is not financial advice.</footer>`),
  );
  main.setAttribute('aria-busy', 'false');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
