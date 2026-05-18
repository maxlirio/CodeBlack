import * as THREE from 'three';
import { CONFIG, ACTIONS } from './config.js';
import { clamp } from './rng.js';
import { Memory } from './memory.js';
import { Social } from './social.js';
import { SkillSystem } from './skills.js';
import { randomTraits, driftTrait } from './personality.js';
import { perceive } from './perception.js';
import { decide } from './decision.js';
import { createHumanoid, animateHumanoid } from './humanoid.js';
import { makeTool } from './nature.js';
import { villageAnchor, nextRingSlot, nextHousePlot } from './village.js';

let NEXT_ID = 1;

export class Entity {
  constructor(world, rng, opts = {}) {
    this.id = NEXT_ID++;
    this.world = world;
    this.rng = rng;
    this.alive = true;
    this.generation = opts.generation ?? 1;
    this.age = 0;
    this.fitness = 0;

    this.traits = opts.traits ?? randomTraits(rng);
    this.memory = new Memory();
    this.social = new Social();
    this.skills = new SkillSystem();
    if (opts.skills) this.skills.importSkills(opts.skills);

    // Learned per-action weight multipliers — the reinforcement substrate.
    this.learn = { weights: Object.fromEntries(ACTIONS.map((a) => [a, 1])) };

    const x = opts.x ?? rng.range(-world.size * 0.7, world.size * 0.7);
    const z = opts.z ?? rng.range(-world.size * 0.7, world.size * 0.7);
    this.pos = new THREE.Vector3(x, world.heightAt(x, z), z);
    this.vel = new THREE.Vector3();
    this.heading = rng.range(-Math.PI, Math.PI);
    this.energy = opts.energy ?? rng.range(55, 90);

    const hue = (this.traits.aggression * 0.0 + this.traits.sociability * 0.6 + 0.05) % 1;
    this.color = new THREE.Color().setHSL(0.58 - this.traits.aggression * 0.5, 0.55, 0.55);
    this.mesh = createHumanoid(this.color);
    this.mesh.userData.entityId = this.id;
    this.mesh.userData.groundY = this.pos.y;
    this.mesh.position.copy(this.pos);
    world.scene.add(this.mesh);

    // Family & territory.
    this.home = null;                       // a 'house' structure this agent lives at
    this.parents = opts.parents ?? [];      // parent ids
    this.kin = new Set(opts.kin ?? []);     // parents + children + siblings
    this.familyId = opts.familyId ?? this.id;
    this.tribeId = this.id;
    this.tribeColor = this.color;
    this.tribeSize = 1;
    this.tribeEra = 1;
    this._lastReproTick = -99999;

    // Tools & inventory — the basis of the wood -> tools -> hunting tech.
    // tool = { type:'spear'|'bow'|'axe'|'club', dur:n } or null (unarmed).
    this.wood = 0;
    this.tool = null;
    this._toolMesh = null;
    this._shootCd = 0;

    this.action = 'IDLE';
    this.animState = 'idle';
    this.signal = null;
    this._prevEnergy = this.energy;
    this._buildCooldown = 0;

    // Kin start out trusting each other — the seed of families and tribes.
    for (const k of this.kin) {
      const r = this.social.get(k);
      r.trust = Math.max(r.trust, CONFIG.family.kinTrust);
      r.familiarity = Math.max(r.familiarity, 0.5);
    }
    if (opts.homeStructure) this.home = opts.homeStructure;
  }

  setTribeColor(color) {
    const fm = this.mesh?.userData?.flagMat;
    if (fm) fm.color.copy(color);
  }

  // Back-compat: lots of code reads .weapon / .weaponDur.
  get weapon() { return !!this.tool; }
  get weaponDur() { return this.tool ? this.tool.dur : 0; }
  get toolType() { return this.tool ? this.tool.type : 'none'; }
  _toolSpec() { return this.tool ? CONFIG.tools[this.tool.type] : null; }

  atHome() {
    return this.home ? this.pos.distanceTo(this.home.pos) < CONFIG.home.restRadius : false;
  }

  // A readable label for what this agent has *learned* to specialise in —
  // emergent, derived from its strongest learned weights, not assigned.
  role() {
    const W = this.learn.weights;
    const map = {
      HUNT: 'Hunter', GATHER_WOOD: 'Woodcutter', CRAFT: 'Toolmaker',
      FARM: 'Farmer', BUILD: 'Builder', FORTIFY: 'Builder',
      DEFEND: 'Warrior', ATTACK: 'Warrior', RAID: 'Raider',
      STOCKPILE: 'Keeper', SEEK_RESOURCE: 'Forager', EAT: 'Forager',
      APPROACH: 'Diplomat', GROUP: 'Diplomat', EXPLORE: 'Scout'
    };
    let best = 'Forager', bv = -Infinity;
    for (const k in map) if ((W[k] ?? 1) > bv) { bv = W[k] ?? 1; best = map[k]; }
    return best;
  }

