import { describe, expect, it } from 'vitest';
import manifestJson from '../../public/assets/manifest.json';
import { validateManifest } from './manifest';
import { PLAYABLE_SPIRITS } from '../core/contracts';

const CHECKLIST = [
  'bg_00_sky.png',
  'bg_01_far_ridge.png',
  'bg_02_mid_ruins.png',
  'bg_03_glade.png',
  'bg_04_foreground.png',
  'moon.png',
  'spirit_drum.png',
  'spirit_rattle.png',
  'spirit_root.png',
  'spirit_voice.png',
  'spirit_echo.png',
  'spirit_spinner.png',
  'spirit_breath.png',
  'totem_pole.png',
  'totem_glow.png',
  'censer.png',
  'fire_base.png',
  'wind_banner.png',
  'talisman_drum.png',
  'talisman_rattle.png',
  'talisman_root.png',
  'talisman_voice.png',
  'talisman_echo.png',
  'talisman_spinner.png',
  'talisman_breath.png',
];

describe('asset manifest', () => {
  it('passes structural validation', () => {
    expect(() => validateManifest(manifestJson)).not.toThrow();
  });

  it('covers the full ASSETS.md checklist', () => {
    const m = validateManifest(manifestJson);
    const files = m.entries.map((e) => e.file);
    for (const required of CHECKLIST) {
      expect(files).toContain(required);
    }
  });

  it('marks only grain and cursor optional', () => {
    const m = validateManifest(manifestJson);
    const optional = m.entries.filter((e) => e.optional).map((e) => e.file);
    expect(optional.sort()).toEqual(['cursor.png', 'grain.png']);
  });

  it('gives every spirit a sheet with the three required animations', () => {
    const m = validateManifest(manifestJson);
    const sheets = m.entries.filter((e) => e.kind === 'spiritSheet');
    const spirits = sheets.map((e) => e.spirit).sort();
    const playableNoWorld = [...PLAYABLE_SPIRITS].sort();
    expect(spirits).toEqual(playableNoWorld);
    for (const sheet of sheets) {
      expect(sheet.animations).toBeDefined();
      expect(sheet.animations?.asleep?.frames).toBe(4);
      expect(sheet.animations?.waking?.frames).toBe(6);
      expect(sheet.animations?.playing?.frames).toBe(8);
    }
  });

  it('rejects maxRows below rows', () => {
    expect(() =>
      validateManifest({
        version: 1,
        entries: [
          {
            file: 'broken.png',
            kind: 'object',
            width: 90,
            height: 400,
            alpha: true,
            pixel: true,
            optional: false,
            frameWidth: 30,
            frameHeight: 100,
            columns: 3,
            rows: 4,
            maxRows: 3,
          },
        ],
      }),
    ).toThrow(/maxRows/);
  });

  it('rejects a malformed grid', () => {
    expect(() =>
      validateManifest({
        version: 1,
        entries: [
          {
            file: 'broken.png',
            kind: 'object',
            width: 100,
            height: 100,
            alpha: true,
            pixel: true,
            optional: false,
            frameWidth: 30,
            frameHeight: 100,
            columns: 3,
            rows: 1,
          },
        ],
      }),
    ).toThrow(/tile/);
  });
});
