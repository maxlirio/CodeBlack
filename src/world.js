import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  makeTree, makeBush, makeCrop, setCropGrowth, Animal,
  makeMountain, makeOre, makeBoulder, makeLake, makeFlowerPatch, makeDeadTree, makeMushroomRing
} from './nature.js';

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
    this.ores = [];         // mineable ore nodes (need a pickaxe)
    this.mountains = [];    // {pos, r} solid peaks — need a ladder to scale
    this.structures = [];
    this.projectiles = [];    // flying arrows / thrown spears
    this.feuds = new Map();   // "tribeA|tribeB" -> hatred magnitude
    this.bonds = new Map();   // "tribeA|tribeB" -> trade goodwill
    this.truces = new Map();  // "tribeA|tribeB" -> tick the truce expires
    this.invaders = [];       // {intruder, tribeId, pos, until} — a foe is in our hall
    // Back-compat alias: older code referred to edible nodes as "resources".
    this.resources = this.foods;

    // Layered noise + ridge fold + plateau-ish terraces + a few discrete
    // cliff bumps. All baked from the seeded RNG so the world is
    // reproducible and height stays an O(1) analytic sample.
    this.n1 = { fx: rng.range(0.020, 0.040), fz: rng.range(0.020, 0.040), px: rng() * 9, pz: rng() * 9 };
    this.n2 = { fx: rng.range(0.055, 0.085), fz: rng.range(0.055, 0.085), px: rng() * 9, pz: rng() * 9 };
    this.n3 = { fx: rng.range(0.110, 0.160), fz: rng.range(0.110, 0.160), px: rng() * 9, pz: rng() * 9 };
    this.nR = { fx: rng.range(0.035, 0.055), fz: rng.range(0.035, 0.055), px: rng() * 9, pz: rng() * 9 };
    this.nT = { fx: rng.range(0.018, 0.032), fz: rng.range(0.018, 0.032), px: rng() * 9, pz: rng() * 9 };

    // A handful of localized cliff "bumps" — each is a smooth hill with a
    // sharper inner ramp, producing readable cliffs/terraces without ever
    // becoming an impassable wall. They're what give silhouettes depth.
    const T = CONFIG.world.terrain;
    const nBumps = rng.int(T.cliffCount[0], T.cliffCount[1]);
    this.cliffBumps = [];
    for (let i = 0; i < nBumps; i++) {
      this.cliffBumps.push({
        x: rng.range(-this.size * 0.78, this.size * 0.78),
        z: rng.range(-this.size * 0.78, this.size * 0.78),
        R: rng.range(T.cliffR[0], T.cliffR[1]),
        H: rng.range(T.cliffHeight[0], T.cliffHeight[1]),
      });
    }

    this._buildLighting();
    this._buildTerrain();
    this._seedNature();
  }

  heightAt(x, z) {
    const a = CONFIG.world.terrainAmplitude;
    const T = CONFIG.world.terrain;
    // Three octaves of value-ish noise → rolling hills, never flat.
    const h1 = Math.sin(x * this.n1.fx + this.n1.px) * Math.cos(z * this.n1.fz + this.n1.pz);
    const h2 = Math.sin(x * this.n2.fx + this.n2.px) * Math.cos(z * this.n2.fz + this.n2.pz);
    const h3 = Math.sin(x * this.n3.fx + this.n3.px) * Math.cos(z * this.n3.fz + this.n3.pz);
    let h = h1 * a + h2 * a * 0.45 + h3 * a * 0.20;
    // Folded noise carves sharp ridges (1 - |n|) — these read as long
    // running spines from a distance.
    const r = Math.sin(x * this.nR.fx + this.nR.px) * Math.cos(z * this.nR.fz + this.nR.pz);
    h += (1 - Math.abs(r)) * T.ridgeStrength;
    // Discrete terraces: snap a slow octave to a few levels. Creates the
    // bench-like steps that read as terraces rather than smooth slopes.
    const tn = Math.sin(x * this.nT.fx + this.nT.px) * Math.cos(z * this.nT.fz + this.nT.pz);
    h += Math.round(tn * 2) * 0.5 * T.terraceStrength;
    // A few localized cliffs/hills — smooth bell shape with a sharper
    // inner ramp so the silhouette has real verticality.
    for (const b of this.cliffBumps) {
      const dx = x - b.x, dz = z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < b.R) {
        const t = 1 - d / b.R;
        // smoothstep ramp (cheap): t² (3 - 2t) — gives soft top + steeper side
        h += t * t * (3 - 2 * t) * b.H;
      }
    }
    return h;
  }

  // True if a placed ladder sits within reach of (x, z). Ladders are
  // structures, not tools — they enable steep-slope crossing wherever a
  // player or villager has built one.
  _nearLadder(x, z) {
    const r2 = CONFIG.world.terrain.ladderReach ** 2;
    for (const s of this.structures) {
      if (s.type !== 'ladder') continue;
      const dx = s.pos.x - x, dz = s.pos.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
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
    this._seedLandmarks(r);
    this.roads = [];
    this.roadGroup = new THREE.Group();
    this.scene.add(this.roadGroup);
  }

  _seedLandmarks(r) {
    const L = CONFIG.landmarks;
    // Mountains — rocky peaks that block travel (climb with a ladder),
    // ringed by ore the miners quarry for stone.
    for (let i = 0; i < L.mountains; i++) {
      const x = this.rng.range(-r, r), z = this.rng.range(-r, r);
      const y = this.heightAt(x, z);
      const m = makeMountain(this.rng);
      m.position.set(x, y, z);
      this.scene.add(m);
      const mt = { pos: new THREE.Vector3(x, y, z), r: m.userData.blockR };
      this.mountains.push(mt);
      const ringN = 5 + this.rng.int(0, 3);
      for (let k = 0; k < ringN; k++) {
        const a = (k / ringN) * Math.PI * 2 + this.rng();
        this._addOre(x + Math.sin(a) * (mt.r + 1.5), z + Math.cos(a) * (mt.r + 1.5));
      }
    }
    // Lakes — flat water with reeds. Valleys only: sample until we find
    // a spot where the ground is low. Skip if no valley spot found.
    const lakeMax = CONFIG.world.terrain.lakeMaxHeight;
    for (let i = 0; i < L.lakes; i++) {
      let x = 0, z = 0, placed = false;
      for (let tries = 0; tries < 50; tries++) {
        const cx = this.rng.range(-r, r), cz = this.rng.range(-r, r);
        if (this.heightAt(cx, cz) < lakeMax) { x = cx; z = cz; placed = true; break; }
      }
      if (!placed) continue;
      const rad = 7 + this.rng.range(0, 7);
      const lk = makeLake(this.rng, rad);
      lk.position.set(x, this.heightAt(x, z) + 0.12, z);
      this.scene.add(lk);
    }
    // Boulders — some bear ore, the rest are scenery.
    for (let i = 0; i < L.boulders; i++) {
      const x = this.rng.range(-r, r), z = this.rng.range(-r, r);
      if (this.rng.chance(0.45)) { this._addOre(x, z); continue; }
      const b = makeBoulder(this.rng);
      b.position.set(x, this.heightAt(x, z) + 0.5, z);
      this.scene.add(b);
    }
    const scatter = (n, make, yOff = 0) => {
      for (let i = 0; i < n; i++) {
        const x = this.rng.range(-r, r), z = this.rng.range(-r, r);
        const o = make(this.rng);
        o.position.set(x, this.heightAt(x, z) + yOff, z);
        this.scene.add(o);
      }
    };
    scatter(L.flowerPatches, makeFlowerPatch);
    scatter(L.deadTrees, makeDeadTree);
    scatter(L.mushroomRings, makeMushroomRing);
  }

  _addOre(x, z) {
    const y = this.heightAt(x, z);
    const mesh = makeOre(this.rng);
    mesh.position.set(x, y + 0.5, z);
    this.scene.add(mesh);
    this.ores.push({ pos: new THREE.Vector3(x, y + 0.6, z), mesh,
      stone: CONFIG.mining.nodeStone, regrowAt: 0 });
  }

  mineOre(node, tick) {
    if (node.stone <= 0) return 0;
    node.stone -= 1;
    if (node.stone <= 0) { node.regrowAt = tick + CONFIG.mining.regrowTicks; node.mesh.visible = false; }
    return CONFIG.mining.yield;
  }

  nearestOre(x, z) {
    let best = null, bd = Infinity;
    for (const o of this.ores) {
      if (o.stone <= 0) continue;
      const d = (o.pos.x - x) ** 2 + (o.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    return best ? { ore: best, dist: Math.sqrt(bd) } : null;
  }

  // Pave straight roads between a settlement's centre and its granaries,
  // and along live trade routes between bonded clans. Re-derived rarely.
  rebuildRoads() {
    const L = CONFIG.logistics;
    const centres = this.structures.filter((s) => s.type === 'center');
    const stores = this.structures.filter((s) => s.type === 'storehouse');
    const houses = this.structures.filter((s) => s.type === 'house');
    const links = [];
    // Roads are paved by PLACE, not tribe tag (ids drift). Every granary
    // is a hub with streets to its village's centre & nearest houses, and
    // a trade road runs to any other granary within caravan range.
    const VR = CONFIG.structures.villageRadius;
    const hubs = stores.length ? stores : centres;
    for (const h of hubs) {
      for (const c of centres) {
        if (c !== h && Math.hypot(c.pos.x - h.pos.x, c.pos.z - h.pos.z) < VR * 1.6) {
          links.push([h, c]);
        }
      }
      const near = houses
        .map((ho) => [ho, Math.hypot(ho.pos.x - h.pos.x, ho.pos.z - h.pos.z)])
        .filter(([, d]) => d < VR)
        .sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.min(7, near.length); i++) links.push([h, near[i][0]]);
    }
    // Inter-village trade roads between granaries (caravan routes).
    for (let i = 0; i < stores.length; i++) {
      for (let j = i + 1; j < stores.length; j++) {
        const a = stores[i], b = stores[j];
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < L.roadMaxLen) links.push([a, b]);
      }
    }
    this.roadGroup.clear();
    // One continuous ribbon hugging the terrain — looks like a dirt path
    // painted on the ground, not a chain of boxes. polygonOffset keeps it
    // from z-fighting the grass beneath it.
    this._roadMat ??= new THREE.MeshStandardMaterial({
      color: 0x6f5836, roughness: 1, polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const pos = [];
    const W = L.roadWidth;
    this.roads = links.map(([a, b]) => {
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const px = (-dz / len) * W, pz = (dx / len) * W;   // perpendicular half-width
      const n = Math.max(2, Math.round(len / 2.5));
      let pL = null, pR = null;
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const cx = a.pos.x + dx * t, cz = a.pos.z + dz * t;
        const lx = cx - px, lz = cz - pz, rx = cx + px, rz = cz + pz;
        const L2 = [lx, this.heightAt(lx, lz) + 0.06, lz];
        const R2 = [rx, this.heightAt(rx, rz) + 0.06, rz];
        if (pL) pos.push(...pL, ...pR, ...R2, ...pL, ...R2, ...L2); // two tris
        pL = L2; pR = R2;
      }
      return { ax: a.pos.x, az: a.pos.z, bx: b.pos.x, bz: b.pos.z, len2: len * len };
    });
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const ribbon = new THREE.Mesh(geo, this._roadMat);
      ribbon.receiveShadow = true;
      this.roadGroup.add(ribbon);
    }
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
  // Structures are neutral timber/thatch — allegiance reads off the
  // agents' banners, not the buildings. (3rd arg kept for call-site
  // compatibility but no longer tints anything.)
  addStructure(pos, _legacyColor, type = 'house', builder = null) {
    const tribeColor = 0xb59a6a;            // neutral thatch/timber accent
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
    } else if (type === 'ladder') {
      // A tall wooden ladder — purely a climbing-enabler. Anyone within
      // CONFIG.world.terrain.ladderReach can traverse a steep slope they
      // otherwise couldn't. Aligned to the slope by the player or AI.
      const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.95 });
      const LH = 6.5;
      for (const sx of [-0.45, 0.45]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, LH, 0.12), wood);
        rail.position.set(sx, LH * 0.5, 0); rail.castShadow = true; mesh.add(rail);
      }
      for (let i = 0; i < 9; i++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.08), wood);
        rung.position.set(0, 0.6 + i * 0.7, 0); mesh.add(rung);
      }
      mesh.rotation.y = pos.facing ?? 0;
      radius = 0.8;
    } else if (type === 'fence') {
      const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.95 });
      for (const sx of [-1.5, 0, 1.5]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), wood);
        post.position.set(sx, 0.5, 0); post.castShadow = true; mesh.add(post);
      }
      for (const ry of [0.4, 0.78]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 0.08), wood);
        rail.position.y = ry; mesh.add(rail);
      }
      mesh.rotation.y = pos.facing ?? 0;
      radius = 1.4;
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
      // An open-top stone keep: square shaft + a crenellated battlement
      // you can stand and walk on (no roof).
      const stone = new THREE.MeshStandardMaterial({ color: 0x8d8576, roughness: 0.95 });
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(2.6, 6.0, 2.6), stone);
      shaft.position.y = 3.0; shaft.castShadow = true; shaft.receiveShadow = true;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.3, 3.0), stone);
      deck.position.y = 6.1;
      mesh.add(shaft, deck);
      const accent = new THREE.MeshStandardMaterial({ color: tribeColor, roughness: 0.8 });
      for (let i = 0; i < 4; i++) {
        for (const t of [-1, 0, 1]) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.35),
            i % 2 ? accent : stone);
          const a = i * Math.PI / 2;
          const off = t * 0.95;
          m.position.set(Math.sin(a) * 1.5 + Math.cos(a) * off, 6.6,
            Math.cos(a) * 1.5 - Math.sin(a) * off);
          m.rotation.y = a;
          mesh.add(m);
        }
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 4),
        new THREE.MeshStandardMaterial({ color: 0x3a2f22 }));
      pole.position.set(1.1, 7.3, 1.1);
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 3), accent);
      flag.position.set(1.4, 7.6, 1.1); flag.rotation.z = -Math.PI / 2;
      mesh.add(pole, flag);
      radius = 1.6;
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
      // A goal plaque beside the banner (skipped in headless/no-DOM).
      if (typeof document !== 'undefined') {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
        const tex = new THREE.CanvasTexture(cv);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        board.position.set(0, 4.6, 1.36);
        mesh.add(board);
        mesh.userData.plaque = { cv, ctx: cv.getContext('2d'), tex };
      }
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
    } else if (type === 'ballista') {
      // A giant mounted crossbow on a swivel frame.
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6),
        new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.9 }));
      base.position.y = 0.4; base.castShadow = true;
      const turret = new THREE.Group(); turret.position.y = 0.9;
      const bow = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 3.0),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2f }));
      bow.rotation.y = Math.PI / 2;
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.8, 4),
        new THREE.MeshStandardMaterial({ color: 0x8d8576 }));
      bolt.rotation.x = Math.PI / 2; bolt.position.set(0, 0.16, 0.4);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 1.6),
        new THREE.MeshStandardMaterial({ color: tribeColor }));
      turret.add(bow, bolt, stock);
      mesh.add(base, turret);
      mesh.userData.turret = turret;
      mesh.rotation.y = pos.facing ?? 0;
      radius = 1.3;
    } else if (type === 'catapult') {
      // A counter-weighted throwing arm with a loaded bucket.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 2.4),
        new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.9 }));
      frame.position.y = 0.4; frame.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 3.4),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2f }));
      arm.position.set(0, 1.4, 0); arm.rotation.x = -0.7;
      const bucket = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 0),
        new THREE.MeshStandardMaterial({ color: 0x8d8576 }));
      bucket.position.set(0, 2.4, -1.4);
      const cw = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6),
        new THREE.MeshStandardMaterial({ color: tribeColor }));
      cw.position.set(0, 1.9, 1.3);
      for (const sx of [-0.9, 0.9]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.8, 0.18),
          new THREE.MeshStandardMaterial({ color: 0x5a3d24 }));
        post.position.set(sx, 1.3, 0); mesh.add(post);
      }
      mesh.add(frame, arm, bucket, cw);
      mesh.userData.arm = arm;
      mesh.rotation.y = pos.facing ?? 0;
      radius = 1.5;
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

    // Honour a requested orientation for any building (player can rotate).
    if (pos.facing != null) mesh.rotation.y = pos.facing;
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
      store: type === 'storehouse' ? { food: 0, wood: 0, stone: 0 } : null,
      // Towers start with a half-full quiver and refill from any nearby
      // friendly storehouse (see world.update's tower-restock loop).
      arrows: type === 'tower' ? Math.floor(CONFIG.tower.arrowCap * 0.5) : 0,
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
  // Spatial, churn-proof: "home" hub = the granary nearest our home; a
  // partner = a granary in a *different* settlement within caravan range
  // that we're not at war with. (Tribe ids drift, so we go by place.)
  tradePartner(self) {
    const here = self.home ? self.home.pos : self.pos;
    let home = null, hd = Infinity;
    for (const st of this.structures) {
      if (st.type !== 'storehouse') continue;
      const d = (st.pos.x - here.x) ** 2 + (st.pos.z - here.z) ** 2;
      if (d < hd) { hd = d; home = st; }
    }
    if (!home) return null;
    let partner = null, pd = CONFIG.trade.range ** 2;
    for (const st of this.structures) {
      if (st === home || st.type !== 'storehouse') continue;
      // Any granary a fair walk away (a supply run or inter-clan trade).
      const sep = (st.pos.x - home.pos.x) ** 2 + (st.pos.z - home.pos.z) ** 2;
      if (sep < 18 * 18) continue;
      if (st.tribe != null && home.tribe != null &&
          this.feud(home.tribe, st.tribe) >= CONFIG.feud.warThreshold) continue;
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

  // Push a moving point out of solid walls; the cliff blocks crossing
  // between high- and low-lands unless you carry a ladder AND stand near
  // a climb point. Pass prev (x,z) so we can detect actually crossing the
  // edge rather than just being on one side.
  resolveCollision(x, z, r, canClimb = false, prevX = null, prevZ = null) {
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
    // Steep-slope gate: if this step would scale (or drop) more than the
    // configured max, refuse it unless there's a placed ladder in reach.
    // This replaces the old single-cliff hack with a generic rule that
    // works for every cliff, terrace, ridge or bump in the world.
    if (prevX != null) {
      const dy = this.heightAt(x, z) - this.heightAt(prevX, prevZ);
      if (Math.abs(dy) > CONFIG.world.terrain.slopeMaxStep) {
        if (!(this._nearLadder(x, z) || this._nearLadder(prevX, prevZ))) {
          x = prevX; z = prevZ;
        }
      }
    }
    // Legacy peaks: if any still exist they remain solid without a ladder.
    if (!canClimb) {
      for (const mt of this.mountains) {
        const dx = x - mt.pos.x;
        const dz = z - mt.pos.z;
        const d2 = dx * dx + dz * dz;
        const min = mt.r + r;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (min - d) / d;
          x += dx * push;
          z += dz * push;
        }
      }
    }
    return { x, z };
  }

  update_oresRegrow(tick) {
    for (const o of this.ores) {
      if (o.stone <= 0 && tick >= o.regrowAt) { o.stone = CONFIG.mining.nodeStone; o.mesh.visible = true; }
    }
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
    // Two aim modes: a flat XZ vector gets the classic upward launch arc;
    // a true 3D vector (with .y supplied) is used as-is so the shooter
    // can aim straight down off a tower or up at a moving target.
    const flat = (dir.y == null);
    const v = flat
      ? new THREE.Vector3(dir.x, 0, dir.z)
      : new THREE.Vector3(dir.x, dir.y, dir.z);
    if (v.lengthSq() < 1e-5) return;
    v.normalize().multiplyScalar(speed);
    if (flat) v.y = speed * 0.16;     // legacy ground-shooter arc
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

  _siegeOwner(s) {
    return { tribeId: s.tribe, familyId: s._fam, id: s.owner, alive: true };
  }

  _nearestEnemyStruct(s, max) {
    let best = null, bd = max * max;
    for (const t of this.structures) {
      if (t === s || t.tribe == null || t.tribe === s.tribe) continue;
      if (t.type === 'ram' || t.type === 'ballista' || t.type === 'catapult') continue;
      const wt = t.type === 'center' ? 0 : t.type === 'wall' || t.type === 'gate' ? 60 : 30;
      const d = (t.pos.x - s.pos.x) ** 2 + (t.pos.z - s.pos.z) ** 2 + wt;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // Siege engines act on their own: rams roll up and smash, ballistae
  // snipe, catapults lob boulders that wreck buildings (with splash).
  _updateSiege(dt, entities) {
    const W = CONFIG.war;
    const crewed = (s) => {
      const r2 = (W.crewRadius ?? 4) ** 2;
      for (const e of entities) {
        if (!e.alive || e.inside) continue;
        if (e.tribeId !== s.tribe && !(e.familyId != null && e.familyId === s._fam)) continue;
        if ((e.pos.x - s.pos.x) ** 2 + (e.pos.z - s.pos.z) ** 2 < r2) return true;
      }
      return false;
    };
    for (const s of this.structures) {
      // A siege engine is dead weight without a crew to push & work it.
      if ((s.type === 'ram' || s.type === 'ballista' || s.type === 'catapult') && !crewed(s)) continue;
      if (s.type === 'ram') {
        const t = this._nearestEnemyStruct(s, 999);
        if (!t) continue;
        const dx = t.pos.x - s.pos.x, dz = t.pos.z - s.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > W.ram.reach) {
          s.pos.x += (dx / d) * W.ram.speed * dt;       // wheel toward the wall
          s.pos.z += (dz / d) * W.ram.speed * dt;
          s.pos.y = this.heightAt(s.pos.x, s.pos.z);
          s.mesh.position.copy(s.pos);
          s.mesh.rotation.y = Math.atan2(dx, dz);
        } else {
          s.mesh.position.z = s.pos.z + Math.sin(this.tickNow * 0.4) * 0.3; // ramming
          this.damageStructure(t, W.ram.dmg * dt * 20, this._siegeOwner(s));
        }
        continue;
      }
      if (s.type !== 'ballista' && s.type !== 'catapult') continue;
      const cfg = W[s.type];
      s._cd = (s._cd ?? 0) - 1;
      let tgt = this._nearestEnemyStruct(s, cfg.range);
      let tgtPos = tgt?.pos;
      if (s.type === 'ballista' && entities) {        // ballistae also pick off troops
        for (const e of entities) {
          if (!e.alive || e.inside || e.tribeId === s.tribe) continue;
          const d2 = (e.pos.x - s.pos.x) ** 2 + (e.pos.z - s.pos.z) ** 2;
          if (d2 < cfg.range * cfg.range && (!tgtPos ||
              d2 < (tgtPos.x - s.pos.x) ** 2 + (tgtPos.z - s.pos.z) ** 2)) {
            tgt = e; tgtPos = e.pos;
          }
        }
      }
      if (!tgtPos) continue;
      const face = Math.atan2(tgtPos.x - s.pos.x, tgtPos.z - s.pos.z);
      if (s.mesh.userData.turret) s.mesh.userData.turret.rotation.y = face - (s.mesh.rotation.y);
      if (s._cd > 0) continue;
      s._cd = cfg.cooldown;
      // Cosmetic shot for the spectacle.
      this._siegeShot(new THREE.Vector3(s.pos.x, s.pos.y + 1.2, s.pos.z),
        tgtPos, s.type === 'catapult' ? 'boulder' : 'bolt', cfg.speed);
      if (tgt && tgt.hp != null) {                    // hit a structure
        this.damageStructure(tgt, cfg.dmg, this._siegeOwner(s));
        if (s.type === 'catapult') {                  // splash onto neighbours
          for (const o of this.structures) {
            if (o === tgt || o.tribe === s.tribe || o.tribe == null) continue;
            if (Math.hypot(o.pos.x - tgt.pos.x, o.pos.z - tgt.pos.z) < cfg.splash) {
              this.damageStructure(o, cfg.dmg * 0.4, this._siegeOwner(s));
            }
          }
        }
      } else if (tgt && tgt.damage) {                 // hit an agent
        tgt.damage(cfg.dmg, this._siegeOwner(s));
      }
    }
  }

  // A purely visual arcing projectile (real damage is applied instantly).
  _siegeShot(origin, target, kind, speed) {
    const dx = target.x - origin.x, dz = target.z - origin.z;
    const d = Math.hypot(dx, dz) || 1;
    const big = kind === 'boulder';
    const mesh = new THREE.Mesh(
      big ? new THREE.IcosahedronGeometry(0.4, 0)
          : new THREE.CylinderGeometry(0.06, 0.06, 1.4, 4),
      this._tipMat ??= new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.5 }));
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.projectiles.push({
      pos: origin.clone(),
      vel: new THREE.Vector3((dx / d) * speed, speed * 0.34, (dz / d) * speed),
      speed, dmg: 0, owner: null, kind, mesh, target: null, siege: true,
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
      // Siege shells are cosmetic (damage was applied at launch): just
      // arc, no homing, no collateral — vanish on landing.
      if (pr.siege) {
        pr.vel.y -= P.gravity * dt;
        pr.pos.addScaledVector(pr.vel, dt);
        pr.mesh.position.copy(pr.pos);
        if (pr.kind === 'boulder') pr.mesh.rotation.x += dt * 6;
        if (--pr.life <= 0 || pr.pos.y <= this.heightAt(pr.pos.x, pr.pos.z)) {
          this.scene.remove(pr.mesh); this.projectiles.splice(i, 1);
        }
        continue;
      }
      // Re-acquire a quarry along the aim line — the closest thing to
      // the crosshair, not just the closest thing in space. We pick the
      // candidate with the smallest perpendicular distance to the flight
      // ray, gated by a forward cone so we don't snap onto targets
      // behind us. If nothing is roughly in line, the arrow flies free.
      if (!valid(pr, pr.target)) {
        pr.target = null;
        const aim = pr.vel.clone();
        const al = aim.length();
        if (al > 1e-4) {
          aim.divideScalar(al);
          const range2 = P.homingRange * P.homingRange;
          let bestPerp2 = Infinity;
          const consider = (e) => {
            const dx = e.pos.x - pr.pos.x;
            const dy = ((e.pos.y ?? 0) + 0.6) - pr.pos.y;
            const dz = e.pos.z - pr.pos.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > range2) return;
            const fwd = dx * aim.x + dy * aim.y + dz * aim.z;
            if (fwd <= 0.5) return;             // behind / right beside us
            const perp2 = Math.max(0, d2 - fwd * fwd);
            // Cone gate: 45° (perp/fwd < 1); keeps the snap honest so
            // arrows you point off into nothing don't curl onto distant
            // bystanders.
            if (perp2 > fwd * fwd) return;
            if (perp2 < bestPerp2) { bestPerp2 = perp2; pr.target = e; }
          };
          for (const a of this.animals) if (a.alive) consider(a);
          for (const e of entities) {
            if (e.inside || !valid(pr, e)) continue;
            consider(e);
          }
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
          if (!e.alive || e.inside || e === pr.owner) continue;
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

  _colorName(c) {
    if (!c) return 'the foe';
    const hsl = {}; c.getHSL(hsl);
    if (hsl.l > 0.8) return 'the White';
    if (hsl.l < 0.18) return 'the Black';
    if (hsl.s < 0.2) return 'the Grey';
    const h = hsl.h * 360;
    const names = [[15, 'the Red'], [45, 'the Orange'], [70, 'the Yellow'],
      [165, 'the Green'], [195, 'the Teal'], [255, 'the Blue'],
      [290, 'the Violet'], [340, 'the Magenta'], [361, 'the Red']];
    for (const [lim, nm] of names) if (h < lim) return nm;
    return 'the foe';
  }

  // A short banner-plaque goal for a village (its town-centre tribe).
  tribeGoal(tribeId, originPos = null) {
    // Prefer the actual residents around a centre (tribe ids drift, so
    // matching by place is far more reliable than by tag).
    let ents;
    if (originPos) {
      ents = (this.entities || []).filter((e) => e.alive &&
        (e.pos.x - originPos.x) ** 2 + (e.pos.z - originPos.z) ** 2 < 70 * 70);
      if (ents.length) tribeId = ents[0].tribeId;
    } else {
      ents = (this.entities || []).filter((e) => e.alive && e.tribeId === tribeId);
    }
    if (!ents.length) return 'ENDURE';
    // At war? name the enemy by colour.
    let worst = 0, foeTribe = null;
    for (const [k, v] of this.feuds) {
      const [a, b] = k.split('|').map(Number);
      if ((a === tribeId || b === tribeId) && v > worst) {
        worst = v; foeTribe = a === tribeId ? b : a;
      }
    }
    if (worst >= CONFIG.feud.warThreshold && foeTribe != null) {
      const foe = (this.entities || []).find((e) => e.alive && e.tribeId === foeTribe);
      return `DEFEAT ${this._colorName(foe?.tribeColor)}`;
    }
    const avgE = ents.reduce((s, e) => s + e.energy, 0) / ents.length;
    if (avgE < 45) return 'GATHER FOOD';
    let stores = 0, houses = 0;
    for (const st of this.structures) {
      if (st.tribe !== tribeId) continue;
      if (st.type === 'storehouse') stores++;
      else if (st.type === 'house') houses++;
    }
    if (stores === 0) return 'RAISE A GRANARY';
    if (houses < ents.length / 3) return 'BUILD HOMES';
    for (const v of this.bonds.values()) if (v > 0.5) return 'TRADE & PROSPER';
    return 'THRIVE';
  }

  _refreshPlaques() {
    for (const st of this.structures) {
      if (st.type !== 'center' || !st.mesh.userData.plaque) continue;
      const goal = this.tribeGoal(st.tribe, st.pos);
      const pq = st.mesh.userData.plaque;
      if (pq.text === goal) continue;
      pq.text = goal;
      const { ctx, cv, tex } = pq;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(20,16,8,0.82)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = '#d8b25a'; ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, cv.width - 4, cv.height - 4);
      ctx.fillStyle = '#ffe7a8';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(goal, cv.width / 2, cv.height / 2 + 2);
      tex.needsUpdate = true;
    }
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
      if (st.tribe == null || st.tribe === self.tribeId) continue;
      if (st.type === 'ram' || st.type === 'ballista' || st.type === 'catapult') continue;
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
    // Intruders in our halls: drop the call once the foe is dead, has
    // gone, or the alarm has run out; keep the position up to date so
    // the defenders chase the right spot.
    if (this.invaders.length) {
      this.invaders = this.invaders.filter((inv) => {
        if (!inv.intruder || !inv.intruder.alive) return false;
        if (tick > inv.until) return false;
        inv.pos = { x: inv.intruder.pos.x, z: inv.intruder.pos.z };
        return true;
      });
    }

    // Tower quivers refill from any friendly storehouse in range — a
    // slow trickle so a tower under sustained pressure does run dry.
    const T = CONFIG.tower;
    for (const st of this.structures) {
      if (st.type !== 'tower' || st.arrows >= T.arrowCap) continue;
      // One arrow each `restockTicks / suppliers` — i.e., more granaries
      // nearby fill the tower faster, which is exactly what you'd want.
      let suppliers = 0;
      for (const g of this.structures) {
        if (g.type !== 'storehouse' || g.tribe !== st.tribe) continue;
        const dx = g.pos.x - st.pos.x, dz = g.pos.z - st.pos.z;
        if (dx * dx + dz * dz < T.restockRadius * T.restockRadius) suppliers++;
      }
      if (!suppliers) continue;
      if (tick % Math.max(1, Math.floor(T.restockTicks / suppliers)) === 0) st.arrows++;
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
    this.update_oresRegrow(tick);
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
          if (o === a || !o.alive || o.predator || o.horse) continue; // horses outrun wolves
          if (o.penned) continue;                                     // safe behind the fences
          const d = o.pos.distanceTo(a.pos);
          if (d < qd && d < P.senseRadius) { qd = d; q = o; }
        }
        for (const e of entities) {
          if (!e.alive || e.inside) continue;
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
        if (a.ownerEntity && a.ownerEntity.alive) a.rideUpdate(a.ownerEntity);
        else { a.tamed = false; a.ownerEntity = null; }   // freed if owner dies
      } else if (a.penned && a.penHome) {
        a.grazeUpdate(dt, a.penHome, CONFIG.pen.radius); // calm livestock
      } else {
        let nd = Infinity, np = null;
        for (const e of entities) {
          if (!e.alive || e.inside) continue;
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
    if (wildHorses < CONFIG.logistics.horses && this.rng.chance(0.02)) {
      const r = this.size * 0.9;
      this.animals.push(new Animal(this, this.rng, this.rng.range(-r, r), this.rng.range(-r, r),
        299, 'horse'));
    }
    if (tick % CONFIG.logistics.roadRecomputeTicks === 0) this.rebuildRoads();

    // Penned livestock multiply — animal husbandry feeds a village.
    if (tick % CONFIG.pen.breedTicks === 0) {
      const pens = this.animals.filter((a) => a.alive && a.penned && a.penHome);
      for (const a of pens) {
        const near = pens.filter((b) =>
          (b.penHome.x - a.penHome.x) ** 2 + (b.penHome.z - a.penHome.z) ** 2 < 4).length;
        if (near < CONFIG.pen.maxPenned && this.rng.chance(0.5)) {
          const calf = new Animal(this, this.rng,
            a.pos.x + this.rng.range(-2, 2), a.pos.z + this.rng.range(-2, 2),
            900, 'herbivore', a.species);
          calf.penned = true; calf.penHome = { ...a.penHome };
          this.animals.push(calf);
        }
      }
    }

    if (tick % 150 === 0) this._refreshPlaques();
    this._updateSiege(dt, entities);
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
