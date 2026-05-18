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

    this.action = 'IDLE';
    this.animState = 'idle';
    this.signal = null;
    this._prevEnergy = this.energy;
    this._buildCooldown = 0;
  }

  // One fixed simulation step (dt seconds).
  tick(entities, tick, dt) {
    if (!this.alive) return;
    this.age += dt;
    this._buildCooldown = Math.max(0, this._buildCooldown - dt);

    const p = perceive(this, entities, this.world, tick);
    this._observe(p, tick);

    const choice = decide(this, p, tick, this.rng);
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

    this.fitness = this.age * 0.5 + this.energy * 0.2 + this.skills.skills.size * 4 + this.social.rel.size * 0.4;
    if (this.energy <= 0) this.die();
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
          this.energy = clamp(this.energy + this.world.consumeResource(r.res, tick), 0, CONFIG.entity.maxEnergy);
          this.memory.remember('ate', tick, r.res.pos, 1);
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
            v.damage(CONFIG.entity.attackDamage, this);
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
      case 'BUILD':
        if (!choice.gated && this.energy >= CONFIG.entity.buildMinEnergy && this._buildCooldown <= 0) {
          this._buildTimer = (this._buildTimer ?? 0) + dt;
          want = 'build';
          if (this._buildTimer > 1.4) {
            this.world.addStructure(this.pos, this.color);
            this.energy -= CONFIG.entity.buildEnergyCost;
            this._buildTimer = 0;
            this._buildCooldown = 12;
            const safeNow = this._dangerBefore === 0;
            this.memory.remember('built_safe', tick, this.pos, safeNow ? 0.8 : 0.3);
          }
        } else want = 'idle';
        break;
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

  _physics(dt) {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const lim = this.world.size * 0.97;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
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

    let good = dE > 0.3 || a === 'EAT' || (a === 'FLEE' && this._dangerBefore > 0);
    let bad = (a !== 'IDLE' && dE < -1.2) || (a === 'ATTACK' && this.energy < 25);

    if (good) {
      W[a] = clamp(W[a] + reinforce, weightMin, weightMax);
      const newSkill = this.skills.reinforce(this.world.skillNames);
      if (newSkill) this.world.onInvent?.(this, newSkill);
      // Nudge the trait most associated with what worked.
      if (a === 'ATTACK') driftTrait(this.traits, 'aggression', +1, traitDrift);
      if (a === 'APPROACH' || a === 'GROUP') driftTrait(this.traits, 'sociability', +1, traitDrift);
      if (a === 'EXPLORE') driftTrait(this.traits, 'curiosity', +1, traitDrift);
      if (a === 'FLEE') driftTrait(this.traits, 'caution', +1, traitDrift);
    } else if (bad) {
      W[a] = clamp(W[a] - punish, weightMin, weightMax);
      if (a === 'ATTACK') driftTrait(this.traits, 'aggression', -1, traitDrift);
      if (a === 'EXPLORE') driftTrait(this.traits, 'riskTolerance', -1, traitDrift);
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
