import { Application, ColorMatrixFilter, Container, Sprite, Text } from 'pixi.js';
import type { AssetLibrary } from '../assets/loader';
import type { SpiritId } from '../core/contracts';
import { PLAYABLE_SPIRITS } from '../core/contracts';
import type { Session } from '../core/session';

// Phase 0 scene: the painted valley assembled in world space, dim and
// desaturated until the fire is stoked. Parallax, particles and onset-locked
// animation arrive in phase 4; this file only establishes the stage.

/** The painted layers' native space; all placement happens in these units. */
const WORLD_W = 3840;
const WORLD_H = 1440;
/** Minimum horizontal overflow so the parallax drift always has room. */
const DRIFT_MARGIN = 800;
/** Pixel sprites are painted at one grid and scaled 2 to 3x in-app. */
const SPIRIT_SCALE = 2.5;

/** Feet stand 12 px above the cell bottom on every sheet. */
const FOOT_ANCHOR = (128 - 12) / 128;

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

export interface SceneHandles {
  world: Container;
  spirits: Map<SpiritId, Sprite>;
  asleep: ReadonlySet<SpiritId>;
  fire: Sprite;
  ignite: () => void;
  ignited: boolean;
}

export function buildScene(app: Application, assets: AssetLibrary, session: Session): SceneHandles {
  const world = new Container();
  app.stage.addChild(world);

  // Back to front: sky, moon, far ridge, mid ruins, glade, actors, foreground.
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
  totem.position.set(820, 1010);
  actors.addChild(totem);

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

  // The seeded sleepers come from the shared session, so what the player sees
  // matches what the conductor plays.
  const asleep = session.asleep;

  const spirits = new Map<SpiritId, Sprite>();
  for (const id of PLAYABLE_SPIRITS) {
    if (id === 'world') continue;
    const spot = SPIRIT_SPOTS[id as Exclude<SpiritId, 'world'>];
    const pose = asleep.has(id) ? 'asleep' : 'playing';
    const sprite = Sprite.from(assets.animation(`spirit_${id}.png`, pose)[0]!);
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
    // Centre the fire horizontally; the mobile crop keeps the hearth in view.
    world.x = vw / 2 - FIRE_SPOT.x * scale;
    world.y = vh - WORLD_H * scale;
    caption.style.fontSize = Math.max(20, Math.min(vw, vh) * 0.045);
    caption.position.set(vw / 2, vh * 0.8);
  };
  layout();
  app.renderer.on('resize', layout);

  const handles: SceneHandles = {
    world,
    spirits,
    asleep,
    fire,
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

  // The fire is the one live control in phase 0: the ignition gesture.
  fire.eventMode = 'static';
  fire.cursor = 'pointer';
  fire.on('pointertap', handles.ignite);

  // The caption breathes, unless the visitor prefers reduced motion.
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
  const t = position / 11;
  const x = 350 + t * (WORLD_W - 700);
  const y = 520 - Math.sin(t * Math.PI) * 330;
  moon.position.set(x, y);
}
