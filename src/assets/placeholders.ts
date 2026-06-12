import type { Rng } from '../core/rng';
import type { ManifestEntry } from './manifest';

// Generated stand-ins for missing or malformed art. The app must be fully
// playable with zero real assets present, so every manifest entry has a
// drawable fallback: gradient bands for layers, silhouette blocks with crude
// frame variation for spirits, simple glyphs for objects. All deterministic
// from the session seed; the caller passes a per-file fork of the RNG.

/** Aeolian ramp, dark to light; the placeholder world wears the default dusk. */
const RAMP = ['#0b1026', '#243b53', '#5b7c8d', '#a8b8a6', '#e8e3cf'] as const;

const SPIRIT_HUES: Record<string, number> = {
  drum: 10,
  rattle: 40,
  root: 25,
  voice: 185,
  echo: 215,
  spinner: 60,
  breath: 270,
};

export function placeholderCanvas(entry: ManifestEntry, rng: Rng): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = entry.width;
  // Sheets with an optional extra row (the fervent row) are generated at full
  // height, so every animation the manifest names exists on the stand-in too.
  canvas.height =
    entry.maxRows !== undefined && entry.frameHeight !== undefined
      ? entry.maxRows * entry.frameHeight
      : entry.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  switch (entry.kind) {
    case 'layer':
      drawLayer(ctx, entry, rng);
      break;
    case 'sprite':
      drawMoon(ctx, entry);
      break;
    case 'spiritSheet':
      drawSpiritSheet(ctx, entry, rng);
      break;
    case 'object':
      drawObject(ctx, entry, rng);
      break;
    case 'talisman':
      drawTalisman(ctx, entry);
      break;
    case 'overlay':
      drawOverlay(ctx, entry, rng);
      break;
  }

  if (entry.width >= 256) label(ctx, entry.file);
  return canvas;
}

function label(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.save();
  ctx.font = '16px monospace';
  ctx.fillStyle = 'rgba(232, 227, 207, 0.6)';
  ctx.fillText(`placeholder: ${text}`, 12, 24);
  ctx.restore();
}

