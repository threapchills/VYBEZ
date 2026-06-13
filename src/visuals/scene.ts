import { Application, ColorMatrixFilter, Container, Sprite, Text, Texture } from 'pixi.js';
import type { AssetLibrary } from '../assets/loader';
import type { NoteEvent, SpiritId } from '../core/contracts';
import { PLAYABLE_SPIRITS } from '../core/contracts';
import { bus } from '../core/bus';
import type { Session } from '../core/session';
import { secondsPerBeat } from '../core/time';
import { ParticleField, type ParticleKind } from './particles';
import { moonHueRotation, paletteStops, toTint } from './palette';

// The painted valley, alive. Phase 4 binds image to sound: spirits strike on
// their own note events through the shared clock, particles spray each spirit's
// signature, the layers drift in parallax, the camera breathes with the fire,
// and the palette follows the scale, moon and fire. The same events drive the
// audio and the visuals, so they can never fall out of step.

const WORLD_W = 3840;
const WORLD_H = 1440;
const DRIFT_MARGIN = 800;
const SPIRIT_SCALE = 2.5;
const FOOT_ANCHOR = (128 - 12) / 128;

const TOTEM_POS = { x: 820, y: 1010 };
const TOTEM_SEGMENT = 128;

const SPIRIT_SPOTS: Record<Exclude<SpiritId, 'world'>, { x: number; y: number }> = {
  drum: { x: 1280, y: 1000 },
  rattle: { x: 1480, y: 960 },
  root: { x: 1660, y: 1020 },
  voice: { x: 2180, y: 990 },
  echo: { x: 2340, y: 950 },
  spinner: { x: 2520, y: 1005 },
  breath: { x: 2820, y: 940 },
};

const FIRE_SPOT = { x: 1920, y: 1030 };

type PlayableId = Exclude<SpiritId, 'world'>;

/** Parallax depth per layer index, sky (slowest) to foreground (fastest). */
const PARALLAX = [18, 40, 80, 120, 190];

interface SpiritAnim {
  awake: boolean;
  mode: 'asleep' | 'idle' | 'strike' | 'transition';
  t: number;
  strikeDur: number;
  dir: 1 | -1;
  swayPhase: number;
  asleepFrames: Texture[];
  playingFrames: Texture[];
  wakingFrames: Texture[];
}

export interface SceneHandles {
  world: Container;
  spirits: Map<SpiritId, Sprite>;
  talismans: Map<SpiritId, Sprite>;
  totem: Sprite;
  moon: Sprite;
  censer: Sprite;
  banner: Sprite;
  fire: Sprite;
  moonPositionFromWorldX: (worldX: number) => number;
  ignite: () => void;
  ignited: boolean;
}

