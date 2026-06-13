import type { Application, FederatedPointerEvent, Sprite } from 'pixi.js';
import { bus } from '../core/bus';
import type { SpiritId } from '../core/contracts';
import type { Session } from '../core/session';
import type { SceneHandles } from '../visuals/scene';
import {
  busyEvent,
  censerEvent,
  decayFire,
  fireEvent,
  moonEvent,
  nextScaleNotch,
  nextWind,
  stokeFire,
  timbreEvent,
  totemEvent,
  windEvent,
  type WindState,
} from './controls';

// The pointer layer owns geometry and bus publishing; controls.ts owns the
// arithmetic. Every diegetic object becomes a touch target: taps for the
// discrete controls (totem, wind, fire, wake), drags for the continuous ones
// (moon, censer, busyness, timbre). Mouse and touch both arrive as Pixi
// federated pointer events, so one code path serves both.

const TAP_SLOP = 6;

interface Drag {
  kind: 'moon' | 'censer' | 'busy' | 'timbre';
  id?: SpiritId;
  startX: number;
  startY: number;
  startValue: number;
  moved: boolean;
}

export function attachPointer(app: Application, handles: SceneHandles, session: Session): void {
  let scaleNotch = session.scaleIndex;
  let wind: WindState = 'still';
  let fire = session.fire;
  const busy = new Map<SpiritId, number>();
  const timbre = new Map<SpiritId, number>();

  let drag: Drag | undefined;

  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  // --- discrete taps ---

  handles.totem.on('pointertap', () => {
    scaleNotch = nextScaleNotch(scaleNotch);
    bus.publish('control', totemEvent(scaleNotch));
  });

  handles.banner.on('pointertap', () => {
    wind = nextWind(wind);
    bus.publish('control', windEvent(wind));
  });

  handles.fire.on('pointertap', () => {
    fire = stokeFire(fire);
    bus.publish('control', fireEvent(fire));
  });

  // --- spirits: tap wakes or sleeps, vertical drag sets busyness ---

  const awake = new Map<SpiritId, boolean>();
  for (const id of handles.spirits.keys()) awake.set(id, !session.asleep.has(id));

  for (const [id, sprite] of handles.spirits) {
    sprite.on('pointertap', () => {
      if (drag?.moved) return; // a drag, not a tap
      const next = !(awake.get(id) ?? true);
      awake.set(id, next);
      bus.publish('control', { target: `wake:${id}`, value: next ? 1 : 0 });
    });
    beginDrag(sprite, () => ({ kind: 'busy', id, startValue: busy.get(id) ?? 0.6 }));
  }

  // --- talismans: horizontal drag sets timbre ---

  for (const [id, sprite] of handles.talismans) {
    beginDrag(sprite, () => ({ kind: 'timbre', id, startValue: timbre.get(id) ?? 0.5 }));
  }

  // --- moon and censer drags ---

  beginDrag(handles.moon, () => ({ kind: 'moon', startValue: 0 }));
  beginDrag(handles.censer, () => ({ kind: 'censer', startValue: session.bpm }));

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
        bus.publish('control', moonEvent(handles.moonPositionFromWorldX(worldX)));
        break;
      }
      case 'censer': {
        // Drag up speeds the swing; settles to the nearest notch.
        const bpm = drag.startValue - dy * 0.2;
        bus.publish('control', censerEvent(bpm));
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
    }
  });

  const endDrag = (): void => {
    // Leave drag.moved readable through the tap that follows, then clear.
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
