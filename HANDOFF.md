# VYBEZ: build handoff

The name is **VYBEZ**; the repo slug `vybez` is assumed throughout.

This document is the complete brief for Claude Code. Read all of it before writing any code. A companion file, `ASSETS.md`, specifies the art Mike will supply; you never wait for that art (see Asset pipeline).

## What this is

A browser-based living instrument. A painted valley at perpetual dusk holds seven anthropomorphic spirit musicians. They play together, endlessly, from one shared scale and one shared clock, in interlocking polyrhythms. The player never performs; the player steers, by touching plausible objects inside the scene. There are no levels, no enemies, no goals, no saving, no recording, no sharing. The experience is ephemeral by design: the music exists only while the valley is open, and it is different every time.

Each session, a seeded random subset of the seven begins asleep. Tapping a sleeper wakes them; tapping again returns them to sleep. Sleep is the mute button, rendered as fiction.

The whole thing must be pleasant to leave running in the background for an hour. That implies slow autonomous evolution (the wind, below) and a hard guarantee: whatever the player does, whatever the seed does, the output is always consonant, haunting, ancient, tribal. Beauty is enforced by constraint, never by luck.

Tone references, for taste calibration only: Panoramical, Proteus, Eno's Bloom, The Dark Crystal, early Amiga demoscene. Aesthetic: dark fantasy, liminal, 1980s.

## The covenant (always beautiful)

These rules are non-negotiable. Every musical decision in the codebase must pass through them.

1. One scale, one root, one clock. All seven voices quantise pitch to the active scale and time to the master transport. No exceptions, ever.
2. Chord-tone gravity. On strong beats, melodic voices choose from the current chord's tones; scale tones are admitted on weak beats; chromatic notes never.
3. Register lanes. Each spirit owns a tessitura band (defined per spirit below). Lanes may brush but never swap, so the mix self-balances.
4. Onset budget. At most 3 simultaneous attacks per 16th-note slot, excluding the Drum + Root pairing which may always land together. Priority order when over budget: Drum, Root, Voice, Spinner, Rattle, Echo; lower priority defers one 16th or drops the note.
5. Humanisation. Seeded timing jitter (±8 ms, ±3 ms for the Drum), velocity contours per phrase, ±5 cents seeded detune per voice, global wow and flutter (0.3 to 1 Hz, ±4 cents) on melodic voices.
6. Phrase arcs. Each spirit's density follows a slow envelope across the section (8 or 16 bars): breathe in, breathe out. No voice plays flat-out forever.
7. Graceful sleep. Waking and sleeping crossfade over 2 bars, musically (patterns thin out, then stop) and visually (the wake or sleep animation plays once).
8. No dead air. A hidden eighth voice, the World (quiet wind noise, rare ember crackle, distant rumble), plays always, even when all seven sleep.
9. Dissonance is colour, never collision. In the exotic scales the melody carries the colour while the harmony simplifies (see Harmony).

## The seven

All seven are patches on one deep engine, Vybez Core (see The synth: Vybez Core); the Voice column below summarises each patch's character.

| #   | Title       | Role                          | Voice (synthesis)                                                                                             | Behaviour                                                                                                                                     | Register         | Talisman       |
| --- | ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------- |
| 1   | The Drum    | main kit                      | modal membranes: pitched kick (fast pitch envelope), snare-like membrane + bandpassed noise burst, tom voices | seeded Euclidean backbone, e.g. E(7,16) or E(5,16) + backbeat; tight timing                                                                   | C1 to C3         | low drum totem |
| 2   | The Rattle  | accompanying percussion       | inharmonic modal banks (bells, woodblock, frame) + granular noise shaker                                      | rotated Euclidean offsets against the Drum, ghost notes, never on the Drum's accents                                                          | C4 to C6         | bone chimes    |
| 3   | The Root    | bass                          | Karplus-Strong pluck layered with a morphing wavetable sub                                                    | cycle of 3, 4 or 6 beats against the 4-beat bar (hemiola); root and fifth gravity                                                             | C1 to C2         | root-stone     |
| 4   | The Voice   | lead melody                   | morphing wavetable (session-baked tables, see Wavetables) + breath-noise layer, synced vibrato                | phrase arcs with real rests; chord tones on strong beats, stepwise motion bias                                                                | C4 to C6         | carved mask    |
| 5   | The Echo    | counterpoint and chord melody | bowed-string physical model (sustained Karplus variant with continuous noise excitation)                      | imitates the Voice after a 2-beat delay, diatonically transposed, contrary-motion bias; switches to slow dyads or triads when the Voice rests | C3 to C5         | mirror shard   |
| 6   | The Spinner | arpeggio                      | plucked-tine modal voice (kalimba-like: short inharmonic modal pluck)                                         | 16th grid gated by E(9 to 13, 16); shape from {rise, fall, pendulum, orbit}; wide span                                                        | C3 to C6         | prayer wheel   |
| 7   | The Breath  | risers and drones             | waveguide drone (blown pipe) + filtered-noise swells through the generated-IR reverb                          | drones on root and fifth; risers begin 1 bar before every section turn                                                                        | C2 to C4 + noise | fog lantern    |

