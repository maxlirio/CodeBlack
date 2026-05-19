import { CONFIG } from './config.js';
import { villageAnchor, nextHousePlot, ringComplete } from './village.js';

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

    // Foreign tribes carry a baseline rivalry; an active blood feud between
    // the two clans turns that into open, lethal hostility.
    // Trade goodwill cancels the baseline rivalry between trading clans.
    const relief = !ally ? self.world.bond(self.tribeId, e.tribeId) * CONFIG.trade.rivalRelief : 0;
    const rivalry = !ally && e.tribeId !== self.tribeId
      ? Math.max(0, CONFIG.tribe.rivalHostility - relief) : 0;
    const feud = ally ? 0
      : Math.min(0.9, self.world.feud(self.tribeId, e.tribeId) * CONFIG.feud.hostility);
    const hostile = rel.hostility + e.traits.aggression * 0.5 + rivalry + feud;
    if (!ally && hostile > 0.4) {
      danger += (1 - dist / CONFIG.entity.perceptionRadius) * hostile;
      if (!nearestThreat || dist < nearestThreat._d) { nearestThreat = e; nearestThreat._d = dist; }
      if (hasHome) {
        const hd = Math.hypot(e.pos.x - self.home.pos.x, e.pos.z - self.home.pos.z);
        if (hd < CONFIG.structures.wallRing * 1.6 && (!homeRaider || hd < homeRaider._hd)) {
          homeRaider = e; homeRaider._hd = hd;
        }
      }
      // Sworn enemies are struck even when not weaker — feuds mean war.
      if (feud > 0.25 && (!weakTarget || dist < weakTarget._d)) {
        weakTarget = e; weakTarget._d = dist;
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
    let s = score * (W[action] ?? 1) * SK.bonusFor(action) * (1 + rng.range(-noise, noise));
    // Commitment: keep doing what you're doing unless something is clearly
    // better — this kills the every-tick twitch between near-equal options.
    if (action === self.action) s *= 1.22;
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
    // An armed fighter is far less inclined to run (so they hold and kill
    // wolves/raiders rather than fleeing in circles).
    add('FLEE', danger * (1.6 + t.caution * 2.2) - allyCount * 0.25 - (self.weapon ? 1.1 : 0), {
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
  // Wolf-slaying: an armed villager (or a pack of kin) hunts the wolf
  // down instead of fleeing forever — a kill drops a carcass too. Scaled
  // high enough to actually beat the FLEE urge.
  if (wolf && wolf._d < CONFIG.entity.perceptionRadius * 0.55) {
    const armed = self.weapon ? 2.4 : 0;
    const pack = Math.min(2, kinNear * 0.6);
    add('DEFEND',
      1.0 + t.aggression * 1.3 + t.riskTolerance * 0.5 + armed + pack - t.caution * 0.4,
      { victim: wolf, target: wolf.pos });
  }
  // Fortify: extend the shared connected wall ring (entity picks the next
  // missing ring/gate slot). Urgent under threat; otherwise a steady civic
  // drive so an established town eventually walls itself with gates.
  const wallSpec = CONFIG.structures.types.wall;
  if (hasHome && self.energy >= wallSpec.minEnergy) {
    const anc = villageAnchor(self, self.world) ?? self.home.pos;
    const ringDone = ringComplete(self.world, anc);
    // Economy before military: only wall up calmly once the village has a
    // granary (food security). Under real threat, fortify hard regardless.
    const hasGranary = self.world.countStructures(
      self.home.pos.x, self.home.pos.z, 'storehouse', CONFIG.structures.villageRadius) > 0;
    if (!ringDone) {
      const threatened = !!homeRaider || !!wolf ||
        self.memory.recent('threat', tick, CONFIG.tribe.fortifyThreatTicks);
      if (threatened) add('FORTIFY', (0.8 + t.caution * 1.5 + t.loyalty + danger) * 1.1, {});
      else if (hasGranary) add('FORTIFY', 0.22 + t.caution * 0.25 + t.loyalty * 0.2, {});
    }
  }

  // --- Aggression / conflict (incl. avenging the slain) ---
  if (weakTarget && weakTarget._d < CONFIG.entity.perceptionRadius * 0.45) {
    const grudge = self.world.feud(self.tribeId, weakTarget.tribeId);
    const avenge = self.memory.recent('avenge', tick, 600) ? 1.3 : 0;
    // Vendetta overrides caution: a feuding clan fights even when matched.
    const want = (t.aggression * (0.8 + deficit) + grudge * 0.8 + avenge) *
      (0.6 + t.riskTolerance) - t.caution * Math.max(0, 0.5 - grudge * 0.4);
    add('ATTACK', want * (weakTarget._d < CONFIG.entity.attackRadius ? 2.4 : 1.1),
      { target: weakTarget.pos, victim: weakTarget });
    // Archers open fire before closing — feud warfare goes ranged in Era 2.
    const reach = self._rangedReach();
    if (reach > 0 && weakTarget._d > CONFIG.entity.attackRadius && weakTarget._d < reach &&
        self._shootCd <= 0) {
      add('SHOOT', want * 1.3, { target: weakTarget.pos });
    }
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
  const anchor = hasHome ? villageAnchor(self, self.world) : null;
  const plot = anchor ? nextHousePlot(self.world, anchor, self.pos) : null;
  if (self._buildCooldown <= 0 && danger < 0.25) {
    if (!hasHome && !knownHome && self.energy >= Sty.house.minEnergy) {
      // Founding a brand-new settlement away from any tribe is allowed but
      // deliberately unattractive — cohesion is rewarded, sprawl is not.
      add('BUILD', 0.55 + t.curiosity * 0.4 + t.caution * 0.3 - t.sociability * 0.3 +
        self.memory.valenceOf('built_safe'), { build: 'house' });
    } else if (hasHome) {
      const vh = self.world.countStructures(self.home.pos.x, self.home.pos.z, 'house', VR);
      // Granary first — it is the village's food security and the engine of
      // population growth, so it strongly outranks walls and even houses.
      if (self.energy >= Sty.storehouse.minEnergy && self.tribeSize >= 2 &&
          have('storehouse') < cap.storehouse) {
        add('BUILD', 1.3 + t.sociability * 0.5 + self.memory.valenceOf('stocked'),
          { build: 'storehouse', spot: plot });
      }
      if (self.energy >= Sty.center.minEnergy && self.tribeSize >= 3 && have('center') < cap.center) {
        add('BUILD', 1.0 + t.sociability * 0.6 + t.loyalty * 0.4, { build: 'center', spot: plot });
      }
      if ((self.tribeEra ?? 1) >= (Sty.tower.era ?? 2) && self.energy >= Sty.tower.minEnergy &&
          (self.memory.recent('threat', tick, CONFIG.tribe.fortifyThreatTicks) || wolf) &&
          have('tower') < cap.tower) {
        add('BUILD', 0.7 + t.caution * 0.8 + t.loyalty * 0.5, { build: 'tower', spot: plot });
      }
      // Grow the village onto the next tidy plot when overcrowded for size.
      const needed = Math.ceil(self.tribeSize / CONFIG.structures.peoplePerHouse);
      if (self.energy >= Sty.house.minEnergy && plot &&
          vh < Math.min(needed, CONFIG.structures.maxHousesPerVillage)) {
        add('BUILD', 0.5 + t.sociability * 0.4 + self.memory.valenceOf('built_safe') * 0.5,
          { build: 'house', spot: plot });
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

  // --- Raiding & siege: hunger raids stores; blood feuds wage war ---
  let enemyStruct = null, enemyCentre = null;
  for (const { st, dist } of p.structures) {
    if (mine(st) || st.tribe == null || st.type === 'ram') continue;
    if (st.type === 'storehouse' || st.type === 'house' || st.type === 'center') {
      if (!enemyStruct || dist < enemyStruct.dist) enemyStruct = { st, dist };
      if (st.type === 'center' && (!enemyCentre || dist < enemyCentre.dist)) enemyCentre = { st, dist };
    }
  }
  const grudge = enemyStruct ? self.world.feud(self.tribeId, enemyStruct.st.tribe) : 0;
  // Raiding is a hunger-driven last resort...
  if (enemyStruct && (deficit > 0.3 || grudge > 0.4)) {
    const greed = st_food(enemyStruct.st) ? 1.2 : 0.45;
    add('RAID',
      (t.aggression * (0.4 + deficit) + grudge * 0.7 + t.riskTolerance * 0.4 - t.caution * 0.6) * greed,
      { target: enemyStruct.st.pos, struct: enemyStruct.st });
  }
  // ...but a serious blood feud escalates to war: bands of warriors march
  // on the enemy even from afar, raid it, and raise rams to raze its
  // town centre and break the clan.
  const war = self.world.warTarget(self, CONFIG.feud.warThreshold);
  // Tactics: muster into a war band before advancing, converge on the
  // enemy CAPITAL together, raise era-appropriate siege engines, and a
  // bloodied fighter falls back rather than dying alone.
  if (war && self.energy > CONFIG.war.retreatEnergy) {
    const wf = self.world.feud(self.tribeId, war.st.tribe);
    const zeal = t.aggression * (0.8 + wf * 0.5) + t.loyalty * 0.5 - t.caution * 0.4;
    const objective = war.centre ?? war.st;            // shared focus point
    const banded = allyCount >= CONFIG.war.musterMin;  // war band assembled?
    const era = self.tribeEra ?? 1;
    const engine = era >= 3 ? 'catapult' : era >= 2 ? 'ballista' : 'ram';

    // Muster is a *preference*, not a gate: a lone warrior near home will
    // wait for the band, but the host still marches and sieges regardless.
    if (!banded && self.home && self.pos.distanceTo(self.home.pos) < CONFIG.tribe.homeMergeDist) {
      add('GROUP', 0.8 + zeal * 0.6 + t.loyalty,
        { target: nearestAlly ? nearestAlly.pos : self.home.pos });
    }
    add('RAID', 0.95 + zeal + (banded ? 0.5 : 0), { target: objective.pos, struct: objective });
    if (wf >= CONFIG.war.feudToSiege &&
        self.energy >= CONFIG.war.siegeMinEnergy && self._buildCooldown <= 0) {
      add('SIEGE', 1.5 + zeal + (banded ? 0.5 : 0),
        { target: objective.pos, struct: objective, engine });
    }
  } else if (war) {
    // Hurt: pull back home to recover instead of feeding the enemy a kill.
    if (self.home) add('RETURN_HOME', 1.4 + t.caution, { target: self.home.pos });
  }
  // Defensive siege: if a rival's centre is right here and we're at war,
  // raise an engine on it regardless of muster.
  if (grudge >= CONFIG.war.feudToSiege && enemyCentre &&
      self.energy >= CONFIG.war.siegeMinEnergy && self._buildCooldown <= 0) {
    const era = self.tribeEra ?? 1;
    add('SIEGE', (1.0 + t.aggression + grudge * 0.5 + t.loyalty * 0.4) - t.caution * 0.3,
      { target: enemyCentre.st.pos, struct: enemyCentre.st,
        engine: era >= 3 ? 'catapult' : era >= 2 ? 'ballista' : 'ram' });
  }

  // --- Trade & diplomacy: peaceful clans run caravans for prosperity ---
  if (!war && danger < 0.25 && self.energy > 62 &&
      (self._tradeCd ?? 0) <= tick && t.aggression < 0.62) {
    const tp = self.world.tradePartner(self);
    if (tp) {
      add('TRADE', 0.8 + t.sociability * 1.2 + (1 - t.aggression) * 0.5 +
        self.memory.valenceOf('traded'), { target: tp.partner.pos, home: tp.home, partner: tp.partner });
    }
  }

  // --- Logistics: tame a wild horse to ride & haul ---
  if (!self._mounted() && danger < 0.3 && self.energy > 45) {
    const wh = self.world.nearestWildHorse(self.pos.x, self.pos.z);
    if (wh && wh.dist < CONFIG.entity.perceptionRadius) {
      add('TAME', 0.6 + t.curiosity * 1.3 + t.riskTolerance * 0.4 - t.caution * 0.3,
        { target: wh.animal.pos, horse: wh.animal });
    }
  }

  // --- Nature & technology: wood -> weapons -> hunting, and farming ---
  const tree = p.trees[0];
  // Horses are skittish, not game — they're for taming, not the stewpot.
  const prey = p.animals.find((a) => !a.animal.predator && !a.animal.horse) ?? null;
  const wantWeapon = !self.weapon || self.weaponDur <= 1;
  const huntDrive = self.memory.valenceOf('hunted') + 0.2;
  const minWood = CONFIG.tools.ladder.wood;

  // Gather wood — for tools AND for building (everything costs wood now),
  // so settlers keep a small stockpile on hand.
  if (tree && (self.wood < 4 || (wantWeapon && self.wood < CONFIG.tools.bow.wood))) {
    add('GATHER_WOOD',
      (0.55 + t.aggression * 0.5 + t.curiosity * 0.4 + huntDrive + (self.wood < 3 ? 0.5 : 0)) *
      (prey ? 1.3 : 1) - danger,
      { target: tree.tree.pos, tree: tree.tree });
  }
  // Craft a tool once enough wood is on hand and it is safe to stop.
  if (self.wood >= minWood && wantWeapon &&
      self.energy >= CONFIG.hunt.craftMinEnergy && self._buildCooldown <= 0) {
    add('CRAFT', 1.4 + t.aggression * 0.8 + t.curiosity * 0.5 - danger * 0.5, { craft: true });
  }
  // Hunt: a feast. Bare-handed usually fails (and a boar gores you), so
  // tools pay off; a bow lets you take game from a safe distance.
  if (prey && prey.dist < CONFIG.entity.perceptionRadius * 0.8) {
    const armed = self.weapon ? 2.2 : 0.45;
    const reach = self._rangedReach();
    if (reach > 0 && prey.dist > CONFIG.entity.huntRadius && prey.dist < reach && self._shootCd <= 0) {
      add('SHOOT', (t.aggression * (0.6 + deficit) + huntDrive) * 2.4,
        { target: prey.animal.pos });
    }
    add('HUNT',
      (t.aggression * (0.7 + deficit) + t.riskTolerance * 0.5 + huntDrive) * armed - t.caution * 0.4,
      { target: prey.animal.pos, animal: prey.animal });
  }
  // Mining: quarry ore for stone — a curiosity/industry pursuit. Far
  // faster with a pickaxe, so it nudges agents toward toolmaking.
  const ore = p.ores[0];
  if (ore && danger < 0.3) {
    const pick = self._toolSpec()?.mine ? 1.8 : 0.5;
    const needStone = self.stone < 3 ? 0.6 : 0;   // stone is now a build material
    add('MINE', (0.45 + t.curiosity * 0.7 + needStone + (self._toolSpec()?.mine ? 0.6 : 0) +
      self.memory.valenceOf('mined')) * pick - ore.dist * 0.012,
      { target: ore.ore.pos, ore: ore.ore });
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
    // Husbandry: a settled, careful villager fences a paddock by home and
    // drives wild grazers into it where they fatten and breed.
    const fenceSpec = CONFIG.structures.types.fence;
    const fences = self.world.countStructures(self.home.pos.x, self.home.pos.z,
      'fence', CONFIG.pen.radius + 4);
    const husbandry = self.traits.caution > 0.45 || (self.learn.weights.FARM ?? 1) > 1.0;
    if (fences < 8 && self.wood >= fenceSpec.wood && husbandry) {
      const a = fences * 2.39996;                       // golden-angle ring
      add('BUILD', 0.6 + t.caution * 0.5, {
        build: 'fence',
        spot: { x: self.home.pos.x + Math.sin(a) * CONFIG.pen.radius,
                z: self.home.pos.z + Math.cos(a) * CONFIG.pen.radius },
        facing: a + Math.PI / 2
      });
    }
  }
  // Drive a stray grazer home — it becomes calm, penned livestock there.
  if (hasHome && danger < 0.25 &&
      (self.traits.caution > 0.45 || (self.learn.weights.FARM ?? 1) > 1.0)) {
    const beast = p.animals.find((x) => !x.animal.predator && !x.animal.horse &&
      !x.animal.penned && x.dist < CONFIG.pen.herdRange);
    if (beast) {
      add('HERD', 0.7 + t.sociability * 0.4 + self.memory.valenceOf('herded'),
        { animal: beast.animal });
    }
  }

  // --- Exploration & maintenance ---
  add('EXPLORE', (t.curiosity * 1.4 + t.riskTolerance * 0.5) * (nearestRes ? 0.3 : 1) * (1 - danger),
    { target: wanderTarget(self, rng) });
  add('IDLE', 0.35 + energy01 * 0.6 - danger - deficit + (atHome ? 0.4 : 0), {});

  if (!cand.length) return { action: 'IDLE' };
  cand.sort((a, b) => b.score - a.score);
  // If several options are about as good, pick one at random and run with
  // it (the commitment bonus then keeps it chosen) — no dithering.
  const top = cand[0].score;
  const tied = cand.filter((c) => c.score >= top * 0.93);
  return tied.length > 1 ? tied[Math.floor(rng() * tied.length)] : cand[0];
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