  // One fixed simulation step (dt seconds).
  tick(entities, tick, dt) {
    if (!this.alive) return;
    this.age += dt;
    this._buildCooldown = Math.max(0, this._buildCooldown - dt);
    this._shootCd = Math.max(0, this._shootCd - 1);

    const p = perceive(this, entities, this.world, tick);
    this._observe(p, tick);

    // When a human is playing as this villager, their input replaces the
    // utility AI; everything else (physics, energy, animation) is identical.
    const choice = this.controller ? this.controller(this, p) : decide(this, p, tick, this.rng);
    const prevAction = this.action;
    this.action = choice.action;
    this.skills.record(choice.action);

    this._dangerBefore = p.entities.filter((x) => !this.social.isAlly(x.entity.id) && x.entity.traits.aggression > 0.5).length;
    this._act(choice, p, tick, dt);
    this._physics(dt);
    this._energy(dt);
    this._learn(choice, prevAction, tick);

    this.memory.decay(tick);
    this.social.decay();
    this._cultural(p, tick);
    this._home(p, tick);
    this._tryReproduce(p, tick, entities);

    // Fitness now rewards a lineage: surviving kin and a held home mean the
    // agent's strategy reproduced, which is what evolution should select for.
    this.fitness = this.age * 0.4 + this.energy * 0.15 + this.skills.skills.size * 4 +
      this.social.rel.size * 0.3 + this.kin.size * 2.5 + (this.home ? 6 : 0);
    if (this.energy <= 0) {
      // A recent attacker is the killer — igniting a blood feud between clans.
      const killer = (this._killer && this._killer.alive &&
        tick - (this._killerTick ?? -999) < 60) ? this._killer : null;
      if (killer) {
        this.world.registerKill?.(this, killer, entities);
        killer.memory?.remember('killed', tick, this.pos, 0.5);
      }
      this.die();
    }
  }

  // Resting at home recovers energy; an unhoused agent that wanders into a
  // friendly house claims it (settlements gather their own people).
  _home(p, tick) {
    if (!this.home) {
      const claim = this.world.nearestHome(this.pos.x, this.pos.z,
        (st) => st.tribe == null || st.tribe === this.tribeId || st.owner === this.id ||
          this.kin.has(st.owner));
      if (claim && claim.dist < CONFIG.home.restRadius) this.home = claim.st;
    }
    if (this.atHome() && (this.action === 'IDLE' || this.action === 'RETURN_HOME')) {
      const sec = 1 / CONFIG.sim.tickRate;
      this.energy = clamp(this.energy + CONFIG.home.restRegenPerSecond * sec,
        0, CONFIG.entity.maxEnergy);
      // Food security: a stocked village granary feeds those resting at
      // home, turning the shared stockpile into population growth.
      if (this.energy < CONFIG.entity.maxEnergy) {
        const SP = CONFIG.stockpile;
        const gr = this.world.nearestStructure(this.home.pos.x, this.home.pos.z, 'storehouse',
          (st) => st.store.food > 1);
        if (gr && gr.dist < SP.feedRadius) {
          const want = SP.feedRegenBonus * sec;
          const afford = gr.st.store.food / SP.feedCostPerEnergy;
          const give = Math.min(want, afford, CONFIG.entity.maxEnergy - this.energy);
          this.energy += give;
          gr.st.store.food -= give * SP.feedCostPerEnergy;
        }
      }
    }
  }

