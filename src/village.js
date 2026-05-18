import { CONFIG } from './config.js';

// Deterministic village layout. Every agent that shares a village anchor
// computes the *same* plan, so instead of scattering structures they
// collectively raise an organised, walled town. Each village's plan is
// varied (size, gate count, orientation, plot ring) by a hash of its
// anchor — a general ringed layout, but no two towns are identical.
const WALL_LEN = 4.2; // must match the wall mesh length in world.js

function hash(x, z) {
  let h = (Math.round(x) * 73856093) ^ (Math.round(z) * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296; // 0..1
}

// A stable shared centre: the village's town centre if one exists nearby,
// else the agent's home snapped to a coarse grid so neighbours agree.
export function villageAnchor(entity, world) {
  if (!entity.home) return null;
  const c = world.nearestStructure(entity.home.pos.x, entity.home.pos.z, 'center');
  if (c && c.dist < CONFIG.structures.villageRadius) {
    return { x: Math.round(c.st.pos.x), z: Math.round(c.st.pos.z), hasCenter: true };
  }
  const g = 12;
  return {
    x: Math.round(entity.home.pos.x / g) * g,
    z: Math.round(entity.home.pos.z / g) * g,
    hasCenter: false
  };
}

// Per-village parameters derived from its anchor — distinct but stable.
export function villagePlan(anchor) {
  const r = hash(anchor.x, anchor.z);
  const r2 = hash(anchor.x + 7.3, anchor.z - 4.1);
  const R = CONFIG.structures.wallRing * (0.85 + r * 0.6);   // ~11..18
  const startA = r2 * Math.PI * 2;                            // ring rotation
  const gates = 2 + Math.floor(r2 * 3);                       // 2..4 gateways
  const plotR = R * (0.42 + r * 0.16);
  const plotN = CONFIG.structures.maxHousesPerVillage + 1 + Math.floor(r * 3);
  return { R, startA, gates, plotR, plotN };
}

export function wallRing(anchor) {
  const { R, startA, gates } = villagePlan(anchor);
  const n = Math.max(12, Math.round((2 * Math.PI * R) / WALL_LEN));
  const gateEvery = Math.max(3, Math.floor(n / gates));
  const slots = [];
  for (let i = 0; i < n; i++) {
    const a = startA + (i / n) * Math.PI * 2;
    slots.push({
      x: anchor.x + Math.sin(a) * R,
      z: anchor.z + Math.cos(a) * R,
      facing: a + Math.PI / 2,                 // tangent so segments line up
      type: i % gateEvery === (gateEvery >> 1) ? 'gate' : 'wall'
    });
  }
  return slots;
}

export function housePlots(anchor) {
  const { startA, plotR, plotN } = villagePlan(anchor);
  const plots = [];
  for (let i = 0; i < plotN; i++) {
    const a = startA * 0.5 + (i / plotN) * Math.PI * 2 + 0.3;
    plots.push({ x: anchor.x + Math.sin(a) * plotR, z: anchor.z + Math.cos(a) * plotR });
  }
  return plots;
}

function occupied(world, x, z, types, r) {
  const r2 = r * r;
  for (const st of world.structures) {
    if (!types.includes(st.type)) continue;
    if ((st.pos.x - x) ** 2 + (st.pos.z - z) ** 2 < r2) return true;
  }
  return false;
}

// Nearest unbuilt perimeter slot (wall or gate) to `from`.
export function nextRingSlot(world, anchor, from) {
  let best = null, bd = Infinity;
  for (const s of wallRing(anchor)) {
    if (occupied(world, s.x, s.z, ['wall', 'gate'], 2.4)) continue;
    const d = (s.x - from.x) ** 2 + (s.z - from.z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function ringComplete(world, anchor) {
  return wallRing(anchor).every((s) => occupied(world, s.x, s.z, ['wall', 'gate'], 2.4));
}

// Nearest tidy, empty house plot inside the walls.
export function nextHousePlot(world, anchor, from) {
  let best = null, bd = Infinity;
  for (const p of housePlots(anchor)) {
    if (occupied(world, p.x, p.z, ['house', 'center', 'storehouse', 'tower'], 3.0)) continue;
    const d = (p.x - from.x) ** 2 + (p.z - from.z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
