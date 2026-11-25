// Token Radar, radar-6 — the entrypoint. Reads the sealed snapshot, builds the
// board and the dashboard's data, and writes the output the grader and the judge
// read. Standard library only, no network, no clock: two runs write the same
// bytes.
//
//   node main.ts --input /input/snapshot.json
//
// The input defaults to /input/snapshot.json and the output directory to
// $MAKEFUN_OUTPUT_DIR or /output. Locally:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Output:
//   /output/board.json      the ranked board, one row per protocol
//   /output/data.js         the dashboard's whole dataset as one script
//   /output/dashboard/     the page (index.html, app.css, app.js)
//   /output/screenshots/   the three screenshots of the page
//   /output/dossier.json   the dossier the judge reads, built by the kit's
//                           library from dashboard/ and screenshots/

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  boardIssue,
  buildRadar,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';

/** Copy a directory tree, file by file, creating directories as needed. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
    } else {
      throw new Error(`cannot copy ${src}: neither a file nor a directory`);
    }
  }
}

/** The value of `--flag <value>` on the command line, or null. */
function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const input = resolve(flagValue(argv, '--input') ?? '/input/snapshot.json');
  const out = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const here = dirname(resolve(process.argv[1]!));

  const snapshot = parseSnapshot(readFileSync(input, 'utf8'));
  const { board, radar } = buildRadar(snapshot);

  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new Error(`board refused: ${issue}`);

  // The regression guard: the entry must not ship a model worse than radar-5's.
  // Radar-5's held-out figures are LOO x3.25 and walk-forward x2.92; a model
  // that misses by more on either test, a band that holds under 40%, an odds
  // classifier at or below its base rate, or a board with no FARM verdict is
  // refused here, before anything is written.
  const guard = radar.validation;
  if (guard.loo_final_med > 3.25) throw new Error(`regression guard: LOO x${guard.loo_final_med.toFixed(2)} is worse than radar-5's x3.25`);
  if (guard.wf_final_med > 2.92) throw new Error(`regression guard: walk-forward x${guard.wf_final_med.toFixed(2)} is worse than radar-5's x2.92`);
  if (guard.band_p2575 < 0.4) throw new Error(`regression guard: P25-P75 band holds ${Math.round(guard.band_p2575 * 100)}%, under 40%`);
  if (guard.odds_acc <= guard.odds_base) throw new Error(`regression guard: odds classifier ${Math.round(guard.odds_acc * 100)}% is at or below its base rate ${Math.round(guard.odds_base * 100)}%`);
  if (radar.farm_counts.farm === 0) throw new Error('regression guard: no FARM verdict on the board');

  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, 'dashboard'), { recursive: true });
  mkdirSync(join(out, 'screenshots'), { recursive: true });

  writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));
  copyTree(join(here, 'dashboard'), join(out, 'dashboard'));

  const shots = join(here, 'screenshots');
  if (!existsSync(shots)) throw new Error('screenshots/ is missing: the page needs its three screenshots');
  const names = readdirSync(shots).filter((n) => !n.startsWith('.'));
  if (names.length < 3) throw new Error(`screenshots/ holds ${names.length} images, the page needs three`);
  copyTree(shots, join(out, 'screenshots'));

  const dossier = buildDossier(out, { text_max_bytes: 65536 });
  if (dossier.length > 1.5 * 1024 * 1024) {
    throw new Error(`dossier is ${dossier.length.toLocaleString('en-US')} bytes, over the 1.5 MiB the gate allows`);
  }
  writeFileSync(join(out, 'dossier.json'), dossier);

  const v = radar.validation;
  const top = board[0]!;
  console.log(`board: ${board.length} rows, ${radar.watchlist_size}/${radar.watchlist_size} watchlist covered`);
  console.log(`model: radar-6, ${v.n_comps} traded comparables, fit a=${v.fit_a.toFixed(3)} b=${v.fit_b.toFixed(3)} R2=${v.fit_r2.toFixed(2)}`);
  console.log(`held out: LOO x${v.loo_final_med.toFixed(2)} (flat x${v.loo_flat_med.toFixed(2)}), walk-forward x${v.wf_final_med.toFixed(2)} (flat x${v.wf_flat_med.toFixed(2)})`);
  console.log(`bands: P25-P75 holds ${Math.round(v.band_p2575 * 100)}%, P10-P90 holds ${Math.round(v.band_p1090 * 100)}%`);
  console.log(`odds: classifier ${Math.round(v.odds_acc * 100)}% held out, base rate ${Math.round(v.odds_base * 100)}%`);
  console.log(`farm: ${radar.farm_counts.farm} FARM, ${radar.farm_counts.thin} THIN, ${radar.farm_counts.skip} SKIP at $1,000, 7%`);
  console.log(`top: rank 1 ${top.name}, implied $${top.implied_value_usd.toLocaleString('en-US')}, ${top.verdict}`);
  console.log(`dossier: ${dossier.length.toLocaleString('en-US')} bytes`);
}

main();
