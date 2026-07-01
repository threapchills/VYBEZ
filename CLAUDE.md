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

## Phase 3 decisions

- The control flow: the pointer layer (`src/interact/pointer.ts`) reads geometry and publishes `control` events; the conductor and engine both subscribe and respond live; the scene subscribes for visual feedback. One topic, three independent consumers, no cross-wiring.
- `controls.ts` (the pure arithmetic) is now wired. Taps drive the discrete controls (totem cycles the scale, banner cycles the wind, fire stokes, a spirit tap toggles wake); drags drive the continuous ones (moon along the arc to the root, censer vertical to the tempo, spirit vertical to busyness, talisman horizontal to timbre). Tap versus drag is decided by a 6 px slop.
- Wake is immediate in phase 3: tapping a spirit swaps its pose and gates its notes at once. The covenant's 2-bar graceful crossfade (rule 7) is deferred to phase 5 with the rest of the section machinery.
- The talisman timbre macro lives in `engine.setTimbre`: one 0-to-1 input sweeps several patch parameters per spirit along a first-pass curve, to be dialled in by ear with the rig.
- Visual feedback added now: the totem glow climbs one segment per scale notch, the moon walks the arc, the banner flutters at a wind-dependent speed, the censer swings with a period tracking the tempo, spirits swap pose on wake. Onset-locked playing frames, parallax and particles are still phase 4.
- The fire decays toward its 0.35 floor via a 1 Hz tick in the pointer layer that republishes the cooling value; a full blaze is most of the way back in about three minutes.

## Phase 4 decisions

- Image is bound to sound through the shared clock, not a second timeline. The scene takes the engine's `now()`; note events arrive on the bus during the conductor's lookahead and are queued, then each spirit's strike fires when `now()` reaches the note's own time, so the contact frame lands on the beat. The engine is therefore constructed before the scene in `main.ts`.
- Spirit animation is a small state machine per spirit (asleep loop, idle sway, one-shot strike across the playing row, wake/sleep transition across the waking row). The strike runs over `min(0.5 s, note duration)`. Fervent rows are not used yet.
- Particles (`src/visuals/particles.ts`): one pooled field of 420 soft additive dots, tinted to the live palette accent, with a per-spirit signature (Drum embers, Rattle glints, Root ripples, Voice rising motes scaled by pitch, Echo paired motes, Spinner orbiting sparks, Breath fog). Emission gain scales with fire and note velocity.
- Palette is wired: the conductor broadcasts `palette` on totem/moon/fire changes; the scene grades the whole world with a ColorMatrix hue rotation clamped to +-25 degrees (`palette.ts`) plus a fire-driven brightness and saturation lift, and feeds the particle accent tint. The ignite grade hands the filter over to the palette grade once lit.
- Parallax is a slow sine ping-pong, depth-scaled per layer (sky 18 to foreground 190 world units), with the moon drifting a little; the camera breathes 1.0 to 1.015 with the fire; Drum and Root onsets nudge the foreground with a spring return. All of this stills under prefers-reduced-motion, but onset animation and particles stay.

## Phase 5 decisions

- Autonomous evolution lives in the conductor's `evolve(bar, turn)`, driven by a dedicated `driftRng` fork kept off the music streams so the played notes stay deterministic. At every section turn one or two patterns reseed (the slow structural breath, runs even in stillness). On breeze (wind 1), every 8 bars a continuous macro may drift a small seeded step (a busyness, a timbre, or the fire) and an awake spirit may reseed; on gale (wind 2), additionally the moon may shift and, rarely, the totem clicks. The valley plays itself by publishing the same `control` events a finger would, so audio, visuals and the conductor all answer through one path.
- Still freezes drift; only section-turn reseeding remains. Stillness publishes no autonomous control (unit-tested), so a still valley is reproducible.
- Graceful sleep (covenant rule 7): wake intent flips immediately (and the visual transition plays at once) but an audible `presence` per spirit eases 0 to 1 over two bars. `emit()` applies it: rhythmic notes thin probabilistically, swells just soften, so a part dissolves musically. A spirit sounds while presence exceeds a floor, then stops.
- The World (covenant rule 8) is a continuous `WorldVoice` in the worklet, always rendered after the seven: quiet stereo-decorrelated wind noise, a distant low rumble under a slow swell, and sparse ember crackle, all scaled by the wind state the engine forwards. There is never dead air, even with all seven asleep.
- Talisman drift needs the conductor to track its own copy of each timbre value (it walks then publishes `timbre:<id>`, which the engine renders); busyness and fire it reads back from its own state.

