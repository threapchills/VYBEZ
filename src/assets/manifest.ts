import type { SpiritId } from '../core/contracts';

// Typed mirror of public/assets/manifest.json. The loader validates every art
// file against this; anything missing or malformed is replaced by a placeholder.

export type AssetKind = 'layer' | 'sprite' | 'spiritSheet' | 'object' | 'talisman' | 'overlay';

export type AnimationMode = 'loop' | 'once' | 'onset';

export interface AnimationSpec {
  row: number;
  frames: number;
  mode: AnimationMode;
  optional?: boolean;
}

export interface ManifestEntry {
  file: string;
  kind: AssetKind;
  width: number;
  height: number;
  alpha: boolean;
  /** Pixel art: nearest-neighbour scaling, no smoothing. */
  pixel: boolean;
  optional: boolean;
  spirit?: SpiritId;
  frameWidth?: number;
  frameHeight?: number;
  columns?: number;
  rows?: number;
  /** Spirit sheets may carry an optional fervent row; height may match this instead of rows. */
  maxRows?: number;
  animations?: Record<string, AnimationSpec>;
}

export interface Manifest {
  version: number;
  entries: ManifestEntry[];
}

/**
 * Structural validation of the manifest itself. A broken manifest is a build
 * error, not an art error, so this throws rather than substituting anything.
 */
export function validateManifest(data: unknown): Manifest {
  if (typeof data !== 'object' || data === null) throw new Error('manifest: not an object');
  const m = data as { version?: unknown; entries?: unknown };
  if (m.version !== 1) throw new Error('manifest: unsupported version');
  if (!Array.isArray(m.entries) || m.entries.length === 0) {
    throw new Error('manifest: entries missing');
  }
  for (const raw of m.entries) {
    const e = raw as Partial<ManifestEntry>;
    if (typeof e.file !== 'string' || e.file.length === 0) {
      throw new Error('manifest: entry without a file name');
    }
    if (
      !['layer', 'sprite', 'spiritSheet', 'object', 'talisman', 'overlay'].includes(e.kind ?? '')
    ) {
      throw new Error(`manifest: ${e.file} has unknown kind ${String(e.kind)}`);
    }
    if (!isPositiveInt(e.width) || !isPositiveInt(e.height)) {
      throw new Error(`manifest: ${e.file} has invalid dimensions`);
    }
    if (
      typeof e.alpha !== 'boolean' ||
      typeof e.pixel !== 'boolean' ||
      typeof e.optional !== 'boolean'
    ) {
      throw new Error(`manifest: ${e.file} has missing flags`);
    }
    const framed = e.frameWidth !== undefined || e.frameHeight !== undefined;
    if (framed) {
      if (!isPositiveInt(e.frameWidth) || !isPositiveInt(e.frameHeight)) {
        throw new Error(`manifest: ${e.file} has invalid frame dimensions`);
      }
      if (!isPositiveInt(e.columns) || !isPositiveInt(e.rows)) {
        throw new Error(`manifest: ${e.file} has invalid grid`);
      }
      if (e.frameWidth * e.columns !== e.width) {
        throw new Error(`manifest: ${e.file} columns do not tile its width`);
      }
      if (e.frameHeight * e.rows !== e.height) {
        throw new Error(`manifest: ${e.file} rows do not tile its height`);
      }
      if (e.maxRows !== undefined && (!isPositiveInt(e.maxRows) || e.maxRows < e.rows)) {
        throw new Error(`manifest: ${e.file} maxRows is below its rows`);
      }
    }
    if (e.kind === 'spiritSheet') {
      if (!framed || !e.animations) {
        throw new Error(`manifest: ${e.file} spirit sheet needs a grid and animations`);
      }
      for (const [name, anim] of Object.entries(e.animations)) {
        if (!isPositiveInt(anim.frames) || anim.row === undefined || anim.row < 0) {
          throw new Error(`manifest: ${e.file} animation ${name} is malformed`);
        }
        if (anim.frames > (e.columns ?? 0)) {
          throw new Error(`manifest: ${e.file} animation ${name} exceeds the sheet columns`);
        }
      }
    }
  }
  return data as Manifest;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Fetch and validate the manifest from public/assets. */
export async function fetchManifest(baseUrl: string): Promise<Manifest> {
  const res = await fetch(`${baseUrl}assets/manifest.json`);
  if (!res.ok) throw new Error(`manifest: fetch failed with ${res.status}`);
  return validateManifest(await res.json());
}