export function buildScene(
  app: Application,
  assets: AssetLibrary,
  session: Session,
  clock: () => number,
): SceneHandles {
  const world = new Container();
  app.stage.addChild(world);

  const sky = Sprite.from(assets.get('bg_00_sky.png').texture);
  world.addChild(sky);

  const moon = Sprite.from(assets.get('moon.png').texture);
  moon.anchor.set(0.5);
  moon.scale.set(0.8);
  world.addChild(moon);
  // The moon's resting place; parallax adds a little drift on top each frame.
  let moonBaseX = 0;
  const setMoonPos = (position: number): void => {
    const t = Math.max(0, Math.min(11, position)) / 11;
    moonBaseX = 350 + t * (WORLD_W - 700);
    moon.x = moonBaseX;
    moon.y = 520 - Math.sin(t * Math.PI) * 330;
  };
  setMoonPos(session.moonPosition);

  const ridge = Sprite.from(assets.get('bg_01_far_ridge.png').texture);
  const ruins = Sprite.from(assets.get('bg_02_mid_ruins.png').texture);
  const glade = Sprite.from(assets.get('bg_03_glade.png').texture);
  world.addChild(ridge, ruins, glade);

  const actors = new Container();
  world.addChild(actors);

  const totem = Sprite.from(assets.get('totem_pole.png').texture);
  totem.anchor.set(0.5, 1);
  totem.scale.set(2);
  totem.position.set(TOTEM_POS.x, TOTEM_POS.y);
  actors.addChild(totem);

  const glow = Sprite.from(assets.frame('totem_glow.png', 0, 0));
  glow.anchor.set(0.5);
  glow.scale.set(2);
  glow.blendMode = 'add';
  glow.x = TOTEM_POS.x;
  actors.addChild(glow);
  const setTotemGlow = (notch: number): void => {
    glow.y = TOTEM_POS.y - (notch + 0.5) * TOTEM_SEGMENT;
  };
  setTotemGlow(session.scaleIndex);

  const banner = Sprite.from(assets.frame('wind_banner.png', 0, 0));
  banner.anchor.set(0.5, 1);
  banner.scale.set(2.5);
  banner.position.set(1060, 1000);
  actors.addChild(banner);

  const censer = Sprite.from(assets.frame('censer.png', 0, 0));
  censer.anchor.set(0.5, 0);
  censer.scale.set(2.5);
  censer.position.set(2660, 620);
  actors.addChild(censer);

  const spirits = new Map<SpiritId, Sprite>();
  const talismans = new Map<SpiritId, Sprite>();
  const anims = new Map<PlayableId, SpiritAnim>();
  for (const id of PLAYABLE_SPIRITS) {
    if (id === 'world') continue;
    const pid = id as PlayableId;
    const spot = SPIRIT_SPOTS[pid];
    const asleepFrames = assets.animation(`spirit_${id}.png`, 'asleep');
    const playingFrames = assets.animation(`spirit_${id}.png`, 'playing');
    const wakingFrames = assets.animation(`spirit_${id}.png`, 'waking');
    const isAwake = !session.asleep.has(id);
    const sprite = new Sprite(isAwake ? playingFrames[0]! : asleepFrames[0]!);
    sprite.anchor.set(0.5, FOOT_ANCHOR);
    sprite.scale.set(SPIRIT_SCALE);
    sprite.position.set(spot.x, spot.y);
    actors.addChild(sprite);
    spirits.set(id, sprite);
    anims.set(pid, {
      awake: isAwake,
      mode: isAwake ? 'idle' : 'asleep',
      t: 0,
      strikeDur: 0.4,
      dir: 1,
      swayPhase: Math.random() * Math.PI * 2,
      asleepFrames,
      playingFrames,
      wakingFrames,
    });

    const talisman = Sprite.from(assets.frame(`talisman_${id}.png`, 0, 0));
    talisman.anchor.set(0.5, 1);
    talisman.scale.set(2);
    talisman.position.set(spot.x + 90, spot.y + 26);
    actors.addChild(talisman);
    talismans.set(id, talisman);
  }

  // Particles render in front of the spirits but behind the foreground.
  const particles = new ParticleField();
  world.addChild(particles.container);

  const fire = Sprite.from(assets.frame('fire_base.png', 0, 0));
  fire.anchor.set(0.5, 1);
  fire.scale.set(3);
  fire.position.set(FIRE_SPOT.x, FIRE_SPOT.y);
  actors.addChild(fire);

  const foreground = Sprite.from(assets.get('bg_04_foreground.png').texture);
  world.addChild(foreground);
  const layers = [sky, ridge, ruins, glade, foreground];

  // Pre-ignition grade; after ignition the palette grade takes the filter over.
  const grade = new ColorMatrixFilter();
  setIgniteGrade(grade, 0);
  world.filters = [grade];

  const caption = new Text({
    text: 'stoke the fire',
    style: {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontStyle: 'italic',
      fill: '#e8e3cf',
      fontSize: 28,
    },
  });
  caption.anchor.set(0.5);
  app.stage.addChild(caption);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Live palette state, seeded from the session, updated by the conductor.
  let curScale = session.scaleIndex;
  let curMoon = session.moonPosition;
  let curFire = session.fire;
  let accentTint = toTint(paletteStops(curScale, curMoon, curFire)[4] ?? '#e8e3cf');
  const applyPalette = (): void => {
    accentTint = toTint(paletteStops(curScale, curMoon, curFire)[4] ?? '#e8e3cf');
    if (!handles.ignited) return;
    grade.reset();
    grade.hue(moonHueRotation(curMoon), false);
    const fireNorm = (curFire - 0.35) / 0.65;
    grade.brightness(0.95 + 0.12 * fireNorm, true);
    grade.saturate(0.1 * fireNorm, true);
  };

  let baseScale = 1;
  const layout = (): void => {
    const vw = app.renderer.width;
    const vh = app.renderer.height;
    baseScale = Math.max(vh / WORLD_H, vw / (WORLD_W - DRIFT_MARGIN));
    world.scale.set(baseScale);
    world.x = vw / 2 - FIRE_SPOT.x * baseScale;
    world.y = vh - WORLD_H * baseScale;
    caption.style.fontSize = Math.max(20, Math.min(vw, vh) * 0.045);
    caption.position.set(vw / 2, vh * 0.8);
  };
  layout();
  app.renderer.on('resize', layout);

  for (const target of [
    totem,
    banner,
    censer,
    moon,
    fire,
    ...spirits.values(),
    ...talismans.values(),
  ]) {
    target.eventMode = 'static';
    target.cursor = 'pointer';
  }

  const handles: SceneHandles = {
    world,
    spirits,
    talismans,
    totem,
    moon,
    censer,
    banner,
    fire,
    moonPositionFromWorldX: (worldX) => {
      const t = (worldX - 350) / (WORLD_W - 700);
      return Math.max(0, Math.min(11, Math.round(t * 11)));
    },
    ignited: false,
    ignite: () => {
      if (handles.ignited) return;
      handles.ignited = true;
      caption.visible = false;
      let t = 0;
      const tick = (): void => {
        t = Math.min(1, t + app.ticker.deltaMS / 2000);
        setIgniteGrade(grade, t);
        if (t >= 1) {
          app.ticker.remove(tick);
          applyPalette(); // hand the filter over to the palette grade
        }
      };
      app.ticker.add(tick);
    },
  };

  // --- control and wake feedback (phase 3) ---

  let windLevel = 0;
  let censerBpm = session.bpm;
  let bannerFrame = 0;
  let swing = 0;

  bus.subscribe('control', (e) => {
    if (e.target === 'totem') setTotemGlow(((Math.round(e.value) % 7) + 7) % 7);
    else if (e.target === 'moon') setMoonPos(e.value);
    else if (e.target === 'wind') windLevel = Math.round(e.value);
    else if (e.target === 'censer') censerBpm = e.value;
    else if (e.target === 'fire') {
      const frame = Math.min(5, Math.max(0, Math.round(((e.value - 0.35) / 0.65) * 5)));
      fire.texture = assets.frame('fire_base.png', frame, 0);
    }
  });

  bus.subscribe('palette', (e) => {
    curScale = e.scaleIndex;
    curMoon = e.moonPosition;
    curFire = e.fire;
    applyPalette();
  });

  bus.subscribe('wake', (e) => {
    if (e.spirit === 'world') return;
    const anim = anims.get(e.spirit as PlayableId);
    if (!anim) return;
    anim.awake = e.awake;
    anim.mode = 'transition';
    anim.t = 0;
    anim.dir = e.awake ? 1 : -1;
  });

  // --- onset-locked animation: strikes land on the note's own time ---

  const pending: NoteEvent[] = [];
  bus.subscribe('note', (e) => {
    if (e.spirit === 'world') return;
    pending.push(e);
  });

  let foreNudge = 0;

  app.ticker.add(() => {
    const dt = app.ticker.deltaMS / 1000;
    const now = clock();

    // Fire any onsets whose time has arrived.
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i]!;
      if (e.time <= now || e.time - now > 4) {
        if (e.time >= now - 0.25) triggerOnset(e);
        pending.splice(i, 1);
      }
    }

    advanceSpirits(dt, app.ticker.lastTime / 1000);
    particles.update(dt);

    // Foreground spring nudge from Drum and Root onsets.
    foreNudge *= 0.84;
    foreground.y = foreNudge;

    if (!reducedMotion) {
      // Parallax ping-pong and the censer swing and banner flutter.
      const drift = Math.sin((app.ticker.lastTime / 1000) * 0.06);
      for (let i = 0; i < layers.length; i++) {
        (layers[i] as Sprite).x = drift * (PARALLAX[i] ?? 0);
      }
      moon.x = moonBaseX + drift * 26;

      const omega = Math.PI / secondsPerBeat(censerBpm);
      swing += dt * omega;
      censer.rotation = Math.sin(swing) * 0.16;
      bannerFrame = (bannerFrame + dt * (BANNER_SPEEDS[windLevel] ?? 0.04) * 6) % 6;
      banner.texture = assets.frame('wind_banner.png', Math.floor(bannerFrame), 0);

      // Camera breathes with the fire.
      const breath =
        1 +
        0.015 *
          ((curFire - 0.35) / 0.65) *
          (0.5 + 0.5 * Math.sin((app.ticker.lastTime / 1000) * 0.5));
      const s = baseScale * breath;
      world.scale.set(s);
      world.x = app.renderer.width / 2 - FIRE_SPOT.x * s;
      world.y = app.renderer.height - WORLD_H * s;
    }

    if (!handles.ignited && !reducedMotion) {
      caption.alpha = 0.65 + Math.sin((app.ticker.lastTime / 1000) * 1.6) * 0.3;
    }
  });

  function triggerOnset(e: NoteEvent): void {
    const id = e.spirit as PlayableId;
    const anim = anims.get(id);
    const sprite = spirits.get(e.spirit);
    if (!anim || !sprite) return;
    if (anim.awake && anim.mode !== 'transition') {
      anim.mode = 'strike';
      anim.t = 0;
      anim.strikeDur = Math.min(0.5, Math.max(0.14, e.duration));
    }
    // Particle signature, hue-fed and gain-scaled by fire and velocity.
    // Particles are motion, so a visitor who asked for less gets none.
    if (!reducedMotion) {
      const pitch01 = e.midi !== undefined ? Math.max(0, Math.min(1, (e.midi - 24) / 60)) : 0.5;
      particles.emit(id as ParticleKind, sprite.x, sprite.y - 60, {
        tint: accentTint,
        velocity: e.velocity,
        fire: curFire,
        pitch01,
      });
    }
    if (e.spirit === 'drum' || e.spirit === 'root') {
      foreNudge = Math.min(3, foreNudge + 2.4 * e.velocity);
    }
  }

  function advanceSpirits(dt: number, globalT: number): void {
    for (const [id, anim] of anims) {
      const sprite = spirits.get(id);
      if (!sprite) continue;
      anim.t += dt;
      switch (anim.mode) {
        case 'asleep': {
          const f = Math.floor(anim.t * 3) % anim.asleepFrames.length;
          sprite.texture = anim.asleepFrames[f]!;
          sprite.rotation = Math.sin(globalT * 0.8 + anim.swayPhase) * 0.015;
          break;
        }
        case 'idle': {
          sprite.texture = anim.playingFrames[0]!;
          sprite.rotation = Math.sin(globalT * 1.4 + anim.swayPhase) * 0.03;
          break;
        }
        case 'strike': {
          const p = anim.t / anim.strikeDur;
          if (p >= 1) {
            anim.mode = 'idle';
            anim.t = 0;
          } else {
            const f = Math.min(
              anim.playingFrames.length - 1,
              Math.floor(p * anim.playingFrames.length),
            );
            sprite.texture = anim.playingFrames[f]!;
          }
          break;
        }
        case 'transition': {
          const dur = 0.5;
          const p = Math.min(1, anim.t / dur);
          const frames = anim.wakingFrames;
          const idx = anim.dir === 1 ? p : 1 - p;
          const f = Math.min(frames.length - 1, Math.floor(idx * frames.length));
          sprite.texture = frames[f]!;
          if (p >= 1) {
            anim.mode = anim.awake ? 'idle' : 'asleep';
            anim.t = 0;
          }
          break;
        }
      }
    }
  }

  // --- diegetic affordance and feedback ---
  // Every control wears a soft warm glow so it reads as touchable; it brightens
  // on hover, bounces on press, and flares when its value actually changes, so
  // cause and effect are unmistakable. The covenant forbids a HUD, so this is
  // how the valley says "touch me" and "you did that" without a word.

  const glowTex = makeSoftDot();
  const glowLayer = new Container();
  glowLayer.blendMode = 'add';
  world.addChildAt(glowLayer, world.getChildIndex(actors));

  interface Fb {
    obj: Sprite;
    glow: Sprite;
    base: number;
    offX: number;
    offY: number;
    phase: number;
    hover: number;
    press: number;
    flare: number;
  }
  const fbByObj = new Map<Sprite, Fb>();
  const fbList: Fb[] = [];
  const addFb = (obj: Sprite): void => {
    const w = obj.width;
    const h = obj.height;
    const offX = w * (0.5 - obj.anchor.x);
    const offY = h * (0.5 - obj.anchor.y);
    const glow = new Sprite(glowTex);
    glow.anchor.set(0.5);
    glow.position.set(obj.x + offX, obj.y + offY);
    glow.scale.set((Math.max(w, h) * 1.8) / glowTex.width);
    glow.alpha = 0;
    glowLayer.addChild(glow);
    const fb: Fb = {
      obj,
      glow,
      base: obj.scale.x,
      offX,
      offY,
      phase: Math.random() * 6.28,
      hover: 0,
      press: 0,
      flare: 0,
    };
    fbByObj.set(obj, fb);
    fbList.push(fb);
    obj.on('pointerover', () => (fb.hover = 1));
    obj.on('pointerout', () => {
      fb.hover = 0;
      fb.press = 0;
    });
    obj.on('pointerdown', () => (fb.press = 1));
    obj.on('pointerup', () => (fb.press = 0));
    obj.on('pointerupoutside', () => (fb.press = 0));
  };
  for (const obj of [
    totem,
    moon,
    censer,
    banner,
    fire,
    ...spirits.values(),
    ...talismans.values(),
  ]) {
    addFb(obj);
  }
  const flare = (obj: Sprite | undefined): void => {
    const fb = obj && fbByObj.get(obj);
    if (fb) fb.flare = 1;
  };

  // A change to any control flares its object so the touch reads as effective.
  let lastFire = curFire;
  bus.subscribe('control', (e) => {
    if (e.target === 'totem') flare(totem);
    else if (e.target === 'moon') flare(moon);
    else if (e.target === 'censer') flare(censer);
    else if (e.target === 'wind') flare(banner);
    else if (e.target === 'fire') {
      flare(fire);
      if (e.value > lastFire + 0.001 && !reducedMotion) {
        particles.emit('drum', fire.x, fire.y - 80, {
          tint: accentTint,
          velocity: 1,
          fire: e.value,
        });
      }
      lastFire = e.value;
    } else if (e.target.startsWith('busy:')) flare(spirits.get(e.target.slice(5) as SpiritId));
    else if (e.target.startsWith('timbre:')) flare(talismans.get(e.target.slice(7) as SpiritId));
  });
  bus.subscribe('wake', (e) => flare(spirits.get(e.spirit)));

  // Once the fire is lit, a beckoning shimmer travels the controls in turn,
  // teaching the eye where the valley can be touched.
  let guided = false;
  app.ticker.add(() => {
    if (handles.ignited && !guided) {
      guided = true;
      fbList.forEach((fb, i) => {
        window.setTimeout(() => (fb.flare = Math.max(fb.flare, 1)), 500 + i * 150);
      });
    }
    const t = app.ticker.lastTime / 1000;
    for (const fb of fbList) {
      fb.press *= 0.82;
      fb.flare *= 0.9;
      const idle = handles.ignited ? 0.1 + 0.05 * Math.sin(t * 1.6 + fb.phase) : 0;
      fb.glow.alpha = Math.min(0.95, idle + fb.hover * 0.28 + fb.press * 0.4 + fb.flare * 0.65);
      fb.glow.tint = accentTint;
      fb.glow.position.set(fb.obj.x + fb.offX, fb.obj.y + fb.offY);
      fb.obj.scale.set(fb.base * (1 + fb.press * 0.06 + fb.flare * 0.05 + fb.hover * 0.03));
    }
  });

  return handles;
}

const BANNER_SPEEDS = [0.04, 0.13, 0.28];

/** A soft round dot for the control glows, white so it can take any tint. */
function makeSoftDot(): Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

/** t = 0 is the dim unlit valley; t = 1 hands over to the palette grade. */
function setIgniteGrade(filter: ColorMatrixFilter, t: number): void {
  filter.reset();
  filter.saturate(-0.7 * (1 - t), false);
  filter.brightness(0.45 + 0.55 * t, true);
}