Names are placeholder titles; Mike will christen them later. Keep all identifiers in code as `drum, rattle, root, voice, echo, spinner, breath, world`.

## The scene and its controls

One continuous painted scene, wider than the viewport, drifting slowly in parallax. The seven stand across the mid ground. Every setting in the app is a touchable object inside the fiction. There are no sliders, menus, panels or HUD. The only conventional UI permitted is a small mute icon and the initial ignition caption.

| Object                    | Controls                   | Range and steps                                                                                                                       | Interaction                                                                                                                                               |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Totem pole                | scale                      | 7 notches, bottom to top: Aeolian, harmonic minor, Hungarian minor, double harmonic, blues minor pentatonic, major pentatonic, Ionian | tap to click the glowing segment upward; wraps at the top                                                                                                 |
| Moon                      | root note + palette accent | 12 positions along the sky arc                                                                                                        | drag along the arc; snaps to positions                                                                                                                    |
| Censer (swinging brazier) | tempo                      | 60 to 92 BPM, quantised in 4 BPM notches                                                                                              | drag to push the swing; settles to the nearest notch; swing period visibly matches the beat                                                               |
| Fire (central bonfire)    | master intensity           | continuous 0.35 to 1.0                                                                                                                | tap to stoke toward 1.0; decays toward the 0.35 floor over ~3 minutes; drives onset budget headroom, master filter openness, particle gain, camera breath |
| Wind banner               | autonomous drift           | still / breeze / gale                                                                                                                 | tap to cycle states                                                                                                                                       |
| Spirit body               | wake or sleep              | toggle                                                                                                                                | tap; 2-bar crossfade                                                                                                                                      |
| Spirit body               | busyness                   | continuous 0 to 1                                                                                                                     | vertical drag on the spirit; maps to Euclidean fill k, note probability, octave span                                                                      |
| Talisman (one per spirit) | timbre                     | continuous 0 to 1                                                                                                                     | drag; wavetable voices morph through their table set; physical voices sweep a damping + brightness macro curve                                            |

The wind, precisely: in breeze, every 8 bars there is a 20% chance that one continuous macro (a busyness, a timbre, the fire) drifts a small step via a slow seeded walk, and a 10% chance one awake spirit reseeds its pattern. In gale, additionally the moon may shift one position every few minutes, and rarely (order of once per 5 minutes) the totem itself clicks. Gale is full surrender; the valley plays itself. Still freezes all drift.

Audio unlock: browsers require a user gesture before audio. The scene loads dim, silent and desaturated, with one caption in sentence case: "stoke the fire". The first tap on the fire starts the AudioContext, ignites the scene, and the session begins. This is the only onboarding.

## Session generation (seeded)

A single seeded RNG (splitmix32 or mulberry32) is the source of all variation. Seed from crypto randomness on load; support a dev-only `?seed=` query param for reproducible QA, never surfaced in the UI.

The seed determines: which 2 to 4 spirits begin asleep (always leave at least one of Root or Breath awake so the valley has a tonal anchor); initial totem, moon, censer and fire positions; per-voice wavetable recipes; modal ratios and decay jitter for the physical voices; pattern seeds; palette jitter; the reverb impulse noise. Nothing persists between sessions. Ephemerality is a feature; do not add storage of any kind.

## The conductor (music brain)

The conductor runs on the main thread and owns all musical decisions; the audio engine merely renders them.