## Phase 6 decisions

- The mute icon (`src/interact/mute.ts`) is the only conventional UI besides the ignition caption: a small DOM button, hidden until the fire is lit, that ramps the master gain over 50 ms. The engine exposes `setMasterMuted`; the master level lives in one constant so mute and unmute agree.
- Reduced motion: parallax, camera breath, the banner and censer drift, and the caption pulse all still under `prefers-reduced-motion`; particles, being motion, are suppressed entirely. Onset-locked spirit frames stay, as they carry meaning rather than ambience.
- Mobile: the cover-fit centres the fire so the hearth is always in frame on a tall phone; Pixi federated pointer events serve mouse and touch through one path; `touch-action: none` and `user-select: none` in index.html keep browser gestures out. Verified at 375x812 with the mute icon placed and a single instance mounted.
- Performance sits within budget by construction: modal banks are cheap two-pole resonators, the particle field is a fixed pool of 420, and the onset budget caps simultaneity. Desktop tabs keep playing in the background; mobile resumes audio cleanly on visibilitychange.
- Remaining and deliberately left to Mike: dialling the patch macro curves in by ear with the `?dev=1` rig (the curves sweep wide and musical but are first-pass by reason). Known low-priority debt: voice stealing restarts immediately rather than riding the 5 ms steal fade; the onset ramp already declicks it, so it only matters under heavy polyphony pressure.

## Interaction feel pass (post phase 6)

Mike's report: as a user it felt static, clicks seemed to do nothing, controls were not apparent. Root causes and fixes:

- Half the controls were drag-only (moon, censer, talismans), so a click did nothing. Now every control answers a tap as well: the moon steps the root, the censer steps the tempo a notch, a talisman steps the timbre; dragging still gives continuous control. Tap handlers guard against firing at the end of a drag via the shared `drag.moved` flag.
- No affordance and no feedback. The scene now gives every control a soft additive glow (warm, palette-tinted) that gently pulses so it reads as touchable, brightens on hover, bounces on press, and flares when its value actually changes. A one-time beckoning shimmer travels the controls just after ignition to teach the eye where to touch. All diegetic; no HUD, per Mike's choice.
- Testing blind spot that let this slip: synthetic DOM PointerEvents dispatched on the canvas do NOT drive Pixi v8's event system, so every prior "controls work" check fired events straight at sprites via `sprite.emit('pointertap')`, which exercises handler logic but skips real hit-testing. Real-user ignition proves the DOM-to-Pixi hop works; `emit` proves the handler-to-bus-to-audio path. Verify both halves separately; never assume `emit` covers real input.

## Mix rescue (the "one loud synth" report)

Mike reported one loud voice overpowering everything, uncontrollable, masking all the spirits so controls seemed dead. Measured with an analyser on the master via the `__VYBEZ__` QA handle: full-mix RMS 0.65, peak 0.82, i.e. the bus was slamming the soft-clip limiter continuously, a crushed saturated wash with no dynamics. Causes and fixes:

