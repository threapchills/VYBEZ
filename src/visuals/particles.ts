import { Container, Sprite, Texture } from 'pixi.js';

// Pooled, budgeted particles, hue-fed from the live palette. Each spirit has a
// signature spray that fires on its own note events: the Drum throws embers,
// the Voice drifts motes that rise with pitch, the Spinner orbits sparks, the
// Breath rolls slow fog. One soft dot texture, tinted and blended additively,
// keeps the whole field cheap enough to run with all seven awake.

const MAX_PARTICLES = 420;

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
  maxLife: number;
  spin: number;
  fade: number;
  active: boolean;
}

export type ParticleKind =
  | 'drum'
  | 'rattle'
  | 'root'
  | 'voice'
  | 'echo'
  | 'spinner'
  | 'breath'
  | 'strum';

export class ParticleField {
  readonly container = new Container();
  private readonly pool: Particle[] = [];
  private cursor = 0;
  private readonly texture: Texture;

  constructor() {
    this.texture = makeDotTexture();
    this.container.blendMode = 'add';
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const sprite = new Sprite(this.texture);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.container.addChild(sprite);
      this.pool.push({
        sprite,
        vx: 0,
        vy: 0,
        gravity: 0,
        life: 0,
        maxLife: 1,
        spin: 0,
        fade: 1,
        active: false,
      });
    }
  }

  /**
   * Fire a spirit's signature burst at a world point. Emission gain follows the
   * fire intensity and the note velocity, exactly as the brief asks.
   */
  emit(
    kind: ParticleKind,
    x: number,
    y: number,
    opts: { tint: number; velocity: number; fire: number; pitch01?: number },
  ): void {
    const gain = 0.5 + 0.6 * opts.fire;
    const v = opts.velocity;
    const pitch = opts.pitch01 ?? 0.5;
    // Generous counts and a high floor so the spray is always clearly visible.
    const n = (k: number): number => Math.max(3, Math.round(k * gain * (0.7 + v) * 1.6));

    switch (kind) {
      case 'drum':
        this.spawn(n(8), x, y, opts.tint, {
          speed: [120, 320],
          angle: [-Math.PI / 2 - 0.7, -Math.PI / 2 + 0.7],
          gravity: 520,
          size: [0.3, 0.7],
          life: [0.5, 1.1],
        });
        break;
      case 'rattle':
        this.spawn(n(5), x, y, opts.tint, {
          speed: [60, 220],
          angle: [-Math.PI, Math.PI],
          gravity: 40,
          size: [0.12, 0.32],
          life: [0.18, 0.4],
        });
        break;
      case 'root':
        this.spawn(n(4), x, y, opts.tint, {
          speed: [80, 180],
          angle: [-0.25, 0.25],
          mirror: true,
          gravity: -10,
          size: [0.4, 0.8],
          life: [0.7, 1.3],
        });
        break;
      case 'voice':
        // Motes rise with pitch: higher notes lift faster and further.
        this.spawn(n(3), x, y, opts.tint, {
          speed: [30, 90 + pitch * 140],
          angle: [-Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5],
          gravity: -30 - pitch * 60,
          size: [0.25, 0.5],
          life: [1.2, 2.4],
        });
        break;
      case 'echo':
        // Paired motes, a dimmer twin of the Voice's, trailing to one side.
        this.spawn(n(2), x, y, opts.tint, {
          speed: [30, 90],
          angle: [-Math.PI / 2 - 0.3, -Math.PI / 2 + 0.3],
          gravity: -25,
          size: [0.2, 0.4],
          life: [1.0, 2.0],
          fade: 0.6,
        });
        break;
      case 'spinner':
        // Orbiting sparks: tangential velocity and a touch of spin.
        this.spawn(n(4), x, y, opts.tint, {
          speed: [140, 240],
          angle: [-Math.PI, Math.PI],
          gravity: 0,
          size: [0.15, 0.3],
          life: [0.4, 0.9],
          spin: 6,
        });
        break;
      case 'breath':
        // Slow fog banks: large, soft, long-lived, barely moving.
        this.spawn(n(2), x, y, opts.tint, {
          speed: [10, 40],
          angle: [-Math.PI, Math.PI],
          gravity: -4,
          size: [1.6, 3.2],
          life: [3, 6],
          fade: 0.35,
        });
        break;
      case 'strum':
        // A star rung: quick radial sparks and a lingering rising mote.
        this.spawn(n(6), x, y, opts.tint, {
          speed: [40, 200],
          angle: [-Math.PI, Math.PI],
          gravity: 12,
          size: [0.15, 0.4],
          life: [0.4, 1.0],
          spin: 4,
        });
        this.spawn(2, x, y, opts.tint, {
          speed: [5, 20],
          angle: [-Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4],
          gravity: -12,
          size: [0.7, 1.1],
          life: [1.2, 2.0],
          fade: 0.5,
        });
        break;
    }
  }

  private spawn(
    count: number,
    x: number,
    y: number,
    tint: number,
    s: {
      speed: [number, number];
      angle: [number, number];
      gravity: number;
      size: [number, number];
      life: [number, number];
      spin?: number;
      mirror?: boolean;
      fade?: number;
    },
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
      if (!p) continue;
      const speed = rand(s.speed[0], s.speed[1]);
      let angle = rand(s.angle[0], s.angle[1]);
      if (s.mirror && Math.random() < 0.5) angle = Math.PI - angle;
      // Bigger motes so the spray reads clearly against the painted scene.
      const size = rand(s.size[0], s.size[1]) * 1.5;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.gravity = s.gravity;
      p.maxLife = rand(s.life[0], s.life[1]);
      p.life = p.maxLife;
      p.spin = s.spin ? rand(-s.spin, s.spin) : 0;
      p.fade = s.fade ?? 1;
      p.active = true;
      p.sprite.visible = true;
      p.sprite.tint = tint;
      p.sprite.scale.set(size);
      p.sprite.position.set(x, y);
      p.sprite.alpha = p.fade;
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.vy += p.gravity * dt;
      p.sprite.x += p.vx * dt;
      p.sprite.y += p.vy * dt;
      if (p.spin) p.sprite.rotation += p.spin * dt;
      p.sprite.alpha = p.fade * (p.life / p.maxLife);
    }
  }
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** A soft round dot, white so it can be tinted to any palette accent. */
function makeDotTexture(): Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}
