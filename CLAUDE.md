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

## Phase 1 decisions

- Subagent orchestration is suspended: the phase 0 review tripped Mike's monthly agent spend limit, so subsequent phases are built in the main thread until that eases.
- The worklet bundles via `?worker&url` with `worker.format: 'es'`; the emitted chunk resolves relative to the index chunk, which survives the Pages subpath. Keep both halves if touching the build.
- Session parameters (`src/core/session.ts`) derive once from the seed and are shared by scene and conductor: the moon the player sees is the root the valley plays.
- Phase 1 voices: Root is Karplus-Strong with a pick-position comb over a sine sub layer; the Drum is a pitched kick, a two-mode membrane snare with SVF noise, and a tom. The full patch architecture and modal banks arrive in phase 2; the patch JSONs currently carry macro scalars only.
- Drum and Root play regardless of the sleeper subset; sleep gating joins the pattern system with the controls in phase 3.
- Master bus: tape saturation (2x oversampled) into lowpass tone into dry plus generated-IR fog (3.5 s, seeded), then compressor and soft clip. Global wow and flutter join the bus with the melodic voices; phase 1 carries seeded per-voice detune and per-note micro-variation instead.
- The conductor's grid starts 0.1 s after ignition; jitter is measured from that grid. Voice restarts ride a 1.5 ms (string) or 0.5 ms (drum) onset ramp instead of steal fades, which phase 2 will revisit when polyphony pressure is real.
- Hungarian minor's iv-drone (degree 5) sits outside the scale set deliberately, exactly as the handoff tables it.

## Phase 2 decisions

- Fable 5 was withdrawn by a US government export-control directive mid-build; Opus now authors everything, the synth included. The handoff's subagent table is advisory only.
- Vybez Core voices: a morphing wavetable lead (mip-mapped, session-baked tables; breath layer; vibrato that arrives only in the back third of a note); modal banks for the rattle (bells) and spinner (tines) built from {ratio, gain, T60} triples with strike-position combing and damping tilt; a granular shaker on the rattle's ghost notes; a continuously-excited Karplus bow for the echo; a waveguide pipe with noise-swell risers for the breath. Voice pools: 3 strings, 8 drums, 4 rattles, 3 shakers, 5 tines, 3 bows, 5 pipes, 4 leads.
- Wavetables (`src/audio/tables.ts`): 8 tables x 2048 samples x 4 mip levels (partial caps 64/20/7/3), baked once from the seed under a spectral-tilt prior with comb notches and paired-partial shimmer; the bank shares one phase set so morphing never phase-cancels. The buffer is transferred to the worklet, not copied.
- Euclidean bands (the open choice): Drum kick E(5 or 7, 16) plus a backbeat; Root hemiola on 3, 4 or 6 beats; Rattle E(4 to 7, 12) phasing against the bar's 16; Spinner E(9 to 13, 16). Busyness will modulate k within these in phase 3.
- Register lanes are enforced in `LANES` (conductor.ts) and unit-tested; the onset budget caps at 3 attacks per slot, 4 when Drum and Root pair, swells excluded.
- The dev rig (`src/dev/rig.ts`, `?dev=1`) edits live patch scalars by posting `patch-update` to the worklet, with per-spirit solo, mute, audition and clipboard export. Macro breakpoint curves are not yet data (macros are coded curves in the worklet), so the rig tunes raw parameters; the rattle and shaker export as separate slots and reassemble into `rattle.json`'s `modal` and `shaker` keys by hand.
- Known polish debt for phase 6: voice stealing currently restarts the stolen voice immediately rather than riding the 5 ms steal fade (the onset ramp still declicks); the modal/wavetable macro curves want tuning by ear now that the rig exists.

## Leaf modules authored ahead of their phase

Written by Opus, gates green, but not yet wired into their phases.

- `src/interact/controls.ts` (phase 3): the pure control arithmetic, one helper per object in the scene's control table, with no Pixi or audio dependency; the pointer layer will own geometry and bus publishing. ControlEvent targets follow the contracts comment exactly: `totem`, `moon`, `censer`, `fire`, `wind`, `busy:<id>`, `timbre:<id>`, `wake:<id>`. Open choices settled here: the censer settles to the nearest 4 BPM notch (the swing physics feel lives in the pointer layer); the fire stokes +0.2 per tap and cools exponentially toward the 0.35 floor with an 80 s time constant, so a full blaze is most of the way back by three minutes; wind cycles still to breeze to gale as bus values 0, 1, 2.
- `src/visuals/palette.ts` (phase 4): the seven scale ramps and pure colour maths. Moon position maps to a hue rotation clamped to +-25 degrees; the fire warms the three midtone stops; `lerpRamp` drives the section-turn ease; `toTint` hands Pixi a 0xRRGGBB integer. Hue rotation is clamped so the painted art never breaks.

## Style covenant

British spelling. Sentence case headings. No em dashes anywhere: use colons, semicolons, en dashes with spaces, or hyphens. Plain verbs in user-facing strings. The only in-fiction caption is "stoke the fire". No persistence of any kind; the valley keeps its secrets.
