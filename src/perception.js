import { CONFIG } from './config.js';

// Strictly local perception: limited radius + facing cone + structure
// occlusion. No agent ever receives global world state.
export function perceive(self, entities, world, tick) {
  let R = CONFIG.entity.perceptionRadius;
  // A friendly watchtower extends the vision of nearby tribe members —
  // the emergent payoff of building one (early warning of raids/wolves).
  for (const st of world.structures) {
    if (st.type !== 'tower') continue;
    if (st.tribe != null && st.tribe !== self.tribeId && st.owner !== self.id) continue;
    if ((st.pos.x - self.pos.x) ** 2 + (st.pos.z - self.pos.z) ** 2 < 18 * 18) { R += 14; break; }
  }
  const R2 = R * R;
  const fov = CONFIG.entity.perceptionFov;
  const fx = Math.sin(self.heading);
  const fz = Math.cos(self.heading);

  const out = { entities: [], resources: [], structures: [], signals: [], trees: [], animals: [] };

  for (const e of entities) {
    if (e === self || !e.alive || e.inside) continue; // sheltered = unseen
    const dx = e.pos.x - self.pos.x;
    const dz = e.pos.z - self.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > R2) continue;
    const d = Math.sqrt(d2) || 1e-6;
    // Facing cone (peripheral vision); very close agents are always sensed.
    const dot = (dx / d) * fx + (dz / d) * fz;
    if (d > 4 && Math.acos(Math.max(-1, Math.min(1, dot))) > fov / 2) continue;
    if (world.blocksSight(self.pos.x, self.pos.z, e.pos.x, e.pos.z)) continue;
    out.entities.push({ entity: e, dist: d });

    // Communication signals are heard if within the emitter's range.
    if (e.signal && tick - e.signal.tick < 12 && d < CONFIG.entity.signalRadius) {
      out.signals.push({ from: e, type: e.signal.type, dist: d, pos: e.pos });
    }
  }

  for (const res of world.resources) {
    if (!res.available) continue;
    const dx = res.pos.x - self.pos.x;
    const dz = res.pos.z - self.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > R2) continue;
    if (world.blocksSight(self.pos.x, self.pos.z, res.pos.x, res.pos.z)) continue;
    out.resources.push({ res, dist: Math.sqrt(d2) });
  }

  for (const st of world.structures) {
    const dx = st.pos.x - self.pos.x;
    const dz = st.pos.z - self.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < R2) out.structures.push({ st, dist: Math.sqrt(d2) });
  }

  for (const t of world.trees) {
    if (t.wood <= 0) continue;
    const d2 = (t.pos.x - self.pos.x) ** 2 + (t.pos.z - self.pos.z) ** 2;
    if (d2 < R2) out.trees.push({ tree: t, dist: Math.sqrt(d2) });
  }

  for (const a of world.animals) {
    if (!a.alive) continue;
    const d2 = (a.pos.x - self.pos.x) ** 2 + (a.pos.z - self.pos.z) ** 2;
    if (d2 > R2) continue;
    if (world.blocksSight(self.pos.x, self.pos.z, a.pos.x, a.pos.z)) continue;
    out.animals.push({ animal: a, dist: Math.sqrt(d2) });
  }

  out.entities.sort((a, b) => a.dist - b.dist);
  out.resources.sort((a, b) => a.dist - b.dist);
  out.structures.sort((a, b) => a.dist - b.dist);
  out.trees.sort((a, b) => a.dist - b.dist);
  out.animals.sort((a, b) => a.dist - b.dist);
  return out;
}