- The tape-saturation stage used `tanh(x*1.4)/tanh(1.4)`, whose small-signal gain is 1.4/tanh(1.4) = 1.58x; it was a hidden booster. Dropped drive to 0.8 (small-signal ~1.2x).
- The makeup gain after the compressor was 1.5x, slamming everything into the limiter. Now 0.6x (net attenuation into the limiter, preserving dynamics).
- The World bed was too loud (RMS ~0.10 alone). Cut its wind, rumble and crackle levels ~2.5x; now ~0.015, a true background.
- Result: full-mix peak ~0.66, RMS ~0.39, no longer railing; the spirits and control changes are audible again. Mike's ear is the final judge of absolute level.
- Particles were not suppressed (he was not on reduced motion) but too sparse and small to notice; counts and sizes raised so the spray reads clearly.

Diagnostic note: `globalThis.__VYBEZ__ = { engine, conductor, handles, session, bus }` is exposed like `__PIXI_APP__` for QA; `engine.audioContext` and `engine.masterNode` allow analyser taps. Muting a spirit via `engine.setMuted` only gates new notes; already-ringing tails keep sounding, so to isolate the World, stop the conductor and let tails die before measuring. See [[vybez-testing-blindspot]].

## The overhaul (Fable 5 returns)

Mike's verdict on the phase 6 build: static, controls inaudible, drums frozen, melodies "simple and random" at once, three instruments audible out of seven, one timbre each. Mandate: complete overhaul, ditch prior choices where needed. What changed and why:

- **Music is composed, not rolled.** The Voice now owns a one-bar motif (weighted onset slots, stepwise contour with leap-resolution grammar) developed through a four-phrase cycle: statement, varied repeat, fragment with a breathing bar, inverted answer with a cadence. Busyness composes ornament and thinning at plan time. The per-slot Bernoulli lead is gone; repetition with variation is what reads as melody.
- **The Root plays basslines in five styles** (drone, anchor, pulse, syncopated, hemiola), voiced from the sounding chord's own tones, with occasional scalewise walk-ups into the downbeat. Style reseeds with the drift. Root lane widened to [24, 45] for octave pops.
- **The Drum plans each bar whole**: Euclidean kick skeleton with seeded drops, ghost kicks and ghost snares scaled by busyness and fire, rare lazy or half-time backbeats, and fills (snare runs, falling toms, ruffs) at 4-bar group ends and section ends. Measured live in the browser: nine consecutive bars, nine distinct patterns.
- **Every note carries a `timbre` field** (contracts.ts): 0.5 neutral, driven by per-spirit seeded LFOs (0.004 to 0.02 Hz) plus per-note jitter in the conductor; the worklet applies it as a deviation around each patch (drum tone and decay, modal position, hardness and tilt, wavetable morph and breath, bow brightness and pressure, pipe cutoff, string brightness). The talisman remains the centre; the weather moves around it.
- **The lead grew up**: two detuned wavetable reads chorusing, intra-note morph drift, and a velocity-tracking one-pole lowpass so soft notes are soft in colour, not just level. Pools widened (strings 4, drums 10, tines 6, leads 6).
- **All seven wake at ignition** (session.ts: no seeded sleepers); gains rebalanced so the quiet five are audible (rattle 0.7, spinner 0.72, echo 0.6, breath 0.6, shaker 0.5, drum trimmed to 0.8). Verified live: all seven emit notes within the first bars; mix peak ~0.71, RMS ~0.37, no limiter railing.
- **Every control answers audibly within ~30 ms** via acknowledgement gestures published straight to the note bus, throttled to one per 0.35 s per control so drags become audible scrubs: the totem plays three rising tines in the new scale, the moon re-strikes the root at the new pitch, the censer taps twice at the new tempo, a stoke whooshes a riser, a talisman sounds one note in the new colour, a waking spirit plays a signature figure (and presence jumps to 0.4 before ramping). Gestures need the conductor started, so unit tests that construct without `start()` stay silent by design.
- **Evolution is on by default**: wind starts at breeze everywhere (conductor, pointer, scene banner, engine World bed), breeze drift runs every 4 bars, and section turns reseed 2 to 3 patterns and rotate a two-spirit foreground pair (velocity lift) so prominence wanders slumbr-fashion over minutes. Still remains a choice that freezes drift (unit-tested).
- **Covenant overrides, deliberate**: onset budget raised to 4 attacks per slot (5 with Drum + Root paired) for the full ensemble; the 2-to-4 sleeper rule dropped; still-by-default dropped. The handoff's letter bends to its own first law: musicality first.
- slumbr-main turned out to contain only two fire-crackle oggs and an empty sounds folder; the inspiration was taken as a brief (slowly evolving soundscapes), not as code.

