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

// A stable shared anchor every villager in the same cluster agrees on.
// Fast path: this tribe's nearest centre. Slow path: the centroid of
// the same-tribe homes around this one, snapped to a coarse grid so
// neighbours converge even before any centre exists. Anchoring to
// *any* tribe's centre (the old behaviour) had agents from clan A
// yanked into building clan B's town on top of their own — that's
// what produced the cross-tribe squiggle of walls.
export function villageAnchor(entity, world) {
  if (!entity.home) return null;
  const ours = (st) =>
    entity.tribeId == null || st.tribe == null || st.tribe === entity.tribeId;
  const hx = entity.home.pos.x, hz = entity.home.pos.z;

  // Same-tribe centre wins outright.
  let nearestC = null, bd2 = Infinity;
  for (const st of world.structures) {
    if (st.type !== 'center' || !ours(st)) continue;
    const d2 = (st.pos.x - hx) ** 2 + (st.pos.z - hz) ** 2;
    if (d2 < bd2) { bd2 = d2; nearestC = st; }
  }
  if (nearestC && bd2 < CONFIG.structures.villageRadius ** 2) {
    return { x: Math.round(nearestC.pos.x), z: Math.round(nearestC.pos.z), hasCenter: true };
  }

  // No centre yet — anchor to the centroid of nearby same-tribe homes.
  // Two agents in the same cluster see the same homes, compute the
  // same centroid, and after snapping agree on a single plan. The old
  // grid-snap-of-own-home had two neighbours metres apart falling
  // into different grid cells and building parallel rings.
  const R2 = CONFIG.tribe.homeMergeDist ** 2;
  let sx = 0, sz = 0, n = 0;
  for (const st of world.structures) {
    if (st.type !== 'house' || !ours(st)) continue;
    const d2 = (st.pos.x - hx) ** 2 + (st.pos.z - hz) ** 2;
    if (d2 < R2) { sx += st.pos.x; sz += st.pos.z; n++; }
  }
  if (n === 0) { sx = hx; sz = hz; n = 1; }
  // 8-unit grid is fine enough that the snap rarely flips when one new
  // home shifts the centroid by a fraction of a unit, coarse enough
  // that small drift from new arrivals doesn't move the ring.
  const g = 8;
  return {
    x: Math.round(sx / n / g) * g,
    z: Math.round(sz / n / g) * g,
    hasCenter: false
  };
}

// The centre belongs at the heart of the village, not on the house
// ring. Returning the anchor itself as the build spot keeps "anchor
// pre-centre" and "anchor post-centre" close enough that the wall ring
// doesn't jump when the first centre goes up. Caller still respects
// `occupied()` so two centres won't pile on top of each other.
export function centerSpot(anchor) {
  return { x: anchor.x, z: anchor.z };
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

// `tribeId` filters the "adapt to existing walls" centroid so foreign
// walls inside our radius don't drag our ring sideways. Pass null to
// fall back to the old all-walls behaviour.
export function wallRing(anchor, world = null, tribeId = null) {
  let { R, startA, gates } = villagePlan(anchor);
  let cx = anchor.x, cz = anchor.z;
  if (world) {
    const cap = CONFIG.structures.villageRadius;
    const around = world.structures.filter((s) => {
      if (s.type !== 'wall' && s.type !== 'gate') return false;
      if (Math.hypot(s.pos.x - anchor.x, s.pos.z - anchor.z) >= cap) return false;
      // Tribe filter — foreign walls do NOT reshape our ring.
      if (tribeId != null && s.tribe != null && s.tribe !== tribeId) return false;
      return true;
    });
    // Threshold bump 4 → 6: a stray placement or two shouldn't reanchor
    // the whole village plan. Adapt only once there's a real ring in
    // progress to align to.
    if (around.length >= 6) {
      cx = around.reduce((s, w) => s + w.pos.x, 0) / around.length;
      cz = around.reduce((s, w) => s + w.pos.z, 0) / around.length;
      const avg = around.reduce((s, w) => s + Math.hypot(w.pos.x - cx, w.pos.z - cz), 0) / around.length;
      R = Math.max(8, Math.min(28, avg));
      // Realign rotation to match the existing walls. Each existing
      // wall's angle modulo a sector size yields a phase; averaging
      // those phases tells us where the slot grid actually lives so
      // new slots align with old walls instead of landing half a
      // sector off (the "new walls next to old" squiggle).
      const nApprox = Math.max(12, Math.round((2 * Math.PI * R) / WALL_LEN));
      const sectorSize = (2 * Math.PI) / nApprox;
      let phaseSum = 0;
      for (const w of around) {
        const a = Math.atan2(w.pos.x - cx, w.pos.z - cz);
        let p = a - Math.round(a / sectorSize) * sectorSize;
        phaseSum += p;
      }
      startA = phaseSum / around.length;
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
// same-tribe walls (player layouts get extended, not abandoned).
export function nextRingSlot(world, anchor, from, tribeId = null) {
  let best = null, bd = Infinity;
  for (const s of wallRing(anchor, world, tribeId)) {
    if (occupied(world, s.x, s.z, ['wall', 'gate'], 2.4)) continue;
    const d = (s.x - from.x) ** 2 + (s.z - from.z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function ringComplete(world, anchor, tribeId = null) {
  return wallRing(anchor, world, tribeId).every(
    (s) => occupied(world, s.x, s.z, ['wall', 'gate'], 2.4));
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
