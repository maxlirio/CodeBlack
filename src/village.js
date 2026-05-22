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

export function wallRing(anchor, world = null) {
  let { R, startA, gates } = villagePlan(anchor);
  let cx = anchor.x, cz = anchor.z;
  // Adapt to whatever walls are already there. If a village has at least
  // four walls/gates inside its area — built by anyone, player included —
  // we re-anchor the ring to their centroid and average radius so agents
  // keep extending the perimeter the *players* started instead of going
  // off to raise a parallel ring of their own on the hash-derived spot.
  if (world) {
    const cap = CONFIG.structures.villageRadius;
    const around = world.structures.filter(
      (s) => (s.type === 'wall' || s.type === 'gate') &&
        Math.hypot(s.pos.x - anchor.x, s.pos.z - anchor.z) < cap);
    if (around.length >= 4) {
      cx = around.reduce((s, w) => s + w.pos.x, 0) / around.length;
      cz = around.reduce((s, w) => s + w.pos.z, 0) / around.length;
      const avg = around.reduce((s, w) => s + Math.hypot(w.pos.x - cx, w.pos.z - cz), 0) / around.length;
      R = Math.max(8, Math.min(28, avg));
    }
  }
  const n = Math.max(12, Math.round((2 * Math.PI * R) / WALL_LEN));
  const gateEvery = Math.max(3, Math.floor(n / gates));
  const slots = [];
  for (let i = 0; i < n; i++) {
    const a = startA + (i / n) * Math.PI * 2;
    slots.push({
      x: cx + Math.sin(a) * R,
      z: cz + Math.cos(a) * R,
      facing: a,
      type: i % gateEvery === (gateEvery >> 1) ? 'gate' : 'wall'
    });
  }
  return slots;
}

// Every village lays its houses out as a single ring around the
// anchor. Radius and rotation still come from the hash, so two towns
// are not identical sizes — but the *shape* is always a circle, the
// reading the user prefers.
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

// Nearest unbuilt perimeter slot (wall or gate) to `from`. The ring is
// computed against the *current* world so it reshapes to fit existing
// walls (player layouts get extended, not abandoned).
export function nextRingSlot(world, anchor, from) {
  let best = null, bd = Infinity;
  for (const s of wallRing(anchor, world)) {
    if (occupied(world, s.x, s.z, ['wall', 'gate'], 2.4)) continue;
    const d = (s.x - from.x) ** 2 + (s.z - from.z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function ringComplete(world, anchor) {
  return wallRing(anchor, world).every((s) => occupied(world, s.x, s.z, ['wall', 'gate'], 2.4));
}

// A small rectangular paddock inside the village ring. One pen per
// village (anchored off the village's stable plan), so every farmer
// works the same plan instead of scattering fences around their own
// houses. The pen has 11 fence segments around a 10×10 square and one
// gap as a gate so livestock can be driven in.
const FENCE_LEN = 3.2;
const PEN_HALF = 5.0;

export function penCenter(anchor) {
  const { R, startA } = villagePlan(anchor);
  // A stable offset from the village ring rotation — keeps the pen
  // tucked beside the houses but well inside the wall, away from the
  // town centre. Different villages, different angles, all reproducible.
  const a = startA + 1.2;
  const dist = Math.max(8, R * 0.55);
  return { x: anchor.x + Math.sin(a) * dist, z: anchor.z + Math.cos(a) * dist };
}

export function penRing(anchor) {
  const c = penCenter(anchor);
  const slots = [];
  // North / south sides (fences run along world X — facing 0).
  for (const z of [-PEN_HALF, +PEN_HALF]) {
    for (const i of [-1, 0, +1]) {
      slots.push({ x: c.x + i * FENCE_LEN, z: c.z + z, facing: 0 });
    }
  }
  // East / west sides (rotated 90° to run along world Z).
  for (const x of [-PEN_HALF, +PEN_HALF]) {
    for (const i of [-1, 0, +1]) {
      slots.push({ x: c.x + x, z: c.z + i * FENCE_LEN, facing: Math.PI / 2 });
    }
  }
  // Drop the middle of the south side — that opening is the gate.
  slots.splice(1, 1);
  return slots;
}

export const PEN_HALF_EXTENT = PEN_HALF;

export function nextPenSlot(world, anchor, from) {
  let best = null, bd = Infinity;
  for (const s of penRing(anchor)) {
    if (occupied(world, s.x, s.z, ['fence'], 1.8)) continue;
    const d = (s.x - from.x) ** 2 + (s.z - from.z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function penComplete(world, anchor) {
  return penRing(anchor).every((s) => occupied(world, s.x, s.z, ['fence'], 1.8));
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
