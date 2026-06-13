import { Application, ColorMatrixFilter, Container, Sprite, Text } from 'pixi.js';
import type { AssetLibrary } from '../assets/loader';
import type { SpiritId } from '../core/contracts';
import { PLAYABLE_SPIRITS } from '../core/contracts';
import { bus } from '../core/bus';
import type { Session } from '../core/session';
import { secondsPerBeat } from '../core/time';

// The painted valley assembled in world space, dim and desaturated until the
// fire is stoked. Phase 3 gives every diegetic control a visible answer: the
// totem glow climbs, the moon walks the arc, the banner flutters with the
// wind, the censer swings to the tempo, spirits wake and sleep. Full
// onset-locked animation, parallax and particles arrive in phase 4.

/** The painted layers' native space; all placement happens in these units. */
const WORLD_W = 3840;
const WORLD_H = 1440;
/** Minimum horizontal overflow so the parallax drift always has room. */
const DRIFT_MARGIN = 800;
/** Pixel sprites are painted at one grid and scaled 2 to 3x in-app. */
const SPIRIT_SCALE = 2.5;

/** Feet stand 12 px above the cell bottom on every sheet. */
const FOOT_ANCHOR = (128 - 12) / 128;

const TOTEM_POS = { x: 820, y: 1010 };
/** Each carved head is 64 px tall in the sheet, drawn at 2x. */
const TOTEM_SEGMENT = 128;

/** Where each spirit stands, in world units; tuned against the real art later. */
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

export interface SceneHandles {
  world: Container;
  spirits: Map<SpiritId, Sprite>;
  talismans: Map<SpiritId, Sprite>;
  totem: Sprite;
  moon: Sprite;
  censer: Sprite;
  banner: Sprite;
  fire: Sprite;
  /** Convert a pointer's world x into a moon arc position 0 to 11. */
  moonPositionFromWorldX: (worldX: number) => number;
  ignite: () => void;
  ignited: boolean;
}