Clock: lookahead scheduler in the "tale of two clocks" pattern. A 25 ms tick scans a 120 ms horizon and posts sample-stamped NoteEvents to the audio thread. Transport counts 16th slots; bar = 4 beats; section = 8 or 16 bars (seeded). At each section turn: ease the palette one stop, let the Breath's riser resolve, reseed a minority of patterns, optionally rotate the harmony chain.

Scales (semitone sets from root):

| Scale                  | Set                                                         | Harmony roots and weights                             |
| ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Aeolian                | 0 2 3 5 7 8 10                                              | i .30, bVI .20, bVII .20, iv .15, v .15               |
| Harmonic minor         | 0 2 3 5 7 8 11                                              | i .30, V .25, bVI .20, iv .15, bIII .10               |
| Hungarian minor        | 0 2 3 6 7 8 11                                              | i .40, bVI .25, V .25, iv-drone .10                   |
| Double harmonic        | 0 1 4 5 7 8 11                                              | i .40, bII .30, V .30                                 |
| Blues minor pentatonic | 0 3 5 7 10 (b5 = 6 admitted as weak-beat passing tone only) | open fifths on 1 .50, b7 .25, 4 .25                   |
| Major pentatonic       | 0 2 4 7 9                                                   | open fifths and quartal stacks on 1 .50, 5 .25, 6 .25 |
| Ionian                 | 0 2 4 5 7 9 11                                              | I .25, vi .20, IV .20, V .20, ii .15                  |

Harmony: a first-order Markov chain over the root set above, biased toward return-to-i (or 1). New chord every 2 or 4 bars (seeded per section). In the two pentatonics and the two exotic scales, voicings stay open (fifths, octaves, quartal stacks); the melody carries the colour. The conductor broadcasts the current chord tones and scale tones; every melodic voice draws from that broadcast under covenant rule 2.

Patterns: Euclidean rhythm E(k, n) is the rhythmic vocabulary; busyness modulates k within a clamped band per spirit. Cycle lengths are deliberately co-prime where possible (Root on 3 or 6 beats against the 4-beat bar; Rattle on 12 against 16) so composite periods phase over long spans, Reich-fashion, while staying locked to one clock. The Echo is event-driven: it keeps a ring buffer of the Voice's last intervals and replays them 2 beats later, diatonically transposed into its own lane, with a contrary-motion correction and a strong-beat consonance filter (no 2nds or 7ths against the sounding Voice note on strong beats).

## The synth: Vybez Core

This is the heart of the build, and the quality bar is explicit: the internal synth must stand comparison with the commercial soft synths in its lineage, Kaivo and Chromaphone 3 on the physical modelling side, Serum on the wavetable side. The bar is reachable in a worklet because the scope is narrow: one engine, built deep, with seven patches. Raw Web Audio with AudioWorklet; no audio frameworks, no samples; every sound in the app is synthesised at runtime.

### One engine, seven patches

Every spirit is a patch on the same fixed-topology voice. Character lives in JSON patch files (`src/audio/patches/*.json`): exciter choice, resonator choice and tuning, coupling, modulation routings, macro curves. The engine ships general; the patches make it sing. This is how the reference synths are shaped, and it means tuning a spirit is a data edit, with the DSP left alone.

### Voice architecture

Two layers in series, source into body, with a blendable mix tap between them.

Source layer, per patch any blend of:

- Wavetable oscillator: session-baked banks (8 to 16 tables × 2048 samples; see Session-baked material), morph position as the primary timbre axis, two cheap warp modes (phase bend, formant shift), optional 2 to 4 voice unison with detune and stereo spread for sustained patches.
- Exciters: mallet (raised-cosine impulse whose hardness control widens its spectrum), bow (sustained filtered noise with pressure and velocity), breath (pink noise with a chiff transient), pluck (short shaped burst with pick-position comb).

Body layer, per patch one of, or two coupled:

- Modal bank: 8 to 16 resonators (one SVF or complex one-pole per mode), each mode a {ratio, gain, T60} triple. Material presets define the ratio sets: membrane (Bessel-flavoured), bar and tine (1, 2.76, 5.40, 8.93...), plate (dense inharmonic), bell (with the minor-third partial). Global controls: inharmonicity stretch, damping tilt (high modes die faster), strike position (combs the mode gains), and stereo mode spread, decorrelating modes across the field; this last control alone makes modal banks sound expensive.
- String: Karplus-Strong with loop damping filter, brightness, sustain (loop gain up to bowed territory via continuous excitation), pluck-position comb.
- Tube: simple waveguide pipe with a reflection filter, for the Breath.

