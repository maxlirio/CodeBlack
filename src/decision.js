import { CONFIG } from './config.js';

// Lightweight utility-based arbitration. Every tick each candidate action
// is scored from needs + personality + memory + social context + learned
// weights + discovered-skill bonuses. Highest score wins. No networks,
// no central controller — just local arithmetic per agent.
export function decide(self, p, tick, rng) {
  const t = self.traits;
  const energy01 = self.energy / CONFIG.entity.maxEnergy;
  const deficit = 1 - energy01;

  // Local danger estimate: nearby entities weighted by our hostility/their
  // aggression, attenuated by allies standing with us.
  let danger = 0;
  let allyCount = 0;
  let nearestThreat = null;
  let nearestRes = p.resources[0]?.res ?? null;
  let nearestEntity = null;
  let nearestAlly = null;
  let weakTarget = null;

  for (const { entity: e, dist } of p.entities) {
    const rel = self.social.get(e.id);
    const ally = self.social.isAlly(e.id);
    if (ally) { allyCount++; if (!nearestAlly) nearestAlly = e; }
    const hostile = rel.hostility + e.traits.aggression * 0.5;
    if (!ally && hostile > 0.4) {
      const d = (1 - dist / CONFIG.entity.perceptionRadius) * hostile;
      danger += d;
      if (!nearestThreat || dist < nearestThreat._d) { nearestThreat = e; nearestThreat._d = dist; }
    }
    if (!nearestEntity) nearestEntity = e;
    // A weaker, lower-energy competitor near a resource is an attack target.
    if (e.energy < self.energy * 0.8 && rel.hostility > 0.1 && (!weakTarget || dist < weakTarget._d)) {
      weakTarget = e; weakTarget._d = dist;
    }
  }

  // Heard signals reshape priorities (warnings raise danger, help/rally
  // pull sociable/loyal agents toward the sender).
  let signalDanger = 0;
  let rallyPoint = null;
  let helpCall = null;
  for (const s of p.signals) {
    if (s.type === 'WARN') signalDanger += 0.6 * (1 - s.dist / CONFIG.entity.signalRadius);
    else if (s.type === 'RALLY') rallyPoint = s.pos;
    else if (s.type === 'HELP' && self.social.get(s.from.id).trust > 0.2) helpCall = s.from;
  }
  danger += signalDanger;

  if (!nearestThreat) {
    const mt = self.memory.lastThreat(tick);
    if (mt) { danger += 0.4; }
  }

  const W = self.learn.weights;
  const SK = self.skills;
  const noise = (1 - t.caution) * 0.12;

  const cand = [];
  const add = (action, score, data = {}) => {
    if (score <= 0) return;
    const s = score * (W[action] ?? 1) * SK.bonusFor(action) * (1 + rng.range(-noise, noise));
    cand.push({ action, score: s, ...data });
  };

  // --- Survival: energy ---
  if (nearestRes && p.resources[0].dist < CONFIG.entity.eatRadius) {
    add('EAT', 2.2 + deficit * 4, { target: nearestRes.pos });
  }
  if (nearestRes) {
    add('SEEK_RESOURCE', 0.5 + deficit * 3.4 - p.resources[0].dist * 0.02, { target: nearestRes.pos });
  } else {
    const mem = self.memory.lastResource(tick);
    if (mem) add('SEEK_RESOURCE', 0.4 + deficit * 2.4, { target: mem });
  }

  // --- Safety ---
  if (danger > 0.25) {
    add('FLEE', danger * (1.6 + t.caution * 2.2) - allyCount * 0.25, {
      target: nearestThreat ? nearestThreat.pos : self.memory.lastThreat(tick)
    });
    add('GROUP', danger * (1.1 + t.sociability + t.loyalty) , {
      target: nearestAlly ? nearestAlly.pos : rallyPoint
    });
    add('COMMUNICATE', danger * (0.8 + t.sociability), { signal: 'WARN' });
    add('BUILD', (danger * 0.9 + self.memory.valenceOf('built_safe')) * (1 + t.caution),
      { build: true, gated: self.energy < CONFIG.entity.buildMinEnergy });
  }

  // --- Aggression / conflict ---
  if (weakTarget && weakTarget._d < CONFIG.entity.perceptionRadius * 0.45) {
    const want = t.aggression * (0.8 + deficit) * (0.6 + t.riskTolerance) - t.caution * 0.5;
    add('ATTACK', want * (weakTarget._d < CONFIG.entity.attackRadius ? 2.4 : 1.1), { target: weakTarget.pos, victim: weakTarget });
  }

  // --- Social ---
  if (nearestEntity) {
    const r = self.social.get(nearestEntity.id);
    add('APPROACH', t.sociability * (0.6 + r.trust) * (1 - danger * 0.5) + (helpCall ? 1.4 * t.loyalty : 0),
      { target: helpCall ? helpCall.pos : nearestEntity.pos, friend: helpCall ?? nearestEntity });
    add('AVOID', t.caution * (r.hostility + 0.2) * (nearestEntity.energy > self.energy ? 1.2 : 0.6),
      { target: nearestEntity.pos });
  }
  if (rallyPoint) add('GROUP', (t.loyalty + t.sociability) * 0.9, { target: rallyPoint });

  // --- Exploration & maintenance ---
  add('EXPLORE', (t.curiosity * 1.4 + t.riskTolerance * 0.5) * (nearestRes ? 0.3 : 1) * (1 - danger),
    { target: wanderTarget(self, rng) });
  add('IDLE', 0.35 + energy01 * 0.6 - danger - deficit, {});
  if (self.energy >= CONFIG.entity.buildMinEnergy && p.structures.length < 2) {
    add('BUILD', 0.5 + self.memory.valenceOf('built_safe') + t.caution * 0.4, { build: true });
  }

  if (!cand.length) return { action: 'IDLE' };
  cand.sort((a, b) => b.score - a.score);
  return cand[0];
}

function wanderTarget(self, rng) {
  const a = self.heading + rng.range(-1, 1);
  const r = 18 + rng.range(0, 14);
  return { x: self.pos.x + Math.sin(a) * r, z: self.pos.z + Math.cos(a) * r };
}
