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

  // Predators are pure danger — wolves can't be reasoned with.
  let wolf = null;
  for (const { animal: a, dist } of p.animals) {
    if (!a.predator) continue;
    danger += (1 - dist / CONFIG.predator.senseRadius) * 0.9;
    if (!wolf || dist < wolf._d) { wolf = a; wolf._d = dist; }
  }
  if (wolf && (!nearestThreat || wolf._d < nearestThreat._d)) nearestThreat = { pos: wolf.pos, _d: wolf._d };

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

  // --- Home & family: actually *live* at home, not only flee to it ---
  if (hasHome && !atHome) {
    // Hurt / tired / threatened pulls hard; but even content agents drift
    // home to rest and be near family (this is what enables reproduction).
    const homebody = 0.55 + t.sociability * 0.7 + t.loyalty * 0.4;
    const pull = CONFIG.home.homePull *
      (deficit * 1.6 + danger * (1.3 + t.caution) + homebody * (1 - danger));
    add('RETURN_HOME', pull, { target: self.home.pos });
  }
  if (hasHome && atHome) {
    // Stay put when safe: rest, get fed by the granary, raise a family.
    add('RETURN_HOME', 0.9 + deficit * 1.6 + t.sociability * 0.5 - danger, {});
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
  // Brave, armed agents turn and fight a wolf rather than only fleeing.
  if (wolf && wolf._d < CONFIG.entity.perceptionRadius * 0.4) {
    add('DEFEND',
      (t.aggression + t.riskTolerance * 0.6 + (self.weapon ? 1.4 : 0) + kinNear * 0.3 - t.caution * 0.6),
      { victim: wolf, target: wolf.pos });
  }
  const wallSpec = CONFIG.structures.types.wall;
  const wallCount = hasHome ? self.world.countStructures(
    self.home.pos.x, self.home.pos.z, 'wall', CONFIG.structures.villageRadius) : 99;
  if (hasHome && self.energy >= wallSpec.minEnergy &&
      wallCount < CONFIG.structures.maxPerVillage.wall) {
    const threatened = !!homeRaider || !!wolf ||
      self.memory.recent('threat', tick, CONFIG.tribe.fortifyThreatTicks);
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
  // Even out of sight, walk to the nearest existing settlement rather than
  // founding a lone hut — this is what stops house sprawl.
  let knownHome = friendlyHome;
  if (!hasHome && !knownHome) {
    const nh = self.world.nearestHome(self.pos.x, self.pos.z);
    if (nh && nh.dist < CONFIG.structures.villageRadius * 3) {
      knownHome = nh;
      add('RETURN_HOME', 0.85 + t.sociability * 0.6 - nh.dist * 0.004,
        { target: nh.st.pos, claim: true });
    }
  }
  const Sty = CONFIG.structures.types;
  const mine = (st) => st.tribe == null || st.tribe === self.tribeId ||
    self.kin.has(st.owner) || st.owner === self.id;
  // Hard caps counted against the actual village, not flaky perception —
  // settlements complete and then invest energy in people, not endless walls.
  const VR = CONFIG.structures.villageRadius;
  const cap = CONFIG.structures.maxPerVillage;
  // Count by place, not tribe tag — a village's buildings are the village's.
  const have = (type) => hasHome
    ? self.world.countStructures(self.home.pos.x, self.home.pos.z, type, VR) : 0;
  if (self._buildCooldown <= 0 && danger < 0.25) {
    if (!hasHome && !knownHome && self.energy >= Sty.house.minEnergy) {
      add('BUILD', 0.9 + t.sociability * 0.7 + t.caution * 0.4 +
        self.memory.valenceOf('built_safe'), { build: 'house' });
    } else if (hasHome) {
      const vh = self.world.countStructures(self.home.pos.x, self.home.pos.z, 'house', VR);
      if (self.energy >= Sty.center.minEnergy && self.tribeSize >= 4 && have('center') < cap.center) {
        add('BUILD', 1.0 + t.sociability * 0.6 + t.loyalty * 0.4, { build: 'center' });
      }
      if (self.energy >= Sty.storehouse.minEnergy && self.tribeSize >= 3 &&
          have('storehouse') < cap.storehouse) {
        add('BUILD', 0.8 + t.sociability * 0.5 + self.memory.valenceOf('stocked'), { build: 'storehouse' });
      }
      if ((self.tribeEra ?? 1) >= (Sty.tower.era ?? 2) && self.energy >= Sty.tower.minEnergy &&
          (self.memory.recent('threat', tick, CONFIG.tribe.fortifyThreatTicks) || wolf) &&
          have('tower') < cap.tower) {
        add('BUILD', 0.7 + t.caution * 0.8 + t.loyalty * 0.5, { build: 'tower' });
      }
      const needed = Math.ceil(self.tribeSize / CONFIG.structures.peoplePerHouse);
      if (self.energy >= Sty.house.minEnergy &&
          vh < Math.min(needed, CONFIG.structures.maxHousesPerVillage)) {
        add('BUILD', 0.45 + t.sociability * 0.4 + self.memory.valenceOf('built_safe') * 0.5,
          { build: 'house' });
      }
    }
  }

  // --- Stockpile economy: bank surplus, withdraw when hungry ---
  let store = null;
  for (const { st, dist } of p.structures) {
    if (st.type === 'storehouse' && (!store || dist < store.dist)) store = { st, dist };
  }
  if (!store && hasHome) {
    const ns = self.world.nearestStructure(self.pos.x, self.pos.z, 'storehouse');
    if (ns && ns.dist < CONFIG.entity.perceptionRadius) store = ns;
  }
  if (store) {
    if (self.energy > CONFIG.stockpile.depositKeep || self.wood > 0) {
      add('STOCKPILE', 0.3 + t.sociability * 0.4 + t.loyalty * 0.3 +
        Math.max(0, self.energy - CONFIG.stockpile.depositKeep) * 0.015,
        { target: store.st.pos, store: store.st });
    }
    if (self.energy < CONFIG.stockpile.withdrawAt && store.st.store.food > 4) {
      add('STOCKPILE', 1.4 + deficit * 2.5, { target: store.st.pos, store: store.st, withdraw: true });
    }
  }

  // --- Raiding: a hungry, aggressive tribe strips a rival's stores ---
  let enemyStruct = null;
  for (const { st, dist } of p.structures) {
    if (mine(st) || st.tribe == null) continue;
    if (st.type === 'storehouse' || st.type === 'house' || st.type === 'center') {
      if (!enemyStruct || dist < enemyStruct.dist) enemyStruct = { st, dist };
    }
  }
  // Raiding is a hunger-driven last resort, not constant warfare.
  if (enemyStruct && deficit > 0.3) {
    const greed = st_food(enemyStruct.st) ? 1.2 : 0.45;
    add('RAID',
      (t.aggression * (0.4 + deficit) + t.riskTolerance * 0.4 - t.caution * 0.6) * greed,
      { target: enemyStruct.st.pos, struct: enemyStruct.st });
  }

  // --- Nature & technology: wood -> weapons -> hunting, and farming ---
  const tree = p.trees[0];
  const prey = p.animals.find((a) => !a.animal.predator)?.animal
    ? p.animals.find((a) => !a.animal.predator) : null;
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

function st_food(st) {
  return !!(st.store && st.store.food > 6);
}

function wanderTarget(self, rng) {
  const a = self.heading + rng.range(-1, 1);
  const r = 18 + rng.range(0, 14);
  return { x: self.pos.x + Math.sin(a) * r, z: self.pos.z + Math.cos(a) * r };
}