Coupling, the Chromaphone move: an optional serial path A into B with a bleed control. Mallet into membrane into shallow tube gives the Drum its chest; pluck into tine into a small wooden box gives the Spinner its kalimba body. Per-voice post: soft drive, state-variable filter with key tracking, pan, fog send.

### Modulation

Per voice: two tempo-syncable LFOs with seeded phase, two envelopes (amp and mod), and these sources: velocity, note pitch, busyness, fire, wind drift, and a seeded per-note sample-and-hold. An 8-slot modulation matrix per patch routes any source to any destination (morph, warp, hardness, pressure, inharmonicity, damping, position, filter, send). All depths live in the patch JSON.

### Macros as curves through patch space

Each spirit exposes exactly two playable macros: the talisman (timbre) and the body drag (busyness). Internally a macro is a curve, never a single knob: one 0-to-1 input moves 4 to 10 underlying parameters along breakpoint curves defined in the patch. Example, the Voice's timbre macro across 0 to 1: table morph 0.10 to 0.90, breath layer -24 to -10 dB, filter 1.2 to 6 kHz with a mid dip, vibrato depth 0 to 12 cents arriving only in the final third. The covenant applies here too: every point along every macro must sound finished. Tuning these curves is a named deliverable, shared between the patch-design agent and Mike through the rig below; when the macros are dialled in, everything downstream follows.

### Session-baked material (the emergent requirement)

At boot the seed bakes the raw material: wavetable banks from harmonic recipes (partial amplitudes under a spectral-tilt prior, comb notches, detuned partial pairs for shimmer), per-octave mip levels of every table for band-limited playback, modal ratio jitter within material tolerances, and the reverb impulse (seeded noise under a ~3.5 s exponential decay with a dark lowpass tilt). Timbres are born fresh each session inside a curated taste envelope; the patches define the envelope, the seed chooses the individual.

### Quality bar

The audible difference between a toy and an instrument lives below the surface; all of this is mandatory. Band-limited wavetable playback via the mip-mapped table sets. 2× oversampling on saturation stages. Aliasing under -60 dB on swept tests. Every parameter smoothed (zero zipper noise), denormals flushed, voice stealing with 5 ms fades, events applied at sample offsets inside the render quantum. Velocity shapes exciter hardness and brightness the way real mallets do. Seeded per-note micro-variation of exciter spectrum and modal jitter, so repeated notes never machine-gun. 48 kHz stereo throughout.

### The dev tuning rig

`?dev=1` opens a plain panel, excluded from the user experience entirely: every raw parameter of every patch, the macro breakpoint curves, per-spirit solo and audition keys, and copy-patch-to-clipboard JSON export. Tuned patches get pasted back into `src/audio/patches/` and committed as the shipped defaults. This is how the synth gets dialled in by ear; build it early, inside phase 2.

### The bus and the fog

