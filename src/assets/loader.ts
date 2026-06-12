import { Assets, Rectangle, Texture } from 'pixi.js';
import type { Rng } from '../core/rng';
import { fetchManifest, type Manifest, type ManifestEntry } from './manifest';
import { placeholderCanvas } from './placeholders';

// Loads every manifest entry, validating each art file's dimensions against
// the manifest. Anything missing or malformed becomes a generated placeholder,
// so dropping real art in later requires zero code changes.

export interface LoadedAsset {
  entry: ManifestEntry;
  texture: Texture;
  /** True when the art was absent or malformed and a stand-in was generated. */
  placeholder: boolean;
  /** Actual sheet rows present, e.g. 4 when a spirit ships the fervent row. */
  rows: number;
}

export class AssetLibrary {
  private readonly frames = new Map<string, Texture>();

  constructor(
    readonly manifest: Manifest,
    private readonly assets: Map<string, LoadedAsset>,
  ) {}

  get(file: string): LoadedAsset {
    const asset = this.assets.get(file);
    if (!asset) throw new Error(`asset not in manifest: ${file}`);
    return asset;
  }

  /** A single cell of a gridded sheet, cached. */
  frame(file: string, column: number, row: number): Texture {
    const key = `${file}:${column}:${row}`;
    const cached = this.frames.get(key);
    if (cached) return cached;
    const { entry, texture } = this.get(file);
    const fw = entry.frameWidth ?? entry.width;
    const fh = entry.frameHeight ?? entry.height;
    const tex = new Texture({
      source: texture.source,
      frame: new Rectangle(column * fw, row * fh, fw, fh),
    });
    this.frames.set(key, tex);
    return tex;
  }

  /** All frame textures of one named animation on a spirit sheet. */
  animation(file: string, name: string): Texture[] {
    const { entry, rows } = this.get(file);
    const anim = entry.animations?.[name];
    if (!anim) throw new Error(`no animation ${name} on ${file}`);
    if (anim.row >= rows) throw new Error(`animation ${name} row missing from ${file}`);
    return Array.from({ length: anim.frames }, (_, i) => this.frame(file, i, anim.row));
  }

  /** How many entries fell back to placeholders; surfaced for the dev rig. */
  placeholderCount(): number {
    let n = 0;
    for (const a of this.assets.values()) if (a.placeholder) n++;
    return n;
  }
}

export async function loadAssets(baseUrl: string, rng: Rng): Promise<AssetLibrary> {
  const manifest = await fetchManifest(baseUrl);
  const assets = new Map<string, LoadedAsset>();

  await Promise.all(
    manifest.entries.map(async (entry) => {
      assets.set(entry.file, await loadOne(baseUrl, entry, rng));
    }),
  );

  return new AssetLibrary(manifest, assets);
}

async function loadOne(baseUrl: string, entry: ManifestEntry, rng: Rng): Promise<LoadedAsset> {
  try {
    const texture = await Assets.load<Texture>(`${baseUrl}assets/${entry.file}`);
    const heightOk =
      texture.height === entry.height ||
      (entry.maxRows !== undefined &&
        entry.frameHeight !== undefined &&
        texture.height === entry.maxRows * entry.frameHeight);
    if (texture.width !== entry.width || !heightOk) {
      throw new Error(
        `expected ${entry.width}x${entry.height}, got ${texture.width}x${texture.height}`,
      );
    }
    applyScaleMode(texture, entry);
    return { entry, texture, placeholder: false, rows: sheetRows(entry, texture.height) };
  } catch (err) {
    console.warn(`asset ${entry.file} falling back to placeholder:`, err);
    const canvas = placeholderCanvas(entry, rng.fork(entry.file));
    const texture = Texture.from(canvas);
    applyScaleMode(texture, entry);
    return { entry, texture, placeholder: true, rows: sheetRows(entry, canvas.height) };
  }
}

function applyScaleMode(texture: Texture, entry: ManifestEntry): void {
  texture.source.scaleMode = entry.pixel ? 'nearest' : 'linear';
}

function sheetRows(entry: ManifestEntry, actualHeight: number): number {
  if (entry.frameHeight === undefined) return 1;
  return Math.max(1, Math.floor(actualHeight / entry.frameHeight));
}