  // Pair-bonding: two mutually trusting, well-fed, mature, same-tribe agents
  // near a home produce a child that inherits from both and joins the family.
  _tryReproduce(p, tick, entities) {
    if (this.age < CONFIG.family.minAge) return;
    if (this.energy < CONFIG.family.reproEnergy) return;
    if (tick - this._lastReproTick < CONFIG.family.reproCooldownTicks) return;
    if (entities.filter((e) => e.alive).length >= CONFIG.population.max) return;
    if (!this.atHome()) return;

    for (const { entity: e, dist } of p.entities) {
      if (dist > CONFIG.entity.perceptionRadius * 0.45) continue; // same village
      if (e.age < CONFIG.family.minAge) continue;
      if (e.energy < CONFIG.family.reproEnergy * 0.85) continue;
      if (tick - e._lastReproTick < CONFIG.family.reproCooldownTicks) continue;
      if (this._closeKin(e)) continue; // only the nuclear family is off-limits
      const a = this.social.get(e.id);
      const b = e.social.get(this.id);
      if (a.trust < CONFIG.family.bondTrust || b.trust < CONFIG.family.bondTrust) continue;
      if (a.familiarity < CONFIG.family.bondFamiliarity) continue;

      this.energy -= CONFIG.family.reproCost;
      e.energy -= CONFIG.family.reproCost;
      this._lastReproTick = e._lastReproTick = tick;
      this.world.spawnChild?.(this, e);
      this.memory.remember('reproduced', tick, this.pos, 0.9);
      e.memory.remember('reproduced', tick, e.pos, 0.9);
      break;
    }
  }

  // Off-limits = parent/child or full siblings. Cousins and the wider
  // kin/tribe network can still pair, so a village keeps reproducing
  // instead of freezing once everyone is distantly related.
  _closeKin(e) {
    if (this.parents.includes(e.id) || e.parents.includes(this.id)) return true;
    return this.parents.some((pid) => e.parents.includes(pid));
  }

  registerChild(child) {
    this.kin.add(child.id);
    const r = this.social.get(child.id);
    r.trust = Math.max(r.trust, CONFIG.family.kinTrust + 0.15);
    r.familiarity = 0.7;
  }

  _observe(p, tick) {
    if (p.resources[0]) this.memory.remember('saw_resource', tick, p.resources[0].res.pos, 0.2);
    for (const { entity: e, dist } of p.entities) {
      this.social.familiar(e.id);
      const rel = this.social.get(e.id);
      if (e.action === 'ATTACK' && e.victim === this) {
        this.social.conflict(e.id);
        this.memory.remember('threat', tick, e.pos, -1);
      }
      // Standing together while danger is near builds trust (shared peril).
      if (this._dangerBefore > 0 && dist < 8 && e.traits.aggression < 0.5) this.social.sharedDanger(e.id);
      // Living alongside kin / tribe steadily deepens bonds — the slow
      // accrual that lets families and pair-bonds actually form.
      if (dist < 7 && (this.kin.has(e.id) || e.tribeId === this.tribeId)) {
        const r = this.social.get(e.id);
        r.trust = clamp(r.trust + CONFIG.family.tribeProxTrust, 0, 1);
      }
    }
  }

