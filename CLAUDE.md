# VYBEZ: build log and decisions

The brief is [HANDOFF.md](HANDOFF.md); the art spec is [ASSETS.md](ASSETS.md). Both are law. This file records the open choices made along the way, as the handoff requires.

## Stack and commands

TypeScript strict, Vite, PixiJS v8, Vitest. No other runtime dependencies.

- `npm run dev` - dev server
- `npm run build` / `npm run preview` - production bundle and local serve
- `npm run typecheck` / `npm run lint` / `npm run test` - the gates; all must stay green
- `?seed=<n>` - dev-only reproducible session; never surfaced in the UI
- `?dev=1` - the tuning rig (arrives in phase 2)

## Architecture notes

- Contracts live in `src/core/contracts.ts`; the typed bus in `src/core/bus.ts` carries the five topics (`note`, `control`, `section`, `palette`, `wake`). Nothing crosses module boundaries except through the bus and the contracts.
- `PaletteEvent` and `WakeEvent` are additions beyond the handoff's contract block, which names the `palette` and `wake` topics without defining their payloads. The wake flow once phase 3 lands: interaction publishes `control` with target `wake:<id>`; the conductor owns the 2-bar crossfade and publishes the resulting `wake` events that audio and visuals consume.
- One root RNG (mulberry32) seeded from crypto or `?seed=`; subsystems take deterministic child streams via `rng.fork(label)`.
- The manifest (`public/assets/manifest.json`) is the single source of truth for art. The loader validates every file's pixel dimensions against it and substitutes generated placeholders for anything missing or malformed. Placeholder drawing is deterministic per file via RNG forks.
- Spirit sheets may ship an optional fourth fervent row; the manifest expresses this as `maxRows: 4` and the loader accepts either height.

## Phase 0 decisions

- World space is the painted layers' native 3840 x 1440; all placement uses those units. The camera cover-fits with a minimum horizontal overflow of 800 px (`DRIFT_MARGIN`) so the parallax drift always has room, and centres the fire horizontally, which doubles as the mobile crop policy.
- Spirit positions in `src/visuals/scene.ts` are provisional, to be tuned against the real art in phase 4. Spirits render at 2.5x, the totem at 2x, the fire at 3x.
- The seeded sleeper subset keeps at least one of Root or Breath awake by choosing the anchor first, then drawing 2 to 4 sleepers from the rest.
- Pre-ignition is a ColorMatrixFilter grade (desaturated, dimmed) plus the caption; the first tap on the fire eases the grade off over 2 s. The AudioContext unlock attaches to the same gesture in phase 1.
- Pixi's `resizeTo` does not reliably measure on init; `main.ts` calls `app.resize()` once after mounting. Keep this if touching boot.
- `__PIXI_APP__` is exposed on globalThis for devtools and QA probes.

## Style covenant

British spelling. Sentence case headings. No em dashes anywhere: use colons, semicolons, en dashes with spaces, or hyphens. Plain verbs in user-facing strings. The only in-fiction caption is "stoke the fire". No persistence of any kind; the valley keeps its secrets.
