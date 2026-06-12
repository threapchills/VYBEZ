# VYBEZ: asset manifest

Everything below drops into `public/assets/` with these exact filenames. The app runs on generated placeholders until then, so deliver in any order. PNG-24 with alpha throughout. Painted layers: paint or generate at full size, keep them slightly desaturated and low-contrast; the app applies the colour grade, so restraint in the source survives every palette. Pixel sprites: hard pixels, nearest-neighbour, no anti-aliasing, no partial-alpha edges, one consistent pixel grid (sprites are scaled 2 to 3× in-app).

Art direction in one breath: dark fantasy, liminal, 1980s. The Dark Crystal's puppet gravity, Heavy Metal's airbrushed dusk, a flicker of Rankin-Bass. Perpetual twilight; one warm ember accent against cool darks; never pure black, never pure white.

## Painted parallax layers (the world)

All layers 3840 × 1440 so the parallax has room to drift. Keep the horizon near 62% of frame height across every layer so they marry. Light comes from the moon upper-left and the fire at centre. Leave the moon out of the sky; it is a separate, draggable sprite.

| File                 | Alpha                 | Content                                                                                                     |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| bg_00_sky.png        | no                    | dusk gradient, thin cloud, faint stars; no moon, no ground                                                  |
| bg_01_far_ridge.png  | yes, above ridge line | mountain and mesa silhouettes, mist at their feet                                                           |
| bg_02_mid_ruins.png  | yes                   | megaliths, broken arches, a leaning monolith or two                                                         |
| bg_03_glade.png      | yes                   | the ground plane: a clearing with standing room for seven figures and a central fire pit, gentle path lines |
| bg_04_foreground.png | yes                   | framing flora and rock in near-silhouette, the darkest layer, overhanging top corners                       |

| File     | Size      | Notes                                                                                                         |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| moon.png | 512 × 512 | painted, soft glow baked into alpha, slightly sickle or veiled; it travels the sky arc and sets the root note |

## Pixel spirits (the seven)

One sprite sheet per spirit. Cell 128 × 128, 8 columns × 3 rows, sheet 1024 × 384. Unused cells stay empty. Feet on a consistent baseline ~12 px above the cell bottom.

Rows, top to bottom: asleep, 4 frames, slow loop, breathing or swaying, instrument dormant; waking, 6 frames, plays once, the rise or unfurling; playing, 8 frames, one full strike, pluck, bow or breath cycle with the point of contact on frame 1, since the app advances this row on actual note events.

Optional fourth row (sheet becomes 1024 × 512): fervent, 8 frames, a wilder playing cycle for high busyness.

| File               | Spirit      | Design seed (yours to overrule)                                         |
| ------------------ | ----------- | ----------------------------------------------------------------------- |
| spirit_drum.png    | The Drum    | broad horned mass hunched over three skin drums, arms like roots        |
| spirit_rattle.png  | The Rattle  | slight, quick, many-armed or feathered, hung with bones and shells      |
| spirit_root.png    | The Root    | low, ancient, half-sunk in the earth, plucking one thick sinew string   |
| spirit_voice.png   | The Voice   | tall and masked, the mask is the instrument, light leaks from its seams |
| spirit_echo.png    | The Echo    | the Voice's dim twin, translucent at the edges, bowing a shard          |
| spirit_spinner.png | The Spinner | small and serene, turning a wheel of tines, sparks orbiting             |
| spirit_breath.png  | The Breath  | veiled and instrumentless, fog spilling from sleeves, taller than all   |

## Interactive objects (pixel)

| File            | Size and frames                           | Notes                                                                  |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| totem_pole.png  | 96 × 448, static                          | seven stacked carved heads, 96 × 64 each, distinct faces bottom to top |
| totem_glow.png  | 96 × 64, 2 frames side by side (192 × 64) | additive glow overlay the app positions over the active segment        |
| censer.png      | 64 × 96, static                           | hanging brazier body; the app draws the chain and the swing            |
| fire_base.png   | 96 × 96, 6 frames in a row (576 × 96)     | the bonfire's heart; particles carry the rest of the flame             |
| wind_banner.png | 96 × 128, 6 frames in a row (576 × 128)   | tattered banner or chime cluster; loop reads as flutter                |

Talismans, one per spirit, 64 × 64, 2 frames side by side (128 × 64), frame 2 a faint shimmer: `talisman_drum.png, talisman_rattle.png, talisman_root.png, talisman_voice.png, talisman_echo.png, talisman_spinner.png, talisman_breath.png`.

## Optional polish

| File       | Size           | Notes                                             |
| ---------- | -------------- | ------------------------------------------------- |
| grain.png  | 256 × 256 tile | film grain, mid-grey neutral; app animates offset |
| cursor.png | 32 × 32        | a small ember or fingertip glyph                  |

Vignette and scanlines are procedural; skip them.

## Checklist

bg_00_sky.png, bg_01_far_ridge.png, bg_02_mid_ruins.png, bg_03_glade.png, bg_04_foreground.png, moon.png, spirit_drum.png, spirit_rattle.png, spirit_root.png, spirit_voice.png, spirit_echo.png, spirit_spinner.png, spirit_breath.png, totem_pole.png, totem_glow.png, censer.png, fire_base.png, wind_banner.png, talisman_drum.png, talisman_rattle.png, talisman_root.png, talisman_voice.png, talisman_echo.png, talisman_spinner.png, talisman_breath.png, grain.png (optional), cursor.png (optional).

Twenty-five files for a whole world. The valley waits.