  _act(choice, p, tick, dt) {
    this.signal = null;
    let target = choice.target ? new THREE.Vector3(choice.target.x, 0, choice.target.z) : null;
    let want = 'idle';

    switch (choice.action) {
      case 'EAT': {
        const r = p.resources[0];
        if (r && r.dist < CONFIG.entity.eatRadius && r.res.available) {
          this.energy = clamp(this.energy + this.world.harvestFood(r.res, tick), 0, CONFIG.entity.maxEnergy);
          this.memory.remember(r.res.kind === 'crop' ? 'farmed' : 'ate', tick, r.res.pos, 1);
          want = 'interact';
        } else want = 'idle';
        break;
      }
      case 'SEEK_RESOURCE':
      case 'APPROACH':
      case 'GROUP':
      case 'EXPLORE':
        if (target) want = this._moveToward(target, this._urgent(choice) ? 'run' : 'walk', dt);
        if (choice.action === 'APPROACH' && choice.friend) {
          const d = this.pos.distanceTo(choice.friend.pos);
          if (d < CONFIG.entity.interactRadius) {
            this.social.cooperate(choice.friend.id);
            choice.friend.social?.cooperate(this.id);
            this.memory.remember('cooperated', tick, null, 0.6);
            want = 'interact';
          }
        }
        break;
      case 'FLEE':
      case 'AVOID':
        if (target) {
          const away = new THREE.Vector3().subVectors(this.pos, target).setY(0);
          if (away.lengthSq() < 0.01) away.set(this.rng.gauss(), 0, this.rng.gauss());
          const dest = new THREE.Vector3().copy(this.pos).add(away.normalize().multiplyScalar(14));
          want = this._moveToward(dest, 'run', dt);
        }
        break;
      case 'ATTACK': {
        const v = choice.victim;
        if (v && v.alive) {
          const d = this.pos.distanceTo(v.pos);
          if (d < CONFIG.entity.attackRadius) {
            v.damage(this._meleeDamage(), this);
            this._useTool();
            this.social.conflict(v.id);
            this.energy -= 4;
            this.memory.remember('attacked', tick, v.pos, v.energy <= 0 ? 0.7 : 0.1);
            want = 'attack';
          } else {
            want = this._moveToward(v.pos, 'run', dt);
          }
        }
        break;
      }
      case 'COMMUNICATE':
        this.signal = { type: choice.signal ?? 'RALLY', tick };
        this.memory.remember('signalled', tick, null, 0.1);
        want = 'interact';
        break;
      case 'RETURN_HOME': {
        // Head to our own home, or to a friendly house we're moving into
        // (which _home() then claims when we get close enough).
        const dest = this.home ? this.home.pos : target;
        if (dest) {
          const d = Math.hypot(this.pos.x - dest.x, this.pos.z - dest.z);
          want = (this.home && d < CONFIG.home.restRadius * 0.6) ? 'idle'
            : this._moveToward(dest, this._dangerBefore > 0 ? 'run' : 'walk', dt);
        } else want = 'idle';
        break;
      }
      case 'DEFEND': {
        // Hold the line between home and the nearest intruder.
        const v = choice.victim;
        if (v && v.alive) {
          const d = this.pos.distanceTo(v.pos);
          if (d < CONFIG.entity.attackRadius) {
            v.damage(this._meleeDamage(), this);
            this._useTool();
            if (v.id != null) this.social.conflict(v.id);  // v may be a wolf
            this.energy -= 3;
            this.memory.remember('defended', tick, this.pos, 0.5);
            want = 'attack';
          } else want = this._moveToward(v.pos, 'run', dt);
        } else if (this.home) {
          want = this._moveToward(this.home.pos, 'walk', dt);
        }
        break;
      }
      case 'BUILD': {
        const bt = typeof choice.build === 'string' ? choice.build : 'house';
        const spec = CONFIG.structures.types[bt] ?? CONFIG.structures.types.house;
        if (!choice.gated && this.energy >= spec.minEnergy && this._buildCooldown <= 0) {
          // Build on the tidy village plot if one was assigned (keeps towns
          // organised); otherwise where standing (founding / player mode).
          const spot = choice.spot;
          if (spot && Math.hypot(this.pos.x - spot.x, this.pos.z - spot.z) > 2.4) {
            want = this._moveToward(spot, 'walk', dt);
            break;
          }
          this._buildTimer = (this._buildTimer ?? 0) + dt;
          want = 'build';
          if (this._buildTimer > 1.4) {
            const where = spot ? { x: spot.x, z: spot.z } : this.pos;
            const st = this.world.addStructure(where, this.tribeColor, bt, this);
            this.energy -= spec.cost;
            if (bt === 'house' && !this.home) this.home = st; // first house = home
            this._buildTimer = 0;
            // Long cool-down: build, then go live (forage, family) rather
            // than construct endlessly — this frees energy for population.
            this._buildCooldown = { house: 18, storehouse: 24, tower: 26, center: 30 }[bt] ?? 20;
            const safeNow = this._dangerBefore === 0;
            this.memory.remember('built_safe', tick, this.pos, safeNow ? 0.8 : 0.4);
            if (bt === 'storehouse') this.memory.remember('stocked', tick, this.pos, 0.6);
          }
        } else want = 'idle';
        break;
      }
      case 'FORTIFY': {
        // Build the next missing segment of the shared, connected wall ring
        // (or a gateway slot) so the village ends up properly walled with
        // gates at the corners rather than a scatter of stubs.
        const anchor = choice.anchor ?? (this.home ? villageAnchor(this, this.world) : null);
        const slot = anchor ? nextRingSlot(this.world, anchor, this.pos) : null;
        const spec = slot ? CONFIG.structures.types[slot.type] : CONFIG.structures.types.wall;
        if (slot && this.energy >= spec.minEnergy && this._buildCooldown <= 0) {
          want = Math.hypot(this.pos.x - slot.x, this.pos.z - slot.z) > 2.5
            ? this._moveToward(slot, 'walk', dt)
            : 'build';
          if (want === 'build') {
            this._buildTimer = (this._buildTimer ?? 0) + dt;
            if (this._buildTimer > 1.1) {
              this.world.addStructure({ x: slot.x, z: slot.z, facing: slot.facing },
                this.tribeColor, slot.type, this);
              this.energy -= spec.cost;
              this._buildTimer = 0;
              this._buildCooldown = slot.type === 'gate' ? 18 : 14;
              this.memory.remember('fortified', tick, this.pos, 0.6);
            }
          }
        } else want = 'idle';
        break;
      }
      case 'STOCKPILE': {
        const st = choice.store;
        if (st && st.store) {
          if (this.pos.distanceTo(st.pos) > CONFIG.stockpile.storeRadius) {
            want = this._moveToward(st.pos, 'walk', dt);
          } else if (choice.withdraw) {
            const take = Math.min(st.store.food,
              CONFIG.stockpile.withdrawTo - this.energy);
            if (take > 0) {
              st.store.food -= take;
              this.energy = clamp(this.energy + take, 0, CONFIG.entity.maxEnergy);
              this.memory.remember('stocked', tick, st.pos, 0.5);
            }
            want = 'interact';
          } else {
            // Bank surplus energy as food + drop off any carried wood.
            if (this.energy > CONFIG.stockpile.depositKeep) {
              const give = Math.min(CONFIG.stockpile.depositChunk,
                this.energy - CONFIG.stockpile.depositKeep);
              this.energy -= give;
              st.store.food += give;
            }
            if (this.wood > 0) { st.store.wood += this.wood; this.wood = 0; }
            this.memory.remember('stocked', tick, st.pos, 0.6);
            want = 'interact';
          }
        } else want = 'idle';
        break;
      }
      case 'RAID': {
        const st = choice.struct;
        if (st && this.world.structures.includes(st)) {
          if (this.pos.distanceTo(st.pos) > CONFIG.entity.attackRadius + st.radius) {
            want = this._moveToward(st.pos, 'run', dt);
          } else {
            // Strip stored food, then batter the structure down.
            if (st.store && st.store.food > 0) {
              const loot = Math.min(st.store.food, CONFIG.stockpile.raidGain);
              st.store.food -= loot;
              this.energy = clamp(this.energy + loot, 0, CONFIG.entity.maxEnergy);
            }
            this.world.damageStructure(st, this._meleeDamage());
            this._useTool();
            this.energy -= 2;
            this.memory.remember('raided', tick, st.pos, 0.5);
            want = 'attack';
          }
        } else want = 'idle';
        break;
      }
      case 'GATHER_WOOD': {
        const tr = choice.tree;
        if (tr && tr.wood > 0) {
          if (this.pos.distanceTo(tr.pos) < CONFIG.entity.gatherRadius) {
            this._workTimer = (this._workTimer ?? 0) + dt;
            want = 'build'; // chopping uses the repetitive work cycle
            if (this._workTimer > 0.9) {
              this.wood += this.world.chopWood(tr, tick);
              this._workTimer = 0;
              this.memory.remember('gathered_wood', tick, tr.pos, 0.3);
            }
          } else want = this._moveToward(tr.pos, 'walk', dt);
        } else want = 'idle';
        break;
      }
      case 'CRAFT': {
        const type = choice.craftType ?? this._chooseToolType();
        const tc = CONFIG.tools[type] ?? CONFIG.tools.spear;
        if (this.wood >= tc.wood && this._buildCooldown <= 0) {
          this._workTimer = (this._workTimer ?? 0) + dt;
          want = 'interact';
          if (this._workTimer > 1.5) {
            this.wood -= tc.wood;
            this._equipTool(type);
            this._workTimer = 0;
            this._buildCooldown = 5;
            this.memory.remember('crafted', tick, this.pos, 0.7);
          }
        } else want = 'idle';
        break;
      }
      case 'SHOOT': {
        // Loose an arrow / hurl a spear. aim is a world XZ direction
        // (camera-forward for the player; toward the target for the AI).
        const tgt = choice.target;
        let aim = choice.aim;
        if (!aim && tgt) aim = { x: tgt.x - this.pos.x, z: tgt.z - this.pos.z };
        if (aim) this.heading = Math.atan2(aim.x, aim.z);
        if (this._shootCd <= 0 && aim && this._shoot(aim, this, choice.power ?? 0.7)) {
          this.energy -= 2;
          this.memory.remember('hunted', tick, this.pos, 0.2);
          want = 'attack';
        } else want = aim ? 'turn' : 'idle';
        break;
      }
      case 'PLAYER_STRIKE': {
        // A mouse-click melee swing — hits whatever is in a short frontal
        // arc (animal, agent or structure), else just plays the swing.
        const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
        const inArc = (px, pz, reach) => {
          const dx = px - this.pos.x, dz = pz - this.pos.z;
          const L = Math.hypot(dx, dz) || 1;
          return L < reach && (dx / L) * fx + (dz / L) * fz > 0.3;
        };
        let hit = false;
        for (const a of this.world.animals) {
          if (a.alive && inArc(a.pos.x, a.pos.z, CONFIG.entity.attackRadius + 1.2)) {
            if (!a.damage(this._meleeDamage()) && a.gore && !this.tool) this.energy -= a.gore;
            hit = true; break;
          }
        }
        if (!hit) for (const { entity: e, dist } of p.entities) {
          if (e.tribeId !== this.tribeId && !this.kin.has(e.id) &&
              dist < CONFIG.entity.attackRadius + 1.2 && inArc(e.pos.x, e.pos.z, 99)) {
            e.damage(this._meleeDamage(), this);
            this.social.conflict(e.id);
            hit = true; break;
          }
        }
        if (!hit) for (const st of this.world.structures) {
          if (st.tribe != null && st.tribe !== this.tribeId &&
              inArc(st.pos.x, st.pos.z, CONFIG.entity.attackRadius + st.radius + 1)) {
            this.world.damageStructure(st, this._meleeDamage());
            hit = true; break;
          }
        }
        if (hit) { this._useTool(); this.energy -= 1.5; }
        want = 'attack';
        break;
      }
      case 'HUNT': {
        const a = choice.animal;
        if (a && a.alive) {
          const d = this.pos.distanceTo(a.pos);
          if (d < CONFIG.entity.huntRadius) {
            const sp = this._toolSpec();
            const dmg = sp
              ? sp.melee + CONFIG.entity.attackDamage * 0.4 + (this.tribeEra - 1) * CONFIG.era.weaponBonusPerEra
              : CONFIG.hunt.unarmedDamage;
            const killed = a.hurt(dmg);
            this._useTool();
            // A boar gores a hunter who closes bare-handed.
            if (!killed && a.gore && !this.tool) this.energy -= a.gore;
            this.energy -= 2;
            want = 'attack';
            if (killed) {
              this.world.dropCarcass(a.pos, a.food);
              this.memory.remember('hunted', tick, a.pos, 1);
              // A successful kill is shared with kin/tribe nearby — the
              // cooperative payoff that makes hunting parties worthwhile.
              for (const { entity: e, dist } of p.entities) {
                if (dist < CONFIG.hunt.shareRadius &&
                    (this.kin.has(e.id) || e.tribeId === this.tribeId)) {
                  e.energy = clamp(e.energy + 14, 0, CONFIG.entity.maxEnergy);
                  this.social.cooperate(e.id);
                  e.social.cooperate(this.id);
                }
              }
            } else {
              this.memory.remember('hunted', tick, a.pos, this.weapon ? 0.3 : -0.2);
            }
          } else want = this._moveToward(a.pos, 'run', dt);
        } else want = 'idle';
        break;
      }
      case 'FARM':
        if (this._buildCooldown <= 0) {
          this._workTimer = (this._workTimer ?? 0) + dt;
          want = 'build';
          if (this._workTimer > 1.3) {
            const ang = this.rng.range(-Math.PI, Math.PI);
            const r = 6 + this.rng.range(0, 6);
            const base = this.home ? this.home.pos : this.pos;
            this.world.plantCrop(base.x + Math.sin(ang) * r, base.z + Math.cos(ang) * r,
              this.id, this.tribeId);
            this.energy -= CONFIG.nature.cropPlantCost;
            this._workTimer = 0;
            this._buildCooldown = 6;
            this.memory.remember('farmed', tick, this.pos, 0.6);
          }
        } else want = 'idle';
        break;
      case 'PLAYER_MOVE': {
        // Direct human steering. dir is a world-space XZ vector.
        const dx = choice.dir?.x ?? 0;
        const dz = choice.dir?.z ?? 0;
        if (dx * dx + dz * dz > 1e-4) {
          this.heading = Math.atan2(dx, dz);
          const sp = choice.run ? CONFIG.entity.runSpeed : CONFIG.entity.walkSpeed;
          this.vel.x = Math.sin(this.heading) * sp;
          this.vel.z = Math.cos(this.heading) * sp;
          want = choice.run ? 'run' : 'walk';
        } else want = 'idle';
        break;
      }
      default:
        want = 'idle';
    }

    // Map locomotion + transitions to an animation state.
    const speed = this.vel.length();
    if (want === 'walk' || want === 'run') {
      this.animState = speed > CONFIG.entity.walkSpeed * 1.1 ? 'run' : 'walk';
    } else if (this._turning) {
      this.animState = 'turn';
    } else {
      this.animState = want;
    }
  }