One `VybezCore` AudioWorklet hosts all voices, message-driven, consuming the sample-stamped event queue. Stereo out feeds: gentle tape saturation (waveshaper) → master tone filter (Biquad lowpass whose openness tracks the fire) → parallel dry path + ConvolverNode wet path (the generated impulse above; this fog is where the Breath's swells live) → gentle bus compressor → soft-clip limiter → destination. Global wow and flutter ride here, as covenant rule 5 describes.

### Performance

Modal resonators are cheap; budget roughly 120 active modes plus 8 strings before optimising. Target under 40% of one core on a mid-tier laptop with all seven awake. Pool voices, cap polyphony per spirit. Desktop tabs keep playing in the background; mobile may suspend audio when backgrounded, which is acceptable; resume cleanly on visibilitychange.

## The visual symphony

PixiJS v8. Layered containers, back to front: sky, moon, far ridge, mid ruins, glade, spirits + talismans + objects, foreground flora, weather particles, grade overlay (procedural vignette, grain, optional scanlines and faint chromatic aberration for the VHS soul; respect prefers-reduced-motion by stilling the drift and grain).

Parallax: layers are wider than the viewport and pan at depth-scaled speeds in a slow ping-pong drift. The camera breathes with the fire (scale 1.000 to 1.015). Root and Drum onsets nudge the foreground 2 to 3 px with a spring return. Subtle, never seasick.

Onset-locked animation: this sells the entire illusion, so treat it as a first-class system. Spirits' playing frames advance on their own NoteEvents from the bus, with a gentle idle sway between events; the Drum's strike frame lands exactly on the hit. Asleep loops run slow; wake and sleep transitions play once.

Particles: pooled, budgeted, hue-fed from the live palette. Signatures: Drum, ember bursts from the ground; Rattle, brief glints; Root, low ripples; Voice, drifting motes that rise with pitch; Echo, paired motes trailing the Voice's; Spinner, orbiting sparks around the prayer wheel; Breath, slow fog banks. Emission gain follows fire intensity and note velocity.

Palette engine: seven base palettes, one per scale, each a 5-stop ramp. The moon's position rotates accent hues within ±25°; section turns ease one stop over 4 s; the fire warms the midtones. Apply colour via tint layers and a clamped ColorMatrix hue rotation so the painted art never breaks; never rotate hue beyond ±25°.

| Scale                  | Ramp (dark to light)                    |
| ---------------------- | --------------------------------------- |
| Aeolian                | #0b1026 #243b53 #5b7c8d #a8b8a6 #e8e3cf |
| Harmonic minor         | #140a1e #3c1430 #7a2742 #b35a4a #e8c9a0 |
| Hungarian minor        | #120f1a #38203f #74356b #b05a7e #ead0c2 |
| Double harmonic        | #0d0b1f #2a2150 #6b4d2e #c08a3e #f2dca6 |
| Blues minor pentatonic | #0a1418 #16323e #2f5d63 #8a6a45 #d8a05c |
| Major pentatonic       | #0c1714 #1f4034 #4f7a5a #a3b86c #f2e2b6 |
| Ionian                 | #1a1430 #4a2e57 #95566b #d9926f #ffe3b3 |

Treat these ramps as a starting grade; tune them against the real art when it lands.

## Architecture and contracts

Stack: TypeScript strict, Vite, PixiJS v8, ESLint + Prettier, Vitest for the music brain. No other runtime dependencies without justification in CLAUDE.md.

```
src/
  core/        rng.ts  bus.ts  time.ts
  conductor/   scales.ts  harmony.ts  patterns.ts  conductor.ts
  audio/       engine.ts  fx.ts  macros.ts  worklets/vybez-core.worklet.ts  patches/*.json
  visuals/     scene.ts  layers.ts  spirits.ts  particles.ts  palette.ts  grade.ts
  interact/    pointer.ts  controls.ts
  assets/      manifest.ts  loader.ts  placeholders.ts
  dev/         rig.ts
  main.ts
```

Write the contracts first; they are the law every subagent codes to:

```ts
type SpiritId = 'drum' | 'rattle' | 'root' | 'voice' | 'echo' | 'spinner' | 'breath' | 'world';

interface NoteEvent {
  spirit: SpiritId;
  time: number;
  midi?: number;
  velocity: number;
  duration: number;
  articulation?: string;
}
interface ControlEvent {
  target: string;
  value: number;
} // totem, moon, censer, fire, wind, busy:<id>, timbre:<id>, wake:<id>
interface SectionEvent {
  bar: number;
  chordRoot: number;
  chordTones: number[];
  scaleTones: number[];
  turn: boolean;
}
interface VoiceParams {
  morph: number;
  damp: number;
  bright: number;
  busy: number;
}
```

Bus topics: `note`, `control`, `section`, `palette`, `wake`. The conductor publishes; audio and visuals subscribe; interaction publishes `control` only. Nothing reaches across modules except through the bus and the contracts file.

## Asset pipeline

`public/assets/manifest.json` lists every expected file with dimensions, frame counts and grid (schema mirrors ASSETS.md). The loader validates each file against the manifest. Any missing or malformed file is replaced at runtime by `placeholders.ts`: generated, labelled, palette-tinted stand-ins (silhouette blocks for spirits with crude frame variation, gradient bands for layers). The app must be fully playable, start to finish, with zero real assets present. When Mike drops the real art in, it must require zero code changes.

## Build phases and acceptance

| Phase | Scope                                                                               | Accepted when                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0     | scaffold, contracts, bus, RNG, manifest + placeholders, CI                          | app boots, placeholder valley renders, typecheck and lint clean                                                                |
| 1     | clock, conductor skeleton, Vybez Core engine, Root + Drum patches audible           | steady groove at any BPM notch, sample-accurate, no drift over 10 min                                                          |
| 2     | all seven patches, macro curves, dev tuning rig, harmony chain, full pattern system | every scale sounds correct; covenant rules 1 to 4 unit-tested; each spirit identifiable blind; rig exports and reloads patches |
| 3     | diegetic controls wired (totem, moon, censer, fire, wind, spirits, talismans)       | every control audibly and visibly responds within 250 ms                                                                       |
| 4     | visual symphony: parallax, onset-locked animation, particles, palette               | visuals demonstrably driven by the same events as the audio                                                                    |
| 5     | wind drift, section turns, sleep subsets, the World bed                             | 30 minutes untouched on breeze stays interesting and consonant                                                                 |
| 6     | polish: FX bus tuning, mobile touch, performance, reduced motion, ignition flow     | clean on a mid phone; no console errors; CPU within budget                                                                     |

## Subagent orchestration

You are the orchestrator. Keep scaffold, contracts, integration and all code review in the main thread. Spawn subagents for the parallelisable middles, with lesser models scaled to task weight:

| Agent          | Model  | Owns                                                                                                                   | Acceptance gate                                                                                                                      |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| synth-core     | Sonnet | Vybez Core: voice architecture, resonators, wavetable playback, modulation matrix, anti-aliasing, FX bus, generated IR | renders the reference patch set from a scripted event list with no clicks, no zipper noise, and aliasing under -60 dB on swept tests |
| patch-design   | Sonnet | the seven patches, macro breakpoint curves, the dev tuning rig                                                         | each spirit identifiable blind; every macro sounds finished at every point of its travel; rig round-trips patch JSON                 |
| music-brain    | Sonnet | scales, harmony, patterns, conductor                                                                                   | Vitest: scale sets exact, Markov rows sum to 1, onset budget never exceeded, deterministic under fixed seed                          |
| visual-engine  | Sonnet | Pixi scene, layers, spirits, particles, palette, grade                                                                 | placeholder valley animates from a recorded event stream                                                                             |
| interaction    | Haiku  | pointer handling, hit areas, control mapping                                                                           | every object in the control table emits correct ControlEvents, mouse and touch                                                       |
| asset-pipeline | Haiku  | manifest, loader, placeholder generator                                                                                | deleting any asset file leaves the app fully playable                                                                                |
| qa             | Haiku  | lint, typecheck, unit runs, manual checklist upkeep                                                                    | green across the board each phase                                                                                                    |

Sequence: contracts → (synth-core ∥ music-brain ∥ asset-pipeline) → integrate phase 1 → patch-design ∥ (visual-engine ∥ interaction) → integrate → phases 5 and 6 yourself. Every subagent prompt must include the contracts file, its acceptance gate, and the style covenant below. Review every diff personally before merge. If a subagent stalls twice on the same task, take the task yourself.

## Style covenant for all text and docs

British spelling. Sentence case headings. No em dashes anywhere; use colons, semicolons, en dashes with spaces, or hyphens. Plain verbs in any user-facing string. The only in-fiction caption is "stoke the fire".

## Deploy

GitHub Pages via Actions. Vite `base: './'`. Standard build-and-deploy workflow on push to main. Keep the bundle lean; the heaviest things in this project should be Mike's paintings.

## Definition of done

Runs 30 minutes untouched on breeze without repetition fatigue, dissonance or audible glitches. No aliasing, no zipper noise; repeated notes stay alive; each of the seven is identifiable blind. Every control changes sound and image perceptibly within 250 ms. Fully playable with placeholder art alone. Different and beautiful on every fresh load. No persistence, no recording, no menus. The valley keeps its secrets.

## Open choices left to you

Exact Euclidean band per spirit, particle counts, the censer's physics feel, grain and scanline intensity, mobile layout crop. Decide, document in CLAUDE.md, and stay inside the covenant.
