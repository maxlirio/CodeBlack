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
    this.scene.add(new THREE.HemisphereLight(0x9fc5ff, 0x2a2236, 0.75));
    const sun = new THREE.DirectionalLight(0xffe7c4, 1.05);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = this.size * 1.1;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 320 });
    this.scene.add(sun);
    this.scene.fog = new THREE.FogExp2(0x05070d, 0.0065);
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

  // A felled animal becomes a short-lived carcass food node.
  dropCarcass(pos) {
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
      energy: CONFIG.nature.animalEnergy });
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
    const s = {
      pos: new THREE.Vector3(pos.x, y, pos.z),
      mesh, radius, type,
      solid: type === 'wall',
      owner: builder ? builder.id : null,
      tribe: builder ? builder.tribeId : null
    };
    this.structures.push(s);
    return s;
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

  update(tick, entities, dt = 1 / CONFIG.sim.tickRate) {
    const C = CONFIG.nature;
    this.tickNow = tick;

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

    // Animals: roam/flee locally, herds repopulate toward their target size.
    for (const a of this.animals) {
      if (!a.alive) continue;
      let nd = Infinity, np = null;
      for (const e of entities) {
        if (!e.alive) continue;
        const d = e.pos.distanceTo(a.pos);
        if (d < nd) { nd = d; np = e.pos; }
      }
      a.update(dt, nd, np);
    }
    for (let i = this.animals.length - 1; i >= 0; i--) {
      if (!this.animals[i].alive) { this.animals[i].remove(); this.animals.splice(i, 1); }
    }
    const target = C.herds * C.animalsPerHerd;
    if (this.animals.length < target && this.rng.chance(0.02)) {
      const r = this.size * 0.9;
      this.animals.push(new Animal(this, this.rng, this.rng.range(-r, r), this.rng.range(-r, r),
        this.rng.int(0, C.herds - 1)));
    }
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