## The play pass (first principles: make it a toy you can play)

Mike's open mandate: rethink everything for maximum fun. The diagnosis: the valley had no direct musical input (every control was a parameter), no collective dramaturgy (independent per-spirit arcs average to flat mush), and no payoff moments. Five additions:

- **The sky harp.** A tap or sweep on the open sky (world y < 860, only where no sprite is hit, so controls always win) rings a tine: x sweeps two octaves of the live scale left to right, height softens the touch, and a drag strums 24 band-crossings like a stick along railings. It cannot play a wrong note. Each strum seeds the Echo's imitation ring (the valley answers, bowed, two beats later) and pushes its degree into an 8-note player memory: for the next 8 bars the Voice sings the player's contour in the motif's rhythm. The control event is `strum` with `value` = x and a new optional `y` field on ControlEvent; the scene rings a starburst at the touch point and sparse unbidden twinkles invite the hand skyward.
- **The tide.** One seeded 24-48 bar sine that every spirit rides together, multiplying densities and velocities, because tension needs correlation. At the deepest trough (past bar 12) the ensemble inhales: one hush bar of root, drone and wind only. Measured live: master RMS now swings 0.03 to 0.47 across a tide cycle where the old build sat pinned; peak 0.70, no railing.
- **The blaze.** Stoking the fire to full (>= 0.97) arms a drop at the next bar: half a bar of held breath, a riser at beat two, then a tutti downbeat past the onset budget (kick, tom, root, rattle, tine). Re-arms after 16 bars as the fire cools, so it is chaseable. Verified live: zero drum hits in the held breath, velocity-1.0 kick on the drop.
- **The composed opening.** No more wall-of-everything at ignition: breath and root at bar 0, drum at 1-2, voice 2-3, rattle 3-4, spinner 4-5, echo 5, riding the existing presence ramps. Verified live entry order: 0/0/1/3/4/4/6.
- **The dotted-eighth ping-pong delay** in the worklet, tempo-synced via a `tempo` port message (engine forwards the censer; main.ts sends the session BPM at unlock), highpassed ~150 Hz at the input so kick and bass stay dry. Send 0.38, feedback 0.42, wet 0.5.
- Also fixed in passing: the Echo's imitation notes bypassed `emit()`, dodging presence, timbre weather and the foreground lift.

## The space and expression pass

Mike asked for per-voice convolution reverb, delay banks, portamento, tremolo, vibrato and unison/chorus modes, all evolving and coupled to what the player does. The build:

