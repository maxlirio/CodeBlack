import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeTree, makeBush, makeCrop, setCropGrowth, Animal } from './nature.js';

// Persistent physical world: procedurally generated terrain, living
// nature (forests, berry bushes, farmable crops, roaming animal herds)
// and agent-built structures that endure and reshape the world.
export class World {
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.size = CONFIG.world.size;
    this.foods = [];        // bushes, ripe crops, carcasses — anything edible
    this.trees = [];        // wood sources
    this.crops = [];        // growing (not yet edible) plots
    this.animals = [];
    this.structures = [];
    this.projectiles = [];    // flying arrows / thrown spears
    this.feuds = new Map();   // "tribeA|tribeB" -> hatred magnitude
    this.bonds = new Map();   // "tribeA|tribeB" -> trade goodwill
    this.truces = new Map();  // "tribeA|tribeB" -> tick the truce expires
    // Back-compat alias: older code referred to edible nodes as "resources".
    this.resources = this.foods;

    // Two octaves of value-ish noise baked from the seeded RNG, so the
    // terrain is reproducible and height is cheap to sample analytically.
    this.n1 = { fx: rng.range(0.02, 0.05), fz: rng.range(0.02, 0.05), px: rng() * 9, pz: rng() * 9 };
    this.n2 = { fx: rng.range(0.08, 0.13), fz: rng.range(0.08, 0.13), px: rng() * 9, pz: rng() * 9 };