  _urgent(choice) {
    return choice.action === 'FLEE' || choice.action === 'ATTACK' ||
      (choice.action === 'SEEK_RESOURCE' && this.energy < CONFIG.entity.maxEnergy * 0.3);
  }

  _moveToward(target, gait, dt) {
    const to = new THREE.Vector3(target.x - this.pos.x, 0, target.z - this.pos.z);
    const dist = to.length();
    if (dist < 0.4) return 'idle';
    to.normalize();
    const desired = Math.atan2(to.x, to.z);
    let diff = desired - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this._turning = Math.abs(diff) > 0.9;
    this.heading += clamp(diff, -1, 1) * Math.min(1, CONFIG.entity.turnRate * dt);
    const speed = gait === 'run' ? CONFIG.entity.runSpeed : CONFIG.entity.walkSpeed;
    // Only commit to full speed once roughly facing the target.
    const align = Math.max(0, Math.cos(diff));
    this.vel.x = Math.sin(this.heading) * speed * align;
    this.vel.z = Math.cos(this.heading) * speed * align;
    return gait;
  }

  _homeOutwardDir() {
    if (!this.home) return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
    const dx = this.pos.x - this.home.pos.x;
    const dz = this.pos.z - this.home.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  // Pick which tool to make: bows once the tribe reaches Era 2 and the
  // agent is hunt-minded; axes for dedicated woodcutters; spears as the
  // reliable default; clubs only as a cheap fallback when wood is short.
  _chooseToolType() {
    const era = this.tribeEra ?? 1;
    const W = this.learn.weights;
    if (this.wood < CONFIG.tools.spear.wood) return 'club';
    // Bows are a costly specialisation, not the default — only dedicated
    // hunters in an advanced tribe save the extra wood for one. The cheap,
    // effective spear stays the workhorse so hunting throughput holds up.
    if (era >= 2 && this.wood >= CONFIG.tools.bow.wood &&
        W.HUNT > 1.35 && this.traits.aggression > 0.55) return 'bow';
    if (W.GATHER_WOOD > 1.2 && this.wood >= CONFIG.tools.axe.wood) return 'axe';
    return 'spear';
  }

  _equipTool(type) {
    const spec = CONFIG.tools[type];
    this.tool = { type, dur: spec.dur };
    if (this._toolMesh) { this.mesh.userData.rig.armR.remove(this._toolMesh); }
    this._toolMesh = makeTool(type);
    this._toolMesh.position.set(0, -0.7, 0.12);
    this.mesh.userData.rig.armR.add(this._toolMesh);
  }

  _useTool() {
    if (!this.tool) return;
    if (--this.tool.dur <= 0) {            // tools wear out and must be remade
      this.tool = null;
      if (this._toolMesh) { this.mesh.userData.rig.armR.remove(this._toolMesh); this._toolMesh = null; }
    }
  }

  _meleeDamage() {
    const era = (this.tribeEra - 1) * CONFIG.era.weaponBonusPerEra;
    const sp = this._toolSpec();
    return CONFIG.entity.attackDamage + (sp ? sp.melee + era : 0);
  }

  // Fire a ranged tool (bow) or hurl a spear toward a point/direction.
  // power 0..1 (player charge); a fuller draw flies faster and hits harder.
  _shoot(aimDir, owner, power = 0.7) {
    const sp = this._toolSpec();
    const r = sp?.ranged || sp?.throw;
    if (!r) return false;
    const k = 0.6 + 0.6 * power;
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + 1.7, this.pos.z);
    this.world.spawnProjectile(origin, aimDir,
      (r.dmg + (this.tribeEra - 1) * CONFIG.era.weaponBonusPerEra) * k, this,
      this.tool.type === 'bow' ? 'arrow' : 'spear', r.speed * k);
    this._useTool();
    this._shootCd = 14;
    return true;
  }

