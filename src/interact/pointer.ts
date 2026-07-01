import type { Application, FederatedPointerEvent, Sprite } from 'pixi.js';
import { bus } from '../core/bus';
import type { SpiritId } from '../core/contracts';
import type { Session } from '../core/session';
import type { SceneHandles } from '../visuals/scene';
import { WORLD_H, WORLD_W } from '../visuals/scene';
import {
  busyEvent,
  censerEvent,
  decayFire,
  fireEvent,
  moonEvent,
  nextScaleNotch,
  nextWind,
  snapCenser,
  stokeFire,
  strumEvent,
  timbreEvent,
  totemEvent,
  windEvent,
  type WindState,
} from './controls';

// The pointer layer owns geometry and bus publishing; controls.ts owns the
// arithmetic. Every diegetic object answers a tap (so a click always does
// something audible) and a drag (for continuous, fine control). One federated
// code path serves mouse and touch alike.

const TAP_SLOP = 6;
const TIMBRE_STEP = 0.25;
/** Below this world y the valley floor begins; above it, the sky harp answers. */
const SKY_MAX_Y = 860;
/** The harp's strings: sweeping a drag across bands strums them in turn. */
const STRUM_BANDS = 24;

interface Drag {
  kind: 'moon' | 'censer' | 'busy' | 'timbre' | 'strum';
  id?: SpiritId;
  startX: number;
  startY: number;
  startValue: number;
  moved: boolean;
}

