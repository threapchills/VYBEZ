import type { SpiritId } from '../core/contracts';
import type { Engine, PatchKey } from '../audio/engine';

// The dev tuning rig: ?dev=1 opens a plain panel, excluded from the user
// experience entirely. Every scalar parameter of every patch gets a slider
// that edits the live worklet; each spirit has solo, mute and an audition
// key; and each patch exports its JSON to the clipboard for pasting back into
// src/audio/patches. This is how the synth gets dialled in by ear.

interface Param {
  param: string;
  min: number;
  max: number;
  step: number;
}

interface Section {
  label: string;
  key: PatchKey;
  spirit: SpiritId;
  audition: { midi?: number; articulation?: string };
  params: Param[];
}

const P = (param: string, min: number, max: number, step: number): Param => ({
  param,
  min,
  max,
  step,
});

const SECTIONS: Section[] = [
  {
    label: 'Drum',
    key: 'drum',
    spirit: 'drum',
    audition: { articulation: 'kick' },
    params: [
      P('tone', 0, 1, 0.01),
      P('decay', 0, 1, 0.01),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Root',
    key: 'root',
    spirit: 'root',
    audition: { midi: 31, articulation: 'pluck' },
    params: [
      P('brightness', 0, 1, 0.01),
      P('subMix', 0, 1, 0.01),
      P('detuneCents', -10, 10, 0.5),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Rattle bells',
    key: 'rattle',
    spirit: 'rattle',
    audition: { midi: 67, articulation: 'hit' },
    params: [
      P('hardness', 0, 1, 0.01),
      P('position', 0, 1, 0.01),
      P('dampTilt', 0.5, 1, 0.01),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Rattle shaker',
    key: 'shaker',
    spirit: 'rattle',
    audition: { articulation: 'ghost' },
    params: [P('centreHz', 200, 8000, 50), P('decay', 0.01, 0.2, 0.005), P('gain', 0, 2, 0.05)],
  },
  {
    label: 'Voice',
    key: 'voice',
    spirit: 'voice',
    audition: { midi: 72, articulation: 'lead' },
    params: [
      P('morph', 0, 1, 0.01),
      P('breath', 0, 1, 0.01),
      P('vibratoCents', 0, 30, 0.5),
      P('vibratoRate', 1, 8, 0.1),
      P('attack', 0, 0.2, 0.005),
      P('release', 0, 0.5, 0.01),
      P('detuneCents', -10, 10, 0.5),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Echo',
    key: 'echo',
    spirit: 'echo',
    audition: { midi: 60, articulation: 'bow' },
    params: [
      P('brightness', 0, 1, 0.01),
      P('pressure', 0, 1, 0.01),
      P('detuneCents', -10, 10, 0.5),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Spinner',
    key: 'spinner',
    spirit: 'spinner',
    audition: { midi: 67, articulation: 'tine' },
    params: [
      P('hardness', 0, 1, 0.01),
      P('position', 0, 1, 0.01),
      P('dampTilt', 0.5, 1, 0.01),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
  {
    label: 'Breath',
    key: 'breath',
    spirit: 'breath',
    audition: { midi: 48, articulation: 'drone' },
    params: [
      P('cutoff', 0, 1, 0.01),
      P('chiff', 0, 1, 0.01),
      P('pan', -1, 1, 0.05),
      P('gain', 0, 2, 0.05),
    ],
  },
];

export function isDevMode(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('dev') === '1';
}

export function mountRig(engine: Engine): void {
  const snapshot = engine.patchSnapshot();

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'top:0',
    'right:0',
    'width:320px',
    'max-height:100vh',
    'overflow-y:auto',
    'background:rgba(10,12,24,0.92)',
    'color:#e8e3cf',
    'font:12px/1.4 monospace',
    'padding:10px',
    'z-index:9999',
    'box-shadow:-2px 0 16px rgba(0,0,0,0.5)',
  ].join(';');

  const header = document.createElement('div');
  header.textContent = 'vybez tuning rig (?dev=1)';
  header.style.cssText = 'font-weight:bold;margin-bottom:8px;cursor:pointer';
  let collapsed = false;
  const body = document.createElement('div');
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
  });
  panel.append(header, body);

  for (const section of SECTIONS) {
    body.appendChild(buildSection(engine, section, snapshot[section.key]));
  }

  const exportAll = button('copy all patches', () => {
    void navigator.clipboard.writeText(JSON.stringify(engine.patchSnapshot(), null, 2));
  });
  exportAll.style.marginTop = '8px';
  body.appendChild(exportAll);

  document.body.appendChild(panel);
}

function buildSection(
  engine: Engine,
  section: Section,
  values: Record<string, number>,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border-top:1px solid #2a3550;padding:6px 0;margin-top:6px';

  const title = document.createElement('div');
  title.textContent = section.label;
  title.style.cssText = 'font-weight:bold;margin-bottom:4px';
  wrap.appendChild(title);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap';
  controls.append(
    button('audition', () =>
      engine.audition(section.spirit, section.audition.midi ?? 60, section.audition.articulation),
    ),
    toggle('solo', (on) => engine.setSolo(section.spirit, on)),
    toggle('mute', (on) => engine.setMuted(section.spirit, on)),
    button('copy', () => {
      void navigator.clipboard.writeText(
        JSON.stringify(engine.patchSnapshot()[section.key], null, 2),
      );
    }),
  );
  wrap.appendChild(controls);

  for (const p of section.params) {
    wrap.appendChild(buildSlider(engine, section.key, p, values[p.param] ?? p.min));
  }
  return wrap;
}

function buildSlider(engine: Engine, key: PatchKey, p: Param, initial: number): HTMLElement {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';

  const name = document.createElement('span');
  name.textContent = p.param;
  name.style.cssText = 'flex:0 0 90px';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(p.min);
  slider.max = String(p.max);
  slider.step = String(p.step);
  slider.value = String(initial);
  slider.style.flex = '1';

  const readout = document.createElement('span');
  readout.textContent = initial.toFixed(2);
  readout.style.cssText = 'flex:0 0 44px;text-align:right';

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    readout.textContent = v.toFixed(2);
    engine.setPatchParam(key, p.param, v);
  });

  row.append(name, slider, readout);
  return row;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'background:#243b53;color:#e8e3cf;border:0;padding:3px 6px;cursor:pointer;font:11px monospace';
  b.addEventListener('click', onClick);
  return b;
}

function toggle(label: string, onChange: (on: boolean) => void): HTMLButtonElement {
  let on = false;
  const b = button(label, () => {
    on = !on;
    b.style.background = on ? '#7a2742' : '#243b53';
    onChange(on);
  });
  return b;
}
