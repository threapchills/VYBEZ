import type { Engine } from '../audio/engine';

// The only conventional UI the valley permits besides the ignition caption: a
// small mute icon. It appears once the fire is lit and toggles the master with
// a short ramp. Sentence-case label, plain verb, nothing else on the screen.

const SPEAKER =
  '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8a5 5 0 0 1 0 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
const MUTED =
  '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';

export function mountMute(engine: Engine): { reveal: () => void } {
  let muted = false;
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'mute');
  button.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'width:42px',
    'height:42px',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'border:0',
    'border-radius:50%',
    'background:rgba(11,16,38,0.5)',
    'color:#e8e3cf',
    'cursor:pointer',
    'opacity:0.55',
    'transition:opacity 0.2s',
    'z-index:50',
    '-webkit-tap-highlight-color:transparent',
  ].join(';');
  const render = (): void => {
    button.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24">${muted ? MUTED : SPEAKER}</svg>`;
    button.setAttribute('aria-label', muted ? 'unmute' : 'mute');
  };
  render();

  button.addEventListener('pointerenter', () => (button.style.opacity = '0.95'));
  button.addEventListener('pointerleave', () => (button.style.opacity = '0.55'));
  button.addEventListener('click', () => {
    muted = !muted;
    engine.setMasterMuted(muted);
    render();
  });

  document.body.appendChild(button);
  return {
    reveal: () => {
      button.style.display = 'flex';
    },
  };
}