export function buildScene(app: Application, assets: AssetLibrary, session: Session): SceneHandles {
  const world = new Container();
  app.stage.addChild(world);

  const sky = Sprite.from(assets.get('bg_00_sky.png').texture);
  world.addChild(sky);

  const moon = Sprite.from(assets.get('moon.png').texture);
  moon.anchor.set(0.5);
  moon.scale.set(0.8);
  placeMoon(moon, session.moonPosition);
  world.addChild(moon);

  world.addChild(Sprite.from(assets.get('bg_01_far_ridge.png').texture));
  world.addChild(Sprite.from(assets.get('bg_02_mid_ruins.png').texture));
  world.addChild(Sprite.from(assets.get('bg_03_glade.png').texture));

  const actors = new Container();
  world.addChild(actors);

  const totem = Sprite.from(assets.get('totem_pole.png').texture);
  totem.anchor.set(0.5, 1);
  totem.scale.set(2);
  totem.position.set(TOTEM_POS.x, TOTEM_POS.y);
  actors.addChild(totem);

  // The glowing segment marks the active scale; it climbs as the totem clicks.
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
  const awake = new Map<PlayableId, boolean>();
  for (const id of PLAYABLE_SPIRITS) {
    if (id === 'world') continue;
    const pid = id as PlayableId;
    const spot = SPIRIT_SPOTS[pid];
    const isAwake = !session.asleep.has(id);
    awake.set(pid, isAwake);
    const sprite = Sprite.from(
      assets.animation(`spirit_${id}.png`, isAwake ? 'playing' : 'asleep')[0]!,
    );
    sprite.anchor.set(0.5, FOOT_ANCHOR);
    sprite.scale.set(SPIRIT_SCALE);
    sprite.position.set(spot.x, spot.y);
    actors.addChild(sprite);
    spirits.set(id, sprite);

    const talisman = Sprite.from(assets.frame(`talisman_${id}.png`, 0, 0));
    talisman.anchor.set(0.5, 1);
    talisman.scale.set(2);
    talisman.position.set(spot.x + 90, spot.y + 26);
    actors.addChild(talisman);
    talismans.set(id, talisman);
  }

  const fire = Sprite.from(assets.frame('fire_base.png', 0, 0));
  fire.anchor.set(0.5, 1);
  fire.scale.set(3);
  fire.position.set(FIRE_SPOT.x, FIRE_SPOT.y);
  actors.addChild(fire);

  world.addChild(Sprite.from(assets.get('bg_04_foreground.png').texture));

  // Pre-ignition grade: dim and desaturated until the first gesture.
  const grade = new ColorMatrixFilter();
  setGrade(grade, 0);
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

  const layout = (): void => {
    const vw = app.renderer.width;
    const vh = app.renderer.height;
    const scale = Math.max(vh / WORLD_H, vw / (WORLD_W - DRIFT_MARGIN));
    world.scale.set(scale);
    world.x = vw / 2 - FIRE_SPOT.x * scale;
    world.y = vh - WORLD_H * scale;
    caption.style.fontSize = Math.max(20, Math.min(vw, vh) * 0.045);
    caption.position.set(vw / 2, vh * 0.8);
  };
  layout();
  app.renderer.on('resize', layout);

  // Make every diegetic control hittable; the pointer layer attaches handlers.
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
        setGrade(grade, t);
        if (t >= 1) {
          world.filters = [];
          app.ticker.remove(tick);
        }
      };
      app.ticker.add(tick);
    },
  };

  // --- visual feedback: the scene answers control and wake events ---

  let windLevel = 0;
  let censerBpm = session.bpm;
  let bannerFrame = 0;
  let swing = 0;

  bus.subscribe('control', (e) => {
    if (e.target === 'totem') setTotemGlow(((Math.round(e.value) % 7) + 7) % 7);
    else if (e.target === 'moon') placeMoon(moon, e.value);
    else if (e.target === 'wind') windLevel = Math.round(e.value);
    else if (e.target === 'censer') censerBpm = e.value;
    else if (e.target === 'fire') {
      const frame = Math.min(5, Math.max(0, Math.round(((e.value - 0.35) / 0.65) * 5)));
      fire.texture = assets.frame('fire_base.png', frame, 0);
    }
  });

  bus.subscribe('wake', (e) => {
    if (e.spirit === 'world') return;
    const sprite = spirits.get(e.spirit);
    if (!sprite) return;
    awake.set(e.spirit as PlayableId, e.awake);
    // The wake or sleep transition plays once; phase 4 advances it on events.
    sprite.texture = assets.animation(`spirit_${e.spirit}.png`, e.awake ? 'playing' : 'asleep')[0]!;
  });

  // The censer swings to the beat; the banner flutters with the wind.
  if (!reducedMotion) {
    const bannerSpeeds = [0.04, 0.13, 0.28];
    app.ticker.add(() => {
      const dt = app.ticker.deltaMS / 1000;
      // Pendulum: one full sweep every two beats, crossing centre on the beat.
      const omega = Math.PI / secondsPerBeat(censerBpm);
      swing += dt * omega;
      censer.rotation = Math.sin(swing) * 0.16;
      bannerFrame = (bannerFrame + dt * (bannerSpeeds[windLevel] ?? 0.04) * 6) % 6;
      banner.texture = assets.frame('wind_banner.png', Math.floor(bannerFrame), 0);
    });
  }

  // The caption breathes until the fire is stoked.
  if (!reducedMotion) {
    let phase = 0;
    app.ticker.add(() => {
      if (handles.ignited) return;
      phase += app.ticker.deltaMS / 1000;
      caption.alpha = 0.65 + Math.sin(phase * 1.6) * 0.3;
    });
  }

  return handles;
}

/** t = 0 is the dim unlit valley; t = 1 is full colour. */
function setGrade(filter: ColorMatrixFilter, t: number): void {
  filter.reset();
  filter.saturate(-0.7 * (1 - t), false);
  filter.brightness(0.45 + 0.55 * t, true);
}

/** Twelve stops along the sky arc; the moon rises toward the centre. */
function placeMoon(moon: Sprite, position: number): void {
  const t = Math.max(0, Math.min(11, position)) / 11;
  const x = 350 + t * (WORLD_W - 700);
  const y = 520 - Math.sin(t * Math.PI) * 330;
  moon.position.set(x, y);
}
