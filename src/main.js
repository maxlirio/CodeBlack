import { Simulation } from './simulation.js';

// Seed from the URL (?seed=123) for reproducible worlds, else random.
const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0;

const mount = document.getElementById('app');
// eslint-disable-next-line no-new
window.__sim = new Simulation(mount, seed);
console.info(`CodeBlack running — world seed ${seed}`);