- **Four worklet outputs**: the dry mix plus three per-spirit send buses. Each pool renders into a scratch pair, then fans out at its own patch-level send gains (`revA`, `revB`, `dly` in every patch JSON, live-editable in the rig). Returns: a 5.5 s seeded cavern convolution, a 1.3 s dark room, and a tempo-synced delay bank (dotted-eighth ping-pong pair plus a whole-bar dark tap), replacing the phase-earlier full-mix ping-pong.
- **All three returns feed the same tape saturation stage as the dry mix.** Sending them straight to the compressor let raw transients slam the clip ceiling (measured peak pinned at 0.821); through the shared tape the mix sits at peak ~0.57, median RMS ~0.32 at the tide's crest, floor 0.03. Bonus: the fire's master tone filter darkens the wash as the hearth dies.
- **Expression per voice**: lead portamento (a note within 0.6 s of the last glides in from its pitch; `glide` in voice.json), lead/bow/pipe tremolo (`trem`, `tremRate`), lead unison width (`unison` scales the detuned partner's spread and level), and for the modal instruments the physical-modelling chorus: gamelan paired tuning (`pair`), a twin bank a shade sharp beating ombak-fashion against the first.
- **Player-coupled space**: every sky strum posts a `glow` pulse (the cavern and delay sends bloom, decaying over ~12 s); the fire posts `space` (high fire pulls the valley close and dry, a dying fire recedes into reverb); a moon change posts `glide` (the lead slides into the new key for a few seconds); the wind sets delay feedback and darkness (still tight, gale swirling).
- **Evolving space**: drift gained a fourth macro dimension, `space:<id>`, walking one spirit between close-and-dry and far-and-washed via `engine.setSpace` (sweeps `revA` and `dly`). Talisman timbre macros now also sweep unison, tremolo and pair, so a talisman drag reshapes expression, not just spectrum.
- Verified live: strums ring and glow without error, the space macro sweeps sends (0.8 gives revA 0.49/dly 0.41), gale ramps ping feedback toward 0.55, and the meters above. Mike's ear remains the final judge of the return levels; they are one constant each in `buildBus`.

## The dead controls: root cause found and fixed

Mike's recurring report since phase 3 ("zero agency", "clicks do nothing", "GUI all over the place") was one bug with two heads, finally caught by probing Pixi's own hit-tester at each control's screen position:

- **Head one: the stage hitArea.** `app.stage.hitArea = app.screen` (phase 3, for drag tracking) made the stage swallow every hit before its children were tested. Ignition worked only because the pointer layer attaches after the first fire tap.
- **Head two: interactive-mode inheritance.** Pixi v8's `hitTestRecursive` passes the stage's `static` mode down to every descendant, and any sprite that merely contains the point then hits on `containsPoint` even when `passive`, handing the target to its nearest interactive ancestor: the stage. The full-world foreground layer contains every point, the glade covered the moon, the totem's glow sprite covered the totem, and live particles stole taps in flight. So removing the stage hitArea alone changed nothing.
- **Fixes**: no hitArea on the stage, ever (the scene's `backdrop`, a screen-sized static Container behind the world, is the sky harp's catch-all instead, and sprites win over it); `eventMode = 'none'` on every decorative object (the five layers, the totem glow, the glow layer, the particle field, both captions); tight per-control `hitArea` rects sized to the visible bodies (a sprite's default hit box is its whole frame, transparent pixels included, and at these scales they overlapped their neighbours); talismans re-added above spirits and fire so the smaller target wins an overlap.
- **Testing doctrine, corrected**: synthetic DOM PointerEvents dispatched on the canvas DO drive Pixi v8's event system (the old belief that they don't was a misdiagnosis of this very bug). The full verification is: dispatch pointerdown/up at each control's `getBounds()` centre and assert the expected control event on the bus. In a hidden tab call `app.render()` first: rAF never fires there, so transforms are stale and all hit tests lie.
- Verified end to end through real DOM events: fire stokes, totem turns, banner cycles wind, moon steps, censer steps, all seven spirits wake/sleep, all seven talismans fire their own `timbre:<id>`, sky strums. 83 tests, lint, typecheck, build all green.

Also added, at Mike's request: the whisper, a second soft caption that names a control's purpose on hover or touch ("the totem turns the scale", "the banner calls the wind"...), fading after 2.4 s. A deliberate amendment to the one-caption covenant rule.

## Style covenant

British spelling. Sentence case headings. No em dashes anywhere: use colons, semicolons, en dashes with spaces, or hyphens. Plain verbs in user-facing strings. The only in-fiction caption is "stoke the fire". No persistence of any kind; the valley keeps its secrets.