export function attachPointer(app: Application, handles: SceneHandles, session: Session): void {
  let scaleNotch = session.scaleIndex;
  let moonPos = session.moonPosition;
  let bpm = session.bpm;
  // Breeze by default: the valley evolves unasked; still is a choice, not the start.
  let wind: WindState = 'breeze';
  let fire = session.fire;
  const busy = new Map<SpiritId, number>();
  const timbre = new Map<SpiritId, number>();
  const awake = new Map<SpiritId, boolean>();
  for (const id of handles.spirits.keys()) awake.set(id, !session.asleep.has(id));

  let drag: Drag | undefined;
  // The stage stays hittable-through: a hitArea here would swallow every hit
  // before the sprites are tested (the phase 3 to 6 dead-controls bug). The
  // scene's backdrop is the catch-all surface instead; global and bubbled
  // events still reach the stage for drag tracking.
  app.stage.eventMode = 'static';

  /** Wrap a tap handler so it never fires at the end of a drag. */
  const tap = (fn: () => void) => () => {
    if (!drag?.moved) fn();
  };

  // Totem: each tap clicks the scale up a notch, wrapping at the top.
  handles.totem.on(
    'pointertap',
    tap(() => {
      scaleNotch = nextScaleNotch(scaleNotch);
      bus.publish('control', totemEvent(scaleNotch));
    }),
  );

  // Wind banner: tap cycles still, breeze, gale.
  handles.banner.on(
    'pointertap',
    tap(() => {
      wind = nextWind(wind);
      bus.publish('control', windEvent(wind));
    }),
  );

  // Fire: tap stokes it brighter.
  handles.fire.on(
    'pointertap',
    tap(() => {
      fire = stokeFire(fire);
      bus.publish('control', fireEvent(fire));
    }),
  );

  // Moon: tap walks the root up a step; drag slides it along the arc.
  handles.moon.on(
    'pointertap',
    tap(() => {
      moonPos = (moonPos + 1) % 12;
      bus.publish('control', moonEvent(moonPos));
    }),
  );
  beginDrag(handles.moon, () => ({ kind: 'moon', startValue: 0 }));

  // Censer: tap nudges the tempo a notch; drag pushes the swing.
  handles.censer.on(
    'pointertap',
    tap(() => {
      bpm = bpm + 4 > 92 ? 60 : bpm + 4;
      bus.publish('control', censerEvent(bpm));
    }),
  );
  beginDrag(handles.censer, () => ({ kind: 'censer', startValue: bpm }));

  // Spirits: tap wakes or sleeps; vertical drag sets busyness.
  for (const [id, sprite] of handles.spirits) {
    sprite.on(
      'pointertap',
      tap(() => {
        const next = !(awake.get(id) ?? true);
        awake.set(id, next);
        bus.publish('control', { target: `wake:${id}`, value: next ? 1 : 0 });
      }),
    );
    beginDrag(sprite, () => ({ kind: 'busy', id, startValue: busy.get(id) ?? 0.6 }));
  }

  // The sky harp: a tap on the open sky rings a tine; a sweep strums the
  // strings in turn. The backdrop only receives touches no control claimed,
  // so the controls always win the argument.
  const strumAt = (e: FederatedPointerEvent): void => {
    const wp = handles.world.toLocal(e.global);
    bus.publish(
      'control',
      strumEvent(wp.x / WORLD_W, Math.max(0, Math.min(1, wp.y / WORLD_H))),
    );
  };
  handles.backdrop.on('pointertap', (e: FederatedPointerEvent) => {
    if (drag?.moved) return;
    const wp = handles.world.toLocal(e.global);
    if (wp.y < SKY_MAX_Y) strumAt(e);
  });
  handles.backdrop.on('pointerdown', (e: FederatedPointerEvent) => {
    const wp = handles.world.toLocal(e.global);
    if (wp.y >= SKY_MAX_Y) return;
    drag = {
      kind: 'strum',
      startX: e.global.x,
      startY: e.global.y,
      startValue: Math.floor((wp.x / WORLD_W) * STRUM_BANDS),
      moved: false,
    };
  });

  // Talismans: tap steps the timbre; drag morphs it continuously.
  for (const [id, sprite] of handles.talismans) {
    sprite.on(
      'pointertap',
      tap(() => {
        let v = (timbre.get(id) ?? 0) + TIMBRE_STEP;
        if (v > 1.0001) v = 0;
        v = Math.min(1, v);
        timbre.set(id, v);
        bus.publish('control', timbreEvent(id, v));
      }),
    );
    beginDrag(sprite, () => ({ kind: 'timbre', id, startValue: timbre.get(id) ?? 0.5 }));
  }

  function beginDrag(
    sprite: Sprite,
    make: () => { kind: Drag['kind']; id?: SpiritId; startValue: number },
  ): void {
    sprite.on('pointerdown', (e: FederatedPointerEvent) => {
      const seed = make();
      drag = { ...seed, startX: e.global.x, startY: e.global.y, moved: false };
    });
  }

  app.stage.on('globalpointermove', (e: FederatedPointerEvent) => {
    if (!drag) return;
    const dx = e.global.x - drag.startX;
    const dy = e.global.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    drag.moved = true;

    switch (drag.kind) {
      case 'moon': {
        const worldX = handles.world.toLocal(e.global).x;
        moonPos = handles.moonPositionFromWorldX(worldX);
        bus.publish('control', moonEvent(moonPos));
        break;
      }
      case 'censer': {
        const raw = drag.startValue - dy * 0.2;
        bpm = snapCenser(raw);
        bus.publish('control', censerEvent(raw));
        break;
      }
      case 'busy': {
        if (!drag.id) break;
        const v = clamp01(drag.startValue - dy / 220);
        busy.set(drag.id, v);
        bus.publish('control', busyEvent(drag.id, v));
        break;
      }
      case 'timbre': {
        if (!drag.id) break;
        const v = clamp01(drag.startValue + dx / 220);
        timbre.set(drag.id, v);
        bus.publish('control', timbreEvent(drag.id, v));
        break;
      }
      case 'strum': {
        // Each band boundary crossed rings the next string.
        const wp = handles.world.toLocal(e.global);
        const band = Math.floor((wp.x / WORLD_W) * STRUM_BANDS);
        if (band !== drag.startValue) {
          drag.startValue = band;
          strumAt(e);
        }
        break;
      }
    }
  });

  const endDrag = (): void => {
    if (drag) drag = { ...drag };
    queueMicrotask(() => {
      drag = undefined;
    });
  };
  app.stage.on('pointerup', endDrag);
  app.stage.on('pointerupoutside', endDrag);

  // The fire cools toward its floor; publish the slow walk back down.
  let since = 0;
  app.ticker.add(() => {
    since += app.ticker.deltaMS;
    if (since < 1000) return;
    const dt = since / 1000;
    since = 0;
    const cooled = decayFire(fire, dt);
    if (Math.abs(cooled - fire) > 0.001) {
      fire = cooled;
      bus.publish('control', fireEvent(fire));
    }
  });
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
