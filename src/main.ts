import { Application } from 'pixi.js';
import { loadAssets } from './assets/loader';
import { Engine } from './audio/engine';
import { Conductor } from './conductor/conductor';
import { Rng, sessionSeed } from './core/rng';
import { createSession } from './core/session';
import { isDevMode, mountRig } from './dev/rig';
import { attachPointer } from './interact/pointer';
import { buildScene } from './visuals/scene';

// Boot: seed the session, load and validate the art, raise the valley.
// The first tap on the fire is the only onboarding: it ignites the scene,
// unlocks the AudioContext and starts the conductor. Nothing persists
// between sessions; ephemerality is a feature.

async function boot(): Promise<void> {
  const mount = document.getElementById('valley');
  if (!mount) throw new Error('mount point #valley missing');

  const seed = sessionSeed();
  const rng = new Rng(seed);
  const session = createSession(rng.fork('session'));

  const app = new Application();
  await app.init({
    background: '#0b1026',
    resizeTo: mount,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  mount.appendChild(app.canvas);
  // resizeTo does not always measure on init; force the first fit.
  app.resize();

  // Pixi devtools handle; also lets QA pull frames out of the running scene.
  (globalThis as { __PIXI_APP__?: Application }).__PIXI_APP__ = app;

  const assets = await loadAssets(import.meta.env.BASE_URL, rng.fork('assets'));
  if (assets.placeholderCount() > 0) {
    console.warn(`${assets.placeholderCount()} assets running on placeholders`);
  }

  // The engine exists before the scene so the scene can read its clock; the
  // onset-locked animation fires each strike on the note's own AudioContext
  // time, keeping image and sound in lockstep.
  const engine = new Engine(rng.fork('audio'));
  const conductor = new Conductor(session, rng.fork('conductor'));

  const handles = buildScene(app, assets, session, () => engine.now());

  // The tuning rig is dev-only and excluded from the user experience.
  if (isDevMode()) mountRig(engine);

  // The first tap on the fire ignites the scene, unlocks audio, starts the
  // conductor, and hands all further interaction to the pointer layer.
  let audioStarted = false;
  handles.fire.on('pointertap', () => {
    if (audioStarted) return;
    audioStarted = true;
    handles.ignite();
    engine
      .unlock()
      .then(() => {
        conductor.start(() => engine.now());
        attachPointer(app, handles, session);
      })
      .catch((err: unknown) => console.error('audio failed to wake:', err));
  });
}

boot().catch((err: unknown) => {
  console.error('the valley failed to wake:', err);
});