  _rangedReach() {
    const sp = this._toolSpec();
    const r = sp?.ranged || sp?.throw;
    return r ? r.range : 0;
  }

  _physics(dt) {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const lim = this.world.size * 0.97;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
    // Solid walls block movement — fortifications actually channel paths.
    const fixed = this.world.resolveCollision(this.pos.x, this.pos.z, CONFIG.entity.radius);
    this.pos.x = fixed.x;
    this.pos.z = fixed.z;
    const gy = this.world.heightAt(this.pos.x, this.pos.z);
    this.pos.y = gy;
    this.mesh.userData.groundY = gy;
    this.mesh.position.set(this.pos.x, gy, this.pos.z);
    this.mesh.rotation.y = this.heading;
    this.vel.multiplyScalar(0.6); // damping; movement is re-driven each tick
  }

  _energy(dt) {
    let drain = CONFIG.entity.energyDrainPerSecond;
    if (this.animState === 'run') drain *= CONFIG.entity.runEnergyMultiplier;
    else if (this.animState === 'idle') drain *= 0.45;
    this.energy = clamp(this.energy - drain * dt, 0, CONFIG.entity.maxEnergy);
  }

  _learn(choice, prevAction, tick) {
    const dE = this.energy - this._prevEnergy;
    this._prevEnergy = this.energy;
    const a = choice.action;
    const W = this.learn.weights;
    const { reinforce, punish, traitDrift, weightMin, weightMax } = CONFIG.learning;

    const homeSafe = (a === 'RETURN_HOME' || a === 'FORTIFY' || a === 'DEFEND') && this._dangerBefore > 0;
    // Tech pays off later (a kill becomes a carcass eaten next), so reward
    // the steps that lead there, not just immediate energy.
    const huntWin = a === 'HUNT' && this.memory.valenceOf('hunted') > 0;
    let good = dE > 0.3 || a === 'EAT' || (a === 'FLEE' && this._dangerBefore > 0) || homeSafe ||
      (a === 'BUILD' && this._dangerBefore === 0) || a === 'CRAFT' || huntWin ||
      (a === 'GATHER_WOOD' && this.wood > 0) || a === 'FARM' || a === 'STOCKPILE' ||
      (a === 'DEFEND' && this._dangerBefore > 0);
    let bad = (!['IDLE', 'RETURN_HOME', 'CRAFT', 'FARM', 'STOCKPILE', 'BUILD', 'FORTIFY'].includes(a) &&
      dE < -1.2) || (a === 'ATTACK' && this.energy < 25) ||
      (a === 'HUNT' && !this.weapon && this.memory.valenceOf('hunted') < 0);

    if (good) {
      W[a] = clamp(W[a] + reinforce, weightMin, weightMax);
      const newSkill = this.skills.reinforce(this.world.skillNames);
      if (newSkill) this.world.onInvent?.(this, newSkill);
      // Nudge the trait most associated with what worked.
      if (a === 'ATTACK') driftTrait(this.traits, 'aggression', +1, traitDrift);
      if (a === 'APPROACH' || a === 'GROUP') driftTrait(this.traits, 'sociability', +1, traitDrift);
      if (a === 'EXPLORE') driftTrait(this.traits, 'curiosity', +1, traitDrift);
      if (a === 'FLEE' || a === 'RETURN_HOME') driftTrait(this.traits, 'caution', +1, traitDrift);
      if (a === 'FORTIFY' || a === 'DEFEND') driftTrait(this.traits, 'loyalty', +1, traitDrift);
      if (a === 'HUNT' || a === 'CRAFT') {
        driftTrait(this.traits, 'aggression', +1, traitDrift * 0.6);
        driftTrait(this.traits, 'curiosity', +1, traitDrift);
      }
      if (a === 'FARM') driftTrait(this.traits, 'caution', +1, traitDrift);
    } else if (bad) {
      W[a] = clamp(W[a] - punish, weightMin, weightMax);
      if (a === 'ATTACK') driftTrait(this.traits, 'aggression', -1, traitDrift);
      if (a === 'EXPLORE') driftTrait(this.traits, 'riskTolerance', -1, traitDrift);
      if (a === 'HUNT') driftTrait(this.traits, 'caution', +1, traitDrift);
    }
  }

  // Proximity/imitation learning of others' inventions.
  _cultural(p, tick) {
    if (!this.rng.chance(CONFIG.skills.diffusionChance)) return;
    for (const { entity: e } of p.entities) {
      if (this.social.get(e.id).trust > 0.3 && e.skills) {
        const learned = this.skills.learnFrom(e.skills);
        if (learned) { this.memory.remember('learned_skill', tick, null, 0.4); break; }
      }
    }
  }

  damage(amount, from) {
    this.energy -= amount;
    if (from) {
      this._killer = from;
      this._killerTick = this.world.tickNow ?? 0;
      this.social.conflict(from.id);
      this.memory.remember('threat', this.world.tickNow ?? 0, from.pos, -1);
    }
  }

  die() {
    this.alive = false;
    this.world.scene.remove(this.mesh);
    this.mesh.traverse((o) => o.geometry?.dispose());
  }

  render(dt) {
    if (!this.alive) return;
    animateHumanoid(this.mesh, this.animState, dt, clamp(this.vel.length() / CONFIG.entity.runSpeed, 0, 1));
  }
}
