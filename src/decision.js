import { CONFIG } from './config.js';

// Lightweight utility-based arbitration. Every tick each candidate action
// is scored from needs + personality + memory + social context + family,
// home and tribe + learned weights + discovered-skill bonuses. Highest
// score wins. No networks, no central controller — just local arithmetic.
export function decide(self, p, tick, rng) {
  const t = self.traits;
  const energy01 = self.energy / CONFIG.entity.maxEnergy;
  const deficit = 1 - energy01;

  const hasHome = !!self.home;
  const homeDist = hasHome ? Math.hypot(self.pos.x - self.home.pos.x, self.pos.z - self.home.pos.z) : Infinity;
  const atHome = homeDist < CONFIG.home.restRadius;

  let danger = 0;
  let allyCount = 0;
  let kinNear = 0;
  let nearestThreat = null;
  let nearestRes = p.resources[0]?.res ?? null;
  let nearestEntity = null;
  let nearestAlly = null;
  let weakTarget = null;
  let homeRaider = null;        // an intruder close to our home

  for (const { entity: e, dist } of p.entities) {
    const rel = self.social.get(e.id);
    const sameTribe = e.tribeId === self.tribeId;
    const kin = self.kin.has(e.id);
    const ally = kin || sameTribe || self.social.isAlly(e.id);
    if (ally) { allyCount++; if (kin || sameTribe) kinNear++; if (!nearestAlly) nearestAlly = e; }

    // Foreign tribes carry a baseline rivalry; kin/tribe never read as threat.
    const rivalry = !ally && e.tribeId !== self.tribeId ? CONFIG.tribe.rivalHostility : 0;
    const hostile = rel.hostility + e.traits.aggression * 0.5 + rivalry;
    if (!ally && hostile > 0.4) {
      danger += (1 - dist / CONFIG.entity.perceptionRadius) * hostile;
      if (!nearestThreat || dist < nearestThreat._d) { nearestThreat = e; nearestThreat._d = dist; }
      if (hasHome) {
        const hd = Math.hypot(e.pos.x - self.home.pos.x, e.pos.z - self.home.pos.z);
        if (hd < CONFIG.structures.wallRing * 1.6 && (!homeRaider || hd < homeRaider._hd)) {
          homeRaider = e; homeRaider._hd = hd;
        }
      }
    }
    if (!nearestEntity) nearestEntity = e;
    if (e.energy < self.energy * 0.8 && rel.hostility > 0.1 && !self.kin.has(e.id) &&
        (!weakTarget || dist < weakTarget._d)) {
      weakTarget = e; weakTarget._d = dist;
    }
  }

  let rallyPoint = null;
  let helpCall = null;
  for (const s of p.signals) {
    if (s.type === 'WARN') danger += 0.6 * (1 - s.dist / CONFIG.entity.signalRadius);
    else if (s.type === 'RALLY') rallyPoint = s.pos;
    else if (s.type === 'HELP' && self.social.get(s.from.id).trust > 0.2) helpCall = s.from;
  }
  if (!nearestThreat && self.memory.lastThreat(tick)) danger += 0.4;

  // Home is a sanctuary: danger felt there is dampened (the whole point of
  // settling and walling up), more so when kin stand with you.
  if (atHome) danger *= (1 - CONFIG.home.safetyBonus) / (1 + kinNear * 0.15);

  const W = self.learn.weights;
  const SK = self.skills;
  const noise = (1 - t.caution) * 0.12;
  const cand = [];
  const add = (action, score, data = {}) => {
    if (score <= 0) return;
    const s = score * (W[action] ?? 1) * SK.bonusFor(action) * (1 + rng.range(-noise, noise));
    cand.push({ action, score: s, ...data });
  };

  // --- Survival: foraging berries / harvesting crops / carcasses ---
  if (nearestRes && p.resources[0].dist < CONFIG.entity.eatRadius) {
    add('EAT', 2.2 + deficit * 4, { target: nearestRes.pos, food: nearestRes });
  }
  if (nearestRes) {
    add('SEEK_RESOURCE', 0.5 + deficit * 3.4 - p.resources[0].dist * 0.02, { target: nearestRes.pos });
  } else {
    const mem = self.memory.lastResource(tick);
    if (mem) add('SEEK_RESOURCE', 0.4 + deficit * 2.4, { target: mem });
  }

  // --- Home & family: retreat to home when hurt, tired, or in danger ---
  if (hasHome && !atHome) {
    const pull = CONFIG.home.homePull * (deficit * 1.6 + danger * (1.3 + t.caution) + 0.15);
    add('RETURN_HOME', pull, { target: self.home.pos });
  }
  if (hasHome && atHome && (deficit > 0.3 || danger > 0.2)) {
    add('RETURN_HOME', 0.6 + deficit * 1.4, {}); // stay home and rest
  }

  // --- Safety ---
  if (danger > 0.25) {
    add('FLEE', danger * (1.6 + t.caution * 2.2) - allyCount * 0.25, {
      target: nearestThreat ? nearestThreat.pos : self.memory.lastThreat(tick)
    });
    add('GROUP', danger * (1.1 + t.sociability + t.loyalty), {
      target: nearestAlly ? nearestAlly.pos : (hasHome ? self.home.pos : rallyPoint)
    });
    add('COMMUNICATE', danger * (0.8 + t.sociability), { signal: 'WARN' });
  }

  // --- Defend & fortify the settlement ---
  if (homeRaider) {
    add('DEFEND', (t.loyalty * 1.4 + t.aggression + Math.min(1, kinNear * 0.4)) * (1 + danger),
      { victim: homeRaider, target: homeRaider.pos });
  }
  if (hasHome && self.energy >= CONFIG.structures.wallMinEnergy) {
    const threatened = !!homeRaider || self.memory.recent('threat', tick, CONFIG.tribe.fortifyThreatTicks);
    if (threatened) {
      const dir = homeRaider
        ? norm(homeRaider.pos.x - self.home.pos.x, homeRaider.pos.z - self.home.pos.z)
        : self._homeOutwardDir();
      add('FORTIFY', (0.8 + t.caution * 1.5 + t.loyalty + danger) * 1.1, { threatDir: dir });
    }
  }

  // --- Aggression / conflict ---
  if (weakTarget && weakTarget._d < CONFIG.entity.perceptionRadius * 0.45) {
    const want = t.aggression * (0.8 + deficit) * (0.6 + t.riskTolerance) - t.caution * 0.5;
    add('ATTACK', want * (weakTarget._d < CONFIG.entity.attackRadius ? 2.4 : 1.1),
      { target: weakTarget.pos, victim: weakTarget });
  }

  // --- Social ---
  if (nearestEntity) {
    const r = self.social.get(nearestEntity.id);
    const kinBond = self.kin.has(nearestEntity.id) ? 0.6 : 0;
    add('APPROACH',
      t.sociability * (0.6 + r.trust + kinBond) * (1 - danger * 0.5) + (helpCall ? 1.4 * t.loyalty : 0),
      { target: helpCall ? helpCall.pos : nearestEntity.pos, friend: helpCall ?? nearestEntity });
    add('AVOID', t.caution * (r.hostility + 0.2) * (nearestEntity.energy > self.energy ? 1.2 : 0.6),
      { target: nearestEntity.pos });
  }
  if (rallyPoint) add('GROUP', (t.loyalty + t.sociability) * 0.9, { target: rallyPoint });

  // --- Settle: join an existing village, or found / grow one ---
  // A friendly house we can see and could move into (don't sprawl).
  let friendlyHome = null;
  for (const { st, dist } of p.structures) {
    if (st.type !== 'house') continue;
    if (st.tribe == null || st.tribe === self.tribeId || self.kin.has(st.owner) || st.owner === self.id) {
      if (!friendlyHome || dist < friendlyHome.dist) friendlyHome = { st, dist };
    }
  }
  if (!hasHome && friendlyHome) {
    // Prefer moving in over building — this clusters families into villages.
    add('RETURN_HOME', 0.9 + t.sociability * 0.7, { target: friendlyHome.st.pos, claim: true });
  }
  if (self.energy >= CONFIG.structures.houseMinEnergy && self._buildCooldown <= 0 && danger < 0.25) {
    if (!hasHome && !friendlyHome) {
      // Open ground, no shelter in sight: found a new settlement.
      add('BUILD', 0.9 + t.sociability * 0.7 + t.caution * 0.4 +
        self.memory.valenceOf('built_safe'), { build: true });
    } else if (hasHome) {
      // Only expand when the village is genuinely overcrowded for its size.
      const villageHouses = self.world.countHousesNear(
        self.home.pos.x, self.home.pos.z, CONFIG.tribe.homeMergeDist);
      const needed = Math.ceil(self.tribeSize / CONFIG.structures.peoplePerHouse);
      if (villageHouses < Math.min(needed, CONFIG.structures.maxHousesPerVillage)) {
        add('BUILD', 0.45 + t.sociability * 0.4 + self.memory.valenceOf('built_safe') * 0.5,
          { build: true });
      }
    }
  }

  // --- Nature & technology: wood -> weapons -> hunting, and farming ---
  const tree = p.trees[0];
  const prey = p.animals[0];
  const wantWeapon = !self.weapon || self.weaponDur <= 1;
  const huntDrive = self.memory.valenceOf('hunted') + 0.2;

  // Gather wood — mostly to craft a weapon, valued more if game is around.
  if (tree && wantWeapon && self.wood < CONFIG.hunt.weaponWoodCost) {
    add('GATHER_WOOD',
      (0.5 + t.aggression * 0.7 + t.curiosity * 0.4 + huntDrive) * (prey ? 1.5 : 1) - danger,
      { target: tree.tree.pos, tree: tree.tree });
  }
  // Craft a weapon once enough wood is on hand and it is safe to stop.
  if (self.wood >= CONFIG.hunt.weaponWoodCost && wantWeapon &&
      self.energy >= CONFIG.hunt.craftMinEnergy && self._buildCooldown <= 0) {
    add('CRAFT', 1.4 + t.aggression * 0.8 + t.curiosity * 0.5 - danger * 0.5, { craft: true });
  }
  // Hunt: a feast, but bare-handed it usually fails — that gap is the
  // selection pressure that makes weapon-making pay off.
  if (prey && prey.dist < CONFIG.entity.perceptionRadius * 0.8) {
    const armed = self.weapon ? 2.2 : 0.45;
    add('HUNT',
      (t.aggression * (0.7 + deficit) + t.riskTolerance * 0.5 + huntDrive) * armed - t.caution * 0.4,
      { target: prey.animal.pos, animal: prey.animal });
  }
  // Farming: a settled, surplus activity that yields more than foraging and
  // anchors agents to their village (food security -> bigger settlements).
  if (hasHome && atHome && self.energy > CONFIG.family.reproEnergy && danger < 0.2 &&
      self._buildCooldown <= 0) {
    const cropsHere = self.world.crops.filter(
      (c) => (c.pos.x - self.home.pos.x) ** 2 + (c.pos.z - self.home.pos.z) ** 2 < 24 ** 2).length;
    if (cropsHere < 4) {
      add('FARM', 0.7 + t.caution * 0.5 + t.sociability * 0.4 + self.memory.valenceOf('farmed'),
        { farm: true });
    }
  }

  // --- Exploration & maintenance ---
  add('EXPLORE', (t.curiosity * 1.4 + t.riskTolerance * 0.5) * (nearestRes ? 0.3 : 1) * (1 - danger),
    { target: wanderTarget(self, rng) });
  add('IDLE', 0.35 + energy01 * 0.6 - danger - deficit + (atHome ? 0.4 : 0), {});

  if (!cand.length) return { action: 'IDLE' };
  cand.sort((a, b) => b.score - a.score);
  return cand[0];
}

function norm(x, z) {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

function wanderTarget(self, rng) {
  const a = self.heading + rng.range(-1, 1);
  const r = 18 + rng.range(0, 14);
  return { x: self.pos.x + Math.sin(a) * r, z: self.pos.z + Math.cos(a) * r };
}
