import { Application } from 'pixi.js';
import { loadAssets } from './assets/loader';
import { Rng, sessionSeed } from './core/rng';
import { buildScene } from './visuals/scene';

// Boot: seed the session, load and validate the art, raise the valley.
// Audio arrives in phase 1; the ignition gesture will start the AudioContext
// then. Nothing persists between sessions; ephemerality is a feature.

async function boot(): Promise<void> {
  const mount = document.getElementById('valley');
  if (!mount) throw new Error('mount point #valley missing');

  const seed = sessionSeed();
  const rng = new Rng(seed);

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

  buildScene(app, assets, rng.fork('scene'));
}

boot().catch((err: unknown) => {
  console.error('the valley failed to wake:', err);
});