    this._buildLighting();
    this._buildTerrain();
    this._seedNature();
  }

  heightAt(x, z) {
    const a = CONFIG.world.terrainAmplitude;
    const h1 = Math.sin(x * this.n1.fx + this.n1.px) * Math.cos(z * this.n1.fz + this.n1.pz);
    const h2 = Math.sin(x * this.n2.fx + this.n2.px) * Math.cos(z * this.n2.fz + this.n2.pz);
    return h1 * a + h2 * a * 0.35;
  }

  _buildLighting() {
    this.scene.add(new THREE.HemisphereLight(0xbcd9ff, 0x6b6450, 0.95));
    const sun = new THREE.DirectionalLight(0xffe7c4, 1.05);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = this.size * 1.1;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 320 });
    this.scene.add(sun);
    // Daytime sky: a bright horizon haze instead of the old black void.
    this.scene.fog = new THREE.FogExp2(0x9fc4e6, 0.0042);
  }

  _buildTerrain() {
    const s = this.size * 2;
    const seg = CONFIG.world.terrainSegments;
    const geo = new THREE.PlaneGeometry(s, s, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    const lo = new THREE.Color(0x3b6b3a);
    const hi = new THREE.Color(0x8d9a72);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.heightAt(x, z);
      pos.setY(i, y);
      const t = THREE.MathUtils.clamp((y + CONFIG.world.terrainAmplitude) / (CONFIG.world.terrainAmplitude * 2), 0, 1);
      const c = lo.clone().lerp(hi, t);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  _seedNature() {
    const C = CONFIG.nature;
    const r = this.size * 0.92;
    for (let i = 0; i < C.bushCount; i++) {
      this._addBush(this.rng.range(-r, r), this.rng.range(-r, r));
    }
    for (let f = 0; f < C.forests; f++) {
      const cx = this.rng.range(-r, r);
      const cz = this.rng.range(-r, r);
      for (let i = 0; i < C.treesPerForest; i++) {
        this._addTree(cx + this.rng.range(-16, 16), cz + this.rng.range(-16, 16));
      }
    }
    for (let h = 0; h < C.herds; h++) {
      const cx = this.rng.range(-r, r);
      const cz = this.rng.range(-r, r);
      for (let i = 0; i < C.animalsPerHerd; i++) {
        this.animals.push(new Animal(this, this.rng,
          cx + this.rng.range(-8, 8), cz + this.rng.range(-8, 8), h));
      }
    }
    for (let p = 0; p < CONFIG.predator.packs; p++) {
      const cx = this.rng.range(-r, r);
      const cz = this.rng.range(-r, r);
      for (let i = 0; i < CONFIG.predator.perPack; i++) {
        this.animals.push(new Animal(this, this.rng,
          cx + this.rng.range(-6, 6), cz + this.rng.range(-6, 6), 100 + p, 'wolf'));
      }
    }
    for (let i = 0; i < CONFIG.logistics.horses; i++) {
      this.animals.push(new Animal(this, this.rng,
        this.rng.range(-r, r), this.rng.range(-r, r), 200 + i, 'horse'));
    }
    this.roads = [];
    this.roadGroup = new THREE.Group();
    this.scene.add(this.roadGroup);
  }

  // Pave straight roads between a settlement's centre and its granaries,
  // and along live trade routes between bonded clans. Re-derived rarely.
  rebuildRoads() {
    const L = CONFIG.logistics;
    const centres = this.structures.filter((s) => s.type === 'center');
    const stores = this.structures.filter((s) => s.type === 'storehouse');
    const links = [];
    for (const c of centres) {
      for (const s of stores) {
        if (s.tribe !== c.tribe) continue;
        if (Math.hypot(s.pos.x - c.pos.x, s.pos.z - c.pos.z) < L.roadMaxLen) links.push([c, s]);
      }
    }
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        const a = centres[i], b = centres[j];
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
        if (d < L.roadMaxLen && (a.tribe === b.tribe || this.bond(a.tribe, b.tribe) > 0.4)) {
          links.push([a, b]);
        }
      }
    }
    this.roadGroup.clear();
    this.roads = links.map(([a, b]) => {
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(L.roadWidth * 2, 0.08, len),
        this._roadMat ??= new THREE.MeshStandardMaterial({ color: 0x6b5b44, roughness: 1 }));
      mesh.position.set((a.pos.x + b.pos.x) / 2,
        this.heightAt((a.pos.x + b.pos.x) / 2, (a.pos.z + b.pos.z) / 2) + 0.05,
        (a.pos.z + b.pos.z) / 2);
      mesh.rotation.y = Math.atan2(dx, dz);
      mesh.receiveShadow = true;
      this.roadGroup.add(mesh);
      return { ax: a.pos.x, az: a.pos.z, bx: b.pos.x, bz: b.pos.z, len2: len * len };
    });
  }

  // Is this point on a paved road? (cheap point-to-segment test)
  onRoad(x, z) {
    const w2 = CONFIG.logistics.roadWidth ** 2;
    for (const r of this.roads || []) {
      const dx = r.bx - r.ax, dz = r.bz - r.az;
      let t = ((x - r.ax) * dx + (z - r.az) * dz) / r.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = r.ax + dx * t, pz = r.az + dz * t;
      if ((x - px) ** 2 + (z - pz) ** 2 < w2) return true;
    }
    return false;
  }

  nearestWildHorse(x, z) {
    let best = null, bd = Infinity;
    for (const a of this.animals) {
      if (!a.alive || !a.horse || a.tamed) continue;
      const d = (a.pos.x - x) ** 2 + (a.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    return best ? { animal: best, dist: Math.sqrt(bd) } : null;
  }

  _addBush(x, z) {
    const y = this.heightAt(x, z);
    const mesh = makeBush(this.rng);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.foods.push({ kind: 'bush', pos: new THREE.Vector3(x, y + 0.6, z), mesh,
      available: true, regrowAt: 0, energy: CONFIG.nature.bushEnergy });
  }

  _addTree(x, z) {
    const y = this.heightAt(x, z);
    const mesh = makeTree(this.rng);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.trees.push({ pos: new THREE.Vector3(x, y, z), mesh,
      wood: CONFIG.nature.treeWood, regrowAt: 0 });
  }

  // Harvest anything edible (bush / ripe crop / carcass). Bushes regrow;
  // crops and carcasses are consumed for good.
  harvestFood(node, tick) {
    node.available = false;
    if (node.kind === 'bush') {
      node.regrowAt = tick + CONFIG.nature.bushRegrowTicks;
      node.mesh.visible = false;
    } else {
      this.scene.remove(node.mesh);
      const i = this.foods.indexOf(node);
      if (i >= 0) this.foods.splice(i, 1);
    }
    return node.energy;
  }

  nearestFood(x, z) {
    let best = null, bd = Infinity;
    for (const f of this.foods) {
      if (!f.available) continue;
      const d = (f.pos.x - x) ** 2 + (f.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best ? { node: best, dist: Math.sqrt(bd) } : null;
  }

  // Chop a tree for wood; depleted trees lose their crown and regrow later.
  chopWood(tree, tick) {
    if (tree.wood <= 0) return 0;
    tree.wood -= 1;
    if (tree.wood <= 0) {
      tree.regrowAt = tick + CONFIG.nature.treeRegrowTicks;
      for (const f of tree.mesh.userData.foliage) f.visible = false;
    }
    return CONFIG.nature.woodPerChop;
  }

  nearestTree(x, z) {
    let best = null, bd = Infinity;
    for (const t of this.trees) {
      if (t.wood <= 0) continue;
      const d = (t.pos.x - x) ** 2 + (t.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best ? { tree: best, dist: Math.sqrt(bd) } : null;
  }

  plantCrop(x, z, owner, tribe) {
    const y = this.heightAt(x, z);
    const mesh = makeCrop();
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.crops.push({ pos: new THREE.Vector3(x, y, z), mesh, planted: this.tickNow ?? 0,
      owner, tribe, energy: CONFIG.nature.cropEnergy });
  }

  // A felled animal becomes a short-lived carcass food node (bigger
  // species feed more — a boar is a real feast).
  dropCarcass(pos, energy = CONFIG.nature.animalEnergy) {
    const y = this.heightAt(pos.x, pos.z);
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 0.5, 5),
      this._carcassMat ??= new THREE.MeshStandardMaterial({ color: 0x7a4b3a, roughness: 0.9, flatShading: true })
    );
    mesh.rotation.x = Math.PI;
    mesh.position.set(pos.x, y + 0.3, pos.z);
    this.scene.add(mesh);
    this.foods.push({ kind: 'carcass', pos: new THREE.Vector3(pos.x, y + 0.3, pos.z), mesh,
      available: true, expireAt: (this.tickNow ?? 0) + CONFIG.nature.carcassExpireTicks,
      energy });
  }

  // type: 'house' (a home anchor) or 'wall' (a solid fortification).
  // tribeColor tints the roof/banner so settlements read like AoE players.
  addStructure(pos, tribeColor, type = 'house', builder = null) {
    const y = this.heightAt(pos.x, pos.z);
    const mesh = new THREE.Group();
    mesh.position.set(pos.x, y, pos.z);
    let radius;

    if (type === 'wall') {
      const len = 4.2;
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(len, 2.6, 1.0),
        new THREE.MeshStandardMaterial({ color: 0x7d7264, roughness: 0.95 })
      );
      wall.position.y = 1.3;
      wall.castShadow = true;
      wall.receiveShadow = true;
      // Face the wall tangent to the ring around home so segments line up.
      mesh.rotation.y = pos.facing ?? 0;
      const merlon = new THREE.Mesh(
        new THREE.BoxGeometry(len, 0.5, 1.0),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.8 })
      );
      merlon.position.y = 2.85;
      mesh.add(wall, merlon);
      radius = 2.1;
    } else if (type === 'gate') {
      // A gateway: two towers flanking an arch — the deliberate opening
      // in the ring. Passable (not solid) so it reads as a city gate.
      mesh.rotation.y = pos.facing ?? 0;
      const post = (sx) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.4, 1.3),
          new THREE.MeshStandardMaterial({ color: 0x6f6457, roughness: 0.95 }));
        m.position.set(sx, 1.7, 0); m.castShadow = true; return m;
      };
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.7, 1.3),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.8 }));
      lintel.position.y = 3.2;
      mesh.add(post(-1.6), post(1.6), lintel);
      radius = 2.1;
    } else if (type === 'storehouse') {
      // A squat hut with a conical thatch + a stacked-crate "stockpile".
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.9, 1.8, 7),
        new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.9 }));
      body.position.y = 0.9; body.castShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.5, 7),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.7 }));
      roof.position.y = 2.4;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshStandardMaterial({ color: 0xb98a4a, roughness: 0.85 }));
      crate.position.set(1.6, 0.45, 0);
      mesh.add(body, roof, crate);
      radius = 1.9;
    } else if (type === 'tower') {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.3, 5.2, 6),
        new THREE.MeshStandardMaterial({ color: 0x8d8576, roughness: 0.95 }));
      shaft.position.y = 2.6; shaft.castShadow = true;
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.0, 0.8, 6),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.8 }));
      crown.position.y = 5.4;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.4, 6),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.7 }));
      roof.position.y = 6.4;
      mesh.add(shaft, crown, roof);
      radius = 1.5;
    } else if (type === 'center') {
      // Town centre: a broad platform with a tall banner totem — the heart
      // of a settlement, rally point and culture hub.
      const base = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.3, 0.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x7a6240, roughness: 0.95 }));
      base.position.y = 0.4; base.receiveShadow = true;
      const hut = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.0, 2.6),
        new THREE.MeshStandardMaterial({ color: 0x6b5034, roughness: 0.9 }));
      hut.position.y = 1.8; hut.castShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.8, 4),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.7 }));
      roof.position.y = 3.7; roof.rotation.y = Math.PI / 4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 4),
        new THREE.MeshStandardMaterial({ color: 0x3a2f22 }));
      pole.position.set(0, 5.5, 0);
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.0, 3),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.6 }));
      flag.position.set(0.5, 6.6, 0); flag.rotation.z = -Math.PI / 2;
      mesh.add(base, hut, roof, pole, flag);
      radius = 2.6;
    } else if (type === 'ram') {
      // A timber battering ram on a low frame — a mobile siege engine.
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 3.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.9 }));
      beam.rotation.z = Math.PI / 2; beam.position.y = 1.3; beam.castShadow = true;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.7, 5),
        new THREE.MeshStandardMaterial({ color: 0x8d8576, roughness: 0.6 }));
      cap.rotation.z = -Math.PI / 2; cap.position.set(1.9, 1.3, 0);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.25, 1.6),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.8 }));
      roof.position.y = 2.1;
      for (const sx of [-1.3, 1.3]) for (const sz of [-0.6, 0.6]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.2, 6),
          new THREE.MeshStandardMaterial({ color: 0x3a2f22 }));
        wheel.rotation.x = Math.PI / 2; wheel.position.set(sx, 0.5, sz);
        mesh.add(wheel);
      }
      mesh.add(beam, cap, roof);
      mesh.rotation.y = pos.facing ?? 0;
      radius = 1.8;
    } else {
      const hgt = 2 + this.rng.range(0, 1.2);
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, hgt, 2.4),
        new THREE.MeshStandardMaterial({ color: 0x6b5034, roughness: 0.9 })
      );
      body.position.y = hgt / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(2.0, 1.5, 4),
        new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.7 })
      );
      roof.position.y = hgt + 0.75;
      roof.rotation.y = Math.PI / 4;
      mesh.add(body, roof);
      radius = 1.7;
    }

    this.scene.add(mesh);
    const spec = CONFIG.structures.types[type] ?? CONFIG.structures.types.house;
    const eraMul = 1 + (((builder?.tribeEra ?? 1) - 1) * CONFIG.era.wallHpPerEra);
    const maxHp = Math.round(spec.hp * eraMul);
    const s = {
      pos: new THREE.Vector3(pos.x, y, pos.z),
      mesh, radius, type,
      solid: !!spec.solid,
      hp: maxHp, maxHp,
      owner: builder ? builder.id : null,
      tribe: builder ? builder.tribeId : null,
      _fam: builder ? builder.familyId : null,
      store: type === 'storehouse' ? { food: 0, wood: 0 } : null
    };
    this.structures.push(s);
    return s;
  }

  damageStructure(st, dmg, by = null) {
    st.hp -= dmg;
    st._lastHit = this.tickNow ?? 0;
    if (by) st._lastBy = by;
    // Visibly list as it crumbles.
    st.mesh.rotation.z = (1 - st.hp / st.maxHp) * 0.18;
    if (st.hp <= 0) {
      const razed = st;
      this.removeStructure(st);
      if (razed.type === 'center') this.captureCity(razed, by ?? razed._lastBy);
      return true;
    }
    return false;
  }

  // Razing a town centre breaks the defending clan: nearby leaderless
  // survivors may defect to the conquerors, who reap spoils and progress.
  captureCity(center, conqueror) {
    if (!conqueror || !conqueror.alive) return;
    const losingTribe = center.tribe;
    const ents = this.entities || [];
    let converted = 0;
    for (const e of ents) {
      if (!e.alive) continue;
      if (e.tribeId === conqueror.tribeId) {
        e.energy = Math.min(CONFIG.entity.maxEnergy, e.energy + CONFIG.war.captureEnergyReward);
        e.memory?.remember('conquered', this.tickNow ?? 0, center.pos, 1);
      } else if (e.tribeId === losingTribe &&
                 e.pos.distanceTo(center.pos) < CONFIG.tribe.homeMergeDist * 1.5) {
        if (this.rng.chance(CONFIG.war.convertChance)) {
          e.familyId = conqueror.familyId;            // defect to the victors
          e.tribeId = conqueror.tribeId;              // ...effective at once
          e.home = null;
          const r = e.social.get(conqueror.id);
          r.trust = 0.6; r.hostility = 0;
          e.memory?.remember('defected', this.tickNow ?? 0, center.pos, 0.3);
          converted++;
        }
      }
    }
    // The captured town changes hands — its buildings now fly the
    // conqueror's colours (and become enterable by the new owners).
    for (const st of this.structures) {
      if (st.tribe === losingTribe &&
          st.pos.distanceTo(center.pos) < CONFIG.tribe.homeMergeDist * 1.8) {
        st.tribe = conqueror.tribeId;
        st._fam = conqueror.familyId;
      }
    }
    // Calm the feud — the war is decided.
    this.feuds.delete(this._feudKey(losingTribe, conqueror.tribeId));
    this.lastCapture = { tick: this.tickNow ?? 0, by: conqueror.tribeId, converted };
  }

  removeStructure(st) {
    this.scene.remove(st.mesh);
    st.mesh.traverse((o) => o.geometry?.dispose?.());
    const i = this.structures.indexOf(st);
    if (i >= 0) this.structures.splice(i, 1);
  }

  nearestStructure(x, z, type, predicate = null) {
    let best = null, bd = Infinity;
    for (const st of this.structures) {
      if (st.type !== type) continue;
      if (predicate && !predicate(st)) continue;
      const d = (st.pos.x - x) ** 2 + (st.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = st; }
    }
    return best ? { st: best, dist: Math.sqrt(bd) } : null;
  }

  countStructures(x, z, type, radius, predicate = null) {
    let n = 0;
    for (const st of this.structures) {
      if (st.type !== type) continue;
      if (predicate && !predicate(st)) continue;
      if ((st.pos.x - x) ** 2 + (st.pos.z - z) ** 2 < radius * radius) n++;
    }
    return n;
  }

  nearestHome(x, z, predicate = null) {
    let best = null;
    let bd = Infinity;
    for (const st of this.structures) {
      if (st.type !== 'house') continue;
      if (predicate && !predicate(st)) continue;
      const d = (st.pos.x - x) ** 2 + (st.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = st; }
    }
    return best ? { st: best, dist: Math.sqrt(bd) } : null;
  }

  // A peaceful caravan opportunity: this agent's own village granary has
  // a surplus and there's a non-hostile other clan's granary in reach.
  tradePartner(self) {
    let home = null, hd = Infinity;
    for (const st of this.structures) {
      if (st.type !== 'storehouse' || st.tribe !== self.tribeId) continue;
      const d = (st.pos.x - self.pos.x) ** 2 + (st.pos.z - self.pos.z) ** 2;
      if (d < hd) { hd = d; home = st; }   // our village needs a trade hub
    }
    if (!home) return null;
    let partner = null, pd = CONFIG.trade.range ** 2;
    for (const st of this.structures) {
      if (st.type !== 'storehouse' || st.tribe == null || st.tribe === self.tribeId) continue;
      if (this.feud(self.tribeId, st.tribe) >= CONFIG.feud.warThreshold) continue;
      const d = (st.pos.x - self.pos.x) ** 2 + (st.pos.z - self.pos.z) ** 2;
      if (d < pd) { pd = d; partner = st; }
    }
    return partner ? { home, partner } : null;
  }

  countHousesNear(x, z, radius) {
    let n = 0;
    for (const st of this.structures) {
      if (st.type === 'house' && (st.pos.x - x) ** 2 + (st.pos.z - z) ** 2 < radius * radius) n++;
    }
    return n;
  }

  // Push a moving point out of solid walls (simple circle vs. AABB-ish).
  resolveCollision(x, z, r) {
    for (const st of this.structures) {
      if (!st.solid) continue;
      const dx = x - st.pos.x;
      const dz = z - st.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = st.radius + r;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        x += dx * push;
        z += dz * push;
      }
    }
    return { x, z };
  }

  // Structures block line of sight — used by perception.
  blocksSight(ax, az, bx, bz) {
    for (const st of this.structures) {
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1e-6;
      let t = ((st.pos.x - ax) * dx + (st.pos.z - az) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d2 = (px - st.pos.x) ** 2 + (pz - st.pos.z) ** 2;
      if (d2 < st.radius * st.radius) return true;
    }
    return false;
  }

  // Launch an arrow / thrown spear. dir is a unit-ish heading; a little
  // upward arc is added so flight looks (and aims) like a real shot.
  spawnProjectile(origin, dir, dmg, owner, kind = 'arrow', speed = 40) {
    const v = new THREE.Vector3(dir.x, 0, dir.z);
    if (v.lengthSq() < 1e-5) return;
    v.normalize().multiplyScalar(speed);
    v.y = speed * 0.16; // launch arc
    const long = kind === 'spear';
    const mesh = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(long ? 0.05 : 0.03, long ? 0.05 : 0.03, long ? 1.4 : 0.9, 4),
      this._projMat ??= new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.8 }));
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(long ? 0.1 : 0.07, 0.28, 4),
      this._tipMat ??= new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.5 }));
    tip.rotation.x = Math.PI / 2;
    tip.position.z = long ? 0.8 : 0.55;
    mesh.add(shaft, tip);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.projectiles.push({
      pos: origin.clone(), vel: v, speed, dmg, owner, kind, mesh, target: null,
      life: CONFIG.projectile.maxLifeTicks
    });
  }

  _updateProjectiles(dt, entities) {
    const P = CONFIG.projectile;
    const valid = (pr, t) => t && t.alive &&
      !(t.tribeId != null && pr.owner && (t.tribeId === pr.owner.tribeId ||
        pr.owner.kin?.has(t.id)));
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      // Re-acquire the nearest valid quarry (beast or enemy) and curve
      // toward it — shots seek their mark so aiming isn't required.
      if (!valid(pr, pr.target)) {
        pr.target = null;
        let bd = P.homingRange * P.homingRange;
        for (const a of this.animals) {
          if (!a.alive) continue;
          const d = (a.pos.x - pr.pos.x) ** 2 + (a.pos.z - pr.pos.z) ** 2;
          if (d < bd) { bd = d; pr.target = a; }
        }
        for (const e of entities) {
          if (!valid(pr, e)) continue;
          const d = (e.pos.x - pr.pos.x) ** 2 + (e.pos.z - pr.pos.z) ** 2;
          if (d < bd) { bd = d; pr.target = e; }
        }
      }
      if (pr.target) {
        const aim = new THREE.Vector3(
          pr.target.pos.x - pr.pos.x,
          pr.target.pos.y + 1 - pr.pos.y,
          pr.target.pos.z - pr.pos.z).normalize().multiplyScalar(pr.speed);
        pr.vel.lerp(aim, Math.min(1, P.homingRate * dt));
        pr.vel.setLength(pr.speed);
      } else {
        pr.vel.y -= P.gravity * dt; // free flight until a target appears
      }
      pr.pos.addScaledVector(pr.vel, dt);
      pr.mesh.position.copy(pr.pos);
      pr.mesh.lookAt(pr.pos.clone().add(pr.vel));
      let done = --pr.life <= 0 || pr.pos.y <= this.heightAt(pr.pos.x, pr.pos.z);

      if (!done) {
        for (const a of this.animals) {
          if (!a.alive) continue;
          if (pr.pos.distanceTo(a.pos) < P.hitRadius + 0.4) {
            a.damage(pr.dmg); done = true; break;
          }
        }
      }
      if (!done) {
        for (const e of entities) {
          if (!e.alive || e === pr.owner) continue;
          if (pr.owner && (e.tribeId === pr.owner.tribeId || pr.owner.kin?.has(e.id))) continue;
          if (pr.pos.distanceTo(e.pos) < P.hitRadius) {
            e.damage(pr.dmg, pr.owner); done = true; break;
          }
        }
      }
      if (done) { this.scene.remove(pr.mesh); this.projectiles.splice(i, 1); }
    }
  }

  _feudKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  feud(a, b) {
    if (a == null || b == null || a === b) return 0;
    const k = this._feudKey(a, b);
    if ((this.truces.get(k) ?? 0) > (this.tickNow ?? 0)) return 0; // truce holds
    return this.feuds.get(k) ?? 0;
  }

  // Trade goodwill between two clans (cancels rivalry, deters war).
  bond(a, b) {
    if (a == null || b == null || a === b) return 0;
    return this.bonds.get(this._feudKey(a, b)) ?? 0;
  }

  addBond(a, b, amt) {
    if (a == null || b == null || a === b) return;
    const k = this._feudKey(a, b);
    this.bonds.set(k, Math.min(CONFIG.trade.bondMax, (this.bonds.get(k) ?? 0) + amt));
  }

  // The nearest structure of a clan this agent is at war with — the
  // objective a war band marches on even when it's out of sight.
  warTarget(self, minFeud) {
    let best = null, bd = Infinity, centre = null, cd = Infinity;
    for (const st of this.structures) {
      if (st.tribe == null || st.tribe === self.tribeId || st.type === 'ram') continue;
      if (this.feud(self.tribeId, st.tribe) < minFeud) continue;
      const d = (st.pos.x - self.pos.x) ** 2 + (st.pos.z - self.pos.z) ** 2;
      if (d < bd) { bd = d; best = st; }
      if (st.type === 'center' && d < cd) { cd = d; centre = st; }
    }
    return best ? { st: best, centre, dist: Math.sqrt(bd) } : null;
  }

  // A slain villager enrages their whole clan against the killer's clan,
  // and stokes any nearby kin who witness it — this is how feuds and
  // revenge wars between tribes ignite and escalate.
  registerKill(victim, killer, entities) {
    if (!killer || killer.tribeId === victim.tribeId) return;
    const k = this._feudKey(victim.tribeId, killer.tribeId);
    this.truces.delete(k);                       // fresh blood shatters a truce
    this.bonds.set(k, 0);                         // and any goodwill
    this.feuds.set(k, (this.feuds.get(k) ?? 0) + CONFIG.feud.perKill);
    for (const e of entities) {
      if (!e.alive || e === killer) continue;
      const sameClan = e.tribeId === victim.tribeId || e.familyId === victim.familyId;
      if (sameClan && e.pos.distanceTo(victim.pos) < CONFIG.feud.avengeRadius) {
        const r = e.social.get(killer.id);
        r.hostility = Math.min(1, r.hostility + 0.5);
        e.memory.remember('threat', this.tickNow ?? 0, killer.pos, -1);
        e.memory.remember('avenge', this.tickNow ?? 0, victim.pos, -1);
      }
    }
  }

  update(tick, entities, dt = 1 / CONFIG.sim.tickRate) {
    const C = CONFIG.nature;
    this.tickNow = tick;
    // Grudges cool slowly; weary clans may also sue for a lasting truce.
    for (const [k, v] of this.feuds) {
      const nv = v - CONFIG.feud.decayPerTick;
      if (nv <= 0.01) { this.feuds.delete(k); continue; }
      this.feuds.set(k, nv);
      if (nv < CONFIG.feud.warThreshold && (this.truces.get(k) ?? 0) <= tick &&
          this.rng.chance(CONFIG.trade.truceChancePerTick)) {
        this.truces.set(k, tick + CONFIG.trade.truceTicks);
        this.feuds.set(k, nv * 0.4);
      }
    }
    // Trade goodwill fades without continued exchange.
    for (const [k, v] of this.bonds) {
      const nv = v - CONFIG.trade.bondDecayPerTick;
      if (nv <= 0.01) this.bonds.delete(k); else this.bonds.set(k, nv);
    }

    // Berry bushes regrow on their cooldown.
    for (const f of this.foods) {
      if (f.kind === 'bush' && !f.available && tick >= f.regrowAt) {
        f.available = true;
        f.mesh.visible = true;
      }
    }
    // Carcasses rot away if no one eats them.
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      if (f.kind === 'carcass' && (!f.available || tick >= f.expireAt)) {
        this.scene.remove(f.mesh);
        this.foods.splice(i, 1);
      }
    }
    // Felled forests grow back.
    for (const t of this.trees) {
      if (t.wood <= 0 && tick >= t.regrowAt) {
        t.wood = C.treeWood;
        for (const fol of t.mesh.userData.foliage) fol.visible = true;
      }
    }
    // Structures slowly mend (settlement upkeep) when not under siege.
    for (const st of this.structures) {
      if (st.hp < st.maxHp && tick - (st._lastHit ?? -9999) > 200) {
        st.hp = Math.min(st.maxHp, st.hp + CONFIG.structures.repairPerTick * dt);
        st.mesh.rotation.z = (1 - st.hp / st.maxHp) * 0.18;
      }
    }

    // Crops ripen; a mature crop becomes an edible food node (a harvest).
    for (let i = this.crops.length - 1; i >= 0; i--) {
      const c = this.crops[i];
      const g = Math.min(1, (tick - c.planted) / C.cropGrowTicks);
      setCropGrowth(c.mesh, g);
      if (g >= 1) {
        this.crops.splice(i, 1);
        this.foods.push({ kind: 'crop', pos: c.pos.clone().setY(c.pos.y + 0.6), mesh: c.mesh,
          available: true, energy: c.energy, owner: c.owner, tribe: c.tribe });
      }
    }

    // Wildlife. Herbivores flee the nearest agent or wolf; wolves stalk the
    // nearest prey animal, or a lone/weak agent — an ecological pressure
    // that rewards grouping, walls and towers without any scripting.
    const P = CONFIG.predator;
    for (const a of this.animals) {
      if (!a.alive) continue;
      if (a.predator) {
        let q = null, qd = Infinity;
        for (const o of this.animals) {
          if (o === a || !o.alive || o.predator) continue;
          const d = o.pos.distanceTo(a.pos);
          if (d < qd && d < P.senseRadius) { qd = d; q = o; }
        }
        for (const e of entities) {
          if (!e.alive) continue;
          const d = e.pos.distanceTo(a.pos);
          const vulnerable = e.energy < 45 || (e._dangerBefore ?? 0) === 0;
          if (d < qd && d < P.senseRadius && vulnerable) { qd = d; q = e; }
        }
        const inRange = a.predatorUpdate(dt, q ? q.pos : null, qd);
        if (inRange && a._strikeCd === 0 && q) {
          a._strikeCd = P.cooldownTicks;
          if (q.hurt) {
            if (q.hurt(P.damage)) { this.dropCarcass(q.pos, q.food ?? CONFIG.nature.animalEnergy); a.health = Math.min(P.health, a.health + 8); }
          } else if (q.damage) {
            q.damage(P.damage, null);
            q.memory?.remember('threat', tick, a.pos, -1);
          }
        }
      } else if (a.horse && a.tamed) {
        if (a.ownerEntity && a.ownerEntity.alive) a.followUpdate(dt, a.ownerEntity);
        else { a.tamed = false; a.ownerEntity = null; }   // freed if owner dies
      } else {
        let nd = Infinity, np = null;
        for (const e of entities) {
          if (!e.alive) continue;
          const d = e.pos.distanceTo(a.pos);
          if (d < nd) { nd = d; np = e.pos; }
        }
        for (const w of this.animals) {
          if (!w.alive || !w.predator) continue;
          const d = w.pos.distanceTo(a.pos);
          if (d < nd) { nd = d; np = w.pos; }
        }
        a.update(dt, nd, np);
      }
    }
    for (let i = this.animals.length - 1; i >= 0; i--) {
      if (!this.animals[i].alive) { this.animals[i].remove(); this.animals.splice(i, 1); }
    }
    const herbTarget = C.herds * C.animalsPerHerd;
    const herbs = this.animals.filter((a) => !a.predator && !a.horse).length;
    if (herbs < herbTarget && this.rng.chance(0.02)) {
      const r = this.size * 0.9;
      this.animals.push(new Animal(this, this.rng, this.rng.range(-r, r), this.rng.range(-r, r),
        this.rng.int(0, C.herds - 1)));
    }
    const wolves = this.animals.filter((a) => a.predator).length;
    if (wolves < P.packs * P.perPack && this.rng.chance(0.006)) {
      const r = this.size * 0.9;
      this.animals.push(new Animal(this, this.rng, this.rng.range(-r, r), this.rng.range(-r, r),
        100, 'wolf'));
    }
    const wildHorses = this.animals.filter((a) => a.horse && !a.tamed).length;
    if (wildHorses < CONFIG.logistics.horses && this.rng.chance(0.004)) {
      const r = this.size * 0.9;
      this.animals.push(new Animal(this, this.rng, this.rng.range(-r, r), this.rng.range(-r, r),
        299, 'horse'));
    }
    if (tick % CONFIG.logistics.roadRecomputeTicks === 0) this.rebuildRoads();

    // Siege rams grind down the nearest enemy structure they're parked at.
    const W = CONFIG.war;
    for (const ram of this.structures) {
      if (ram.type !== 'ram') continue;
      let tgt = null, td = W.ramReach;
      for (const st of this.structures) {
        if (st === ram || st.type === 'ram') continue;
        if (st.tribe == null || st.tribe === ram.tribe) continue;
        const d = Math.hypot(st.pos.x - ram.pos.x, st.pos.z - ram.pos.z);
        if (d < td) { td = d; tgt = st; }
      }
      if (tgt) this.damageStructure(tgt, W.ramDamagePerTick, { tribeId: ram.tribe, familyId: ram._fam, id: ram.owner, alive: true });
    }

    this._updateProjectiles(dt, entities);
  }

  nearestAnimal(x, z) {
    let best = null, bd = Infinity;
    for (const a of this.animals) {
      if (!a.alive) continue;
      const d = (a.pos.x - x) ** 2 + (a.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    return best ? { animal: best, dist: Math.sqrt(bd) } : null;
  }
}