function drawLayer(ctx: CanvasRenderingContext2D, entry: ManifestEntry, rng: Rng): void {
  const { width: w, height: h } = entry;
  const depth = Number.parseInt(entry.file.slice(3, 5), 10) || 0; // bg_NN_
  const horizon = h * 0.62;

  if (depth === 0) {
    // Sky: dusk gradient with faint stars.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, RAMP[0]);
    grad.addColorStop(0.6, RAMP[1]);
    grad.addColorStop(1, RAMP[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(232, 227, 207, 0.5)';
    for (let i = 0; i < 140; i++) {
      ctx.fillRect(rng.range(0, w), rng.range(0, horizon * 0.8), 2, 2);
    }
    return;
  }

  // Transparent layers: silhouette band below a contoured edge.
  const shade = [RAMP[1], RAMP[1], RAMP[0], '#070b18'][depth - 1] ?? RAMP[0];
  const lift = [0.92, 1.0, 1.12, 1.25][depth - 1] ?? 1;
  const roughness = [90, 60, 24, 110][depth - 1] ?? 40;
  const edge = horizon * lift;

  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, edge);
  const step = depth === 1 ? 240 : 140;
  for (let x = 0; x <= w; x += step) {
    ctx.lineTo(x + rng.range(-40, 40), edge + rng.range(-roughness, roughness));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  if (depth === 2) {
    // Crude megaliths along the ruin line.
    for (let i = 0; i < 7; i++) {
      const x = rng.range(w * 0.05, w * 0.95);
      const mh = rng.range(80, 260);
      const mw = rng.range(28, 70);
      ctx.fillRect(x, edge - mh + 20, mw, mh);
    }
  }
  if (depth === 4) {
    // Foreground flora: overhanging top corners, darkest layer.
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.22, h * 0.3, 0, 0, Math.PI * 2);
    ctx.ellipse(w, 0, w * 0.26, h * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMoon(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const c = entry.width / 2;
  const glow = ctx.createRadialGradient(c, c, entry.width * 0.12, c, c, entry.width * 0.48);
  glow.addColorStop(0, 'rgba(232, 227, 207, 0.95)');
  glow.addColorStop(0.4, 'rgba(168, 184, 166, 0.35)');
  glow.addColorStop(1, 'rgba(168, 184, 166, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, entry.width, entry.height);
  // A veiled sickle: offset shadow disc.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(c + entry.width * 0.1, c - entry.width * 0.06, entry.width * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

function drawSpiritSheet(ctx: CanvasRenderingContext2D, entry: ManifestEntry, rng: Rng): void {
  const fw = entry.frameWidth ?? 128;
  const fh = entry.frameHeight ?? 128;
  const hue = SPIRIT_HUES[entry.spirit ?? ''] ?? 0;
  const jitter = rng.range(-8, 8);
  const anims = entry.animations ?? {};
  const rows = entry.maxRows ?? entry.rows ?? 3;

  for (const anim of Object.values(anims)) {
    if (anim.row >= rows) continue;
    for (let col = 0; col < anim.frames; col++) {
      const x = col * fw;
      const y = anim.row * fh;
      const phase = col / anim.frames;
      ctx.save();
      ctx.translate(x, y);
      drawFigure(ctx, fw, fh, hue + jitter, anim.row, phase);
      ctx.restore();
    }
  }
}

/** One silhouette figure inside a cell; row decides the pose family. */
function drawFigure(
  ctx: CanvasRenderingContext2D,
  fw: number,
  fh: number,
  hue: number,
  row: number,
  phase: number,
): void {
  const baseline = fh - 12;
  const cx = fw / 2;
  const body = `hsl(${hue}, 25%, 16%)`;
  const rim = `hsl(${hue}, 45%, 45%)`;

  // Row 0 asleep: hunched and breathing. Row 1 waking: rising. Row 2+: playing sway.
  const breathe = row === 0 ? Math.sin(phase * Math.PI * 2) * 3 : 0;
  const rise = row === 1 ? (1 - phase) * 26 : 0;
  const sway = row >= 2 ? Math.sin(phase * Math.PI * 2) * 7 : 0;
  const slump = row === 0 ? 18 : 0;

  const bodyH = 62 - slump + breathe;
  const top = baseline - bodyH - 22 + rise;

  ctx.fillStyle = body;
  ctx.strokeStyle = rim;
  ctx.lineWidth = 2;

  // Torso
  ctx.beginPath();
  ctx.moveTo(cx - 20 + sway * 0.3, baseline);
  ctx.quadraticCurveTo(cx - 26 + sway, top + 30, cx + sway, top + 18);
  ctx.quadraticCurveTo(cx + 26 + sway, top + 30, cx + 20 + sway * 0.3, baseline);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Head
  ctx.beginPath();
  ctx.arc(cx + sway, top + 6, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Playing arm: contact lands on frame 1 of the row, so phase 0 strikes lowest.
  if (row >= 2) {
    const strike = Math.cos(phase * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(cx + sway + 8, top + 34);
    ctx.lineTo(cx + sway + 30, top + 44 + strike * 14);
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}

function drawObject(ctx: CanvasRenderingContext2D, entry: ManifestEntry, rng: Rng): void {
  if (entry.file.startsWith('totem_pole')) return drawTotem(ctx, entry);
  if (entry.file.startsWith('totem_glow')) return drawGlowFrames(ctx, entry);
  if (entry.file.startsWith('censer')) return drawCenser(ctx, entry);
  if (entry.file.startsWith('fire_base')) return drawFireFrames(ctx, entry, rng);
  if (entry.file.startsWith('wind_banner')) return drawBannerFrames(ctx, entry);
  // Unknown object: a marked box.
  ctx.fillStyle = RAMP[1];
  ctx.fillRect(0, 0, entry.width, entry.height);
}

function drawTotem(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const heads = 7;
  const hh = entry.height / heads; // 64 each on a 448 pole
  for (let i = 0; i < heads; i++) {
    const y = entry.height - (i + 1) * hh;
    ctx.fillStyle = i % 2 === 0 ? RAMP[1] : '#1a2c40';
    ctx.fillRect(10, y + 2, entry.width - 20, hh - 4);
    ctx.fillStyle = RAMP[3];
    // Two eyes and a mouth, shifted per head so the seven faces differ.
    const ey = y + hh * 0.35;
    ctx.fillRect(24 + (i % 3) * 4, ey, 8, 8);
    ctx.fillRect(entry.width - 32 - (i % 3) * 4, ey, 8, 8);
    ctx.fillRect(34, y + hh * 0.68, entry.width - 68, 4 + (i % 2) * 4);
  }
}

function drawGlowFrames(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const fw = entry.frameWidth ?? 96;
  for (let i = 0; i < (entry.columns ?? 2); i++) {
    const cx = i * fw + fw / 2;
    const cy = (entry.frameHeight ?? 64) / 2;
    const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, fw / 2);
    glow.addColorStop(0, `rgba(232, 227, 207, ${i === 0 ? 0.85 : 0.55})`);
    glow.addColorStop(1, 'rgba(232, 227, 207, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(i * fw, 0, fw, entry.frameHeight ?? 64);
  }
}

function drawCenser(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const cx = entry.width / 2;
  ctx.fillStyle = '#1a2c40';
  ctx.strokeStyle = RAMP[2];
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, entry.height * 0.55, entry.width * 0.38, entry.height * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(cx - 4, 0, 8, entry.height * 0.3); // hanging stem; the app draws the chain
  ctx.fillStyle = 'rgba(216, 160, 92, 0.8)'; // ember slot
  ctx.fillRect(cx - 12, entry.height * 0.48, 24, 6);
}

function drawFireFrames(ctx: CanvasRenderingContext2D, entry: ManifestEntry, rng: Rng): void {
  const fw = entry.frameWidth ?? 96;
  const fh = entry.frameHeight ?? 96;
  for (let i = 0; i < (entry.columns ?? 6); i++) {
    const ox = i * fw;
    ctx.fillStyle = '#2a1408';
    ctx.fillRect(ox + fw * 0.2, fh - 14, fw * 0.6, 10); // ember bed
    // Three tongues with per-frame flicker.
    for (let t = 0; t < 3; t++) {
      const baseX = ox + fw * (0.3 + t * 0.2);
      const height = fh * rng.range(0.35, 0.75);
      ctx.fillStyle = t === 1 ? 'rgba(232, 200, 130, 0.9)' : 'rgba(216, 130, 60, 0.85)';
      ctx.beginPath();
      ctx.moveTo(baseX - 10, fh - 12);
      ctx.quadraticCurveTo(baseX + rng.range(-8, 8), fh - height, baseX, fh - height - 6);
      ctx.quadraticCurveTo(baseX + rng.range(-8, 8), fh - height * 0.5, baseX + 10, fh - 12);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawBannerFrames(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const fw = entry.frameWidth ?? 96;
  const fh = entry.frameHeight ?? 128;
  for (let i = 0; i < (entry.columns ?? 6); i++) {
    const ox = i * fw;
    const phase = (i / (entry.columns ?? 6)) * Math.PI * 2;
    ctx.fillStyle = '#1a2c40';
    ctx.fillRect(ox + 8, 4, 4, fh - 8); // pole
    ctx.fillStyle = RAMP[2];
    ctx.beginPath();
    ctx.moveTo(ox + 12, 8);
    for (let s = 0; s <= 8; s++) {
      const x = ox + 12 + (s / 8) * (fw - 28);
      ctx.lineTo(x, 8 + Math.sin(phase + s * 0.9) * 6 + s * 1.2);
    }
    ctx.lineTo(ox + 12 + (fw - 28), 44);
    for (let s = 8; s >= 0; s--) {
      const x = ox + 12 + (s / 8) * (fw - 28);
      ctx.lineTo(x, 40 + Math.sin(phase + s * 0.9) * 6 + s * 1.2);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawTalisman(ctx: CanvasRenderingContext2D, entry: ManifestEntry): void {
  const fw = entry.frameWidth ?? 64;
  const fh = entry.frameHeight ?? 64;
  const hue = SPIRIT_HUES[entry.spirit ?? ''] ?? 0;
  for (let i = 0; i < (entry.columns ?? 2); i++) {
    const cx = i * fw + fw / 2;
    const cy = fh / 2;
    ctx.fillStyle = `hsl(${hue}, 35%, ${i === 0 ? 30 : 44}%)`;
    ctx.strokeStyle = `hsl(${hue}, 50%, 60%)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx + 14, cy);
    ctx.lineTo(cx, cy + 18);
    ctx.lineTo(cx - 14, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (i === 1) {
      // Frame two: the faint shimmer.
      ctx.strokeStyle = 'rgba(232, 227, 207, 0.7)';
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawOverlay(ctx: CanvasRenderingContext2D, entry: ManifestEntry, rng: Rng): void {
  if (entry.file.startsWith('grain')) {
    const img = ctx.createImageData(entry.width, entry.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.floor(rng.range(0, 36));
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return;
  }
  // Cursor: a small ember.
  const c = entry.width / 2;
  const glow = ctx.createRadialGradient(c, c, 1, c, c, c);
  glow.addColorStop(0, 'rgba(240, 190, 110, 1)');
  glow.addColorStop(0.5, 'rgba(216, 130, 60, 0.8)');
  glow.addColorStop(1, 'rgba(216, 130, 60, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, entry.width, entry.height);
}
