# token-radar-r6

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/roymaster46/token-radar-r6/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/roymaster46/token-radar-r6/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks every pre-token DeFi protocol by an implied token value fitted on the snapshot's own traded tokens — a power-law size curve with curvature, concave 7-day growth, a mild age term, a concentration penalty and shrunk category factors — and costs a farm plan for each one on its own chain's gas profile. Every term is validated held out twice (leave-one-out and walk-forward); the dashboard shows what was tried and dropped, not only what survived. The board covers the full 40-protocol watchlist plus every other rankable pre-token protocol, and accounts for all 758 protocols in the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

`snapshot.json` is the competition's sealed snapshot (from the kit's `input/`). Node 22 or later, standard library only, no network. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`, and runs twice byte-identical.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
