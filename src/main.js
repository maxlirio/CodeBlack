import { Simulation } from './simulation.js';
import { loadAssets } from './humanoid.js';

// Seed from the URL (?seed=123) for reproducible worlds, else random.
const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0;

const mount = document.getElementById('app');

// Show a tiny loading state while we pull the villager GLB.
const loader = document.createElement('div');
loader.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d121a;color:#cdd9ef;font:14px ui-monospace,Menlo,Consolas,monospace;z-index:9999';
loader.textContent = 'Loading villager model…';
document.body.appendChild(loader);

(async () => {
  try {
    await loadAssets();
  } catch (err) {
    console.error('asset load failed; falling back to placeholder figures', err);
  }
  loader.remove();
  // eslint-disable-next-line no-new
  window.__sim = new Simulation(mount, seed);
  console.info(`CodeBlack running — world seed ${seed}`);
})();
