import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp } from './rng.js';

// Low-poly flora & fauna. Everything is built from triangle primitives
// (cones, tapered cylinders with few segments, custom wedges) so the
// shapes actually read as trees / bushes / crops / animals rather than
// abstract blobs. Geometries & materials are shared for performance.
const MAT = {
  trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95, flatShading: true }),
  leafA: new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: 0.85, flatShading: true }),
  leafB: new THREE.MeshStandardMaterial({ color: 0x3f9248, roughness: 0.85, flatShading: true }),
  bush: new THREE.MeshStandardMaterial({ color: 0x3a7d46, roughness: 0.8, flatShading: true }),
  berry: new THREE.MeshStandardMaterial({ color: 0xc23b54, roughness: 0.5, emissive: 0x300 }),
  sprout: new THREE.MeshStandardMaterial({ color: 0x6fae45, roughness: 0.7, flatShading: true }),
  grain: new THREE.MeshStandardMaterial({ color: 0xd9b441, roughness: 0.7, flatShading: true }),
  hide: new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.85, flatShading: true }),
  hideDark: new THREE.MeshStandardMaterial({ color: 0x6f4a2a, roughness: 0.8, flatShading: true }),
  wolf: new THREE.MeshStandardMaterial({ color: 0x6a6f78, roughness: 0.8, flatShading: true }),
  wolfDark: new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.8, flatShading: true }),
  carcass: new THREE.MeshStandardMaterial({ color: 0x7a4b3a, roughness: 0.9, flatShading: true }),
  shaft: new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.9 }),
  flint: new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.5, flatShading: true })
};

const GEO = {
  // 5-sided cone reads as conifer foliage; 4-sided trunk is a faceted log.
  cone(r, h, seg = 6) { return new THREE.ConeGeometry(r, h, seg); },
  trunk: new THREE.CylinderGeometry(0.16, 0.26, 1, 5),
  berry: new THREE.TetrahedronGeometry(0.12),
  leg: new THREE.CylinderGeometry(0.06, 0.06, 0.7, 4)
};

// A flat-shaded triangular wedge — the angular body of an animal.
function wedge(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const v = new Float32Array([
    -x,-y, z,  x,-y, z,  x, y, z,  -x,-y, z,  x, y, z, -x, y, z, // front
    -x,-y,-z, -x, y,-z,  x, y,-z,  -x,-y,-z,  x, y,-z,  x,-y,-z, // back
    -x, y,-z, -x, y, z,  x, y, z,  -x, y,-z,  x, y, z,  x, y,-z, // top
    -x,-y,-z,  x,-y,-z,  x,-y, z,  -x,-y,-z,  x,-y, z, -x,-y, z, // bottom
     x,-y,-z,  x, y,-z,  x, y, z,   x,-y,-z,  x, y, z,  x,-y, z, // right
    -x,-y,-z, -x,-y, z, -x, y, z,  -x,-y,-z, -x, y, z, -x, y,-z  // left
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}
const ANIMAL_BODY = wedge(1.5, 0.85, 0.7);
const ANIMAL_SNOUT = new THREE.ConeGeometry(0.22, 0.5, 4);

export function makeTree(rng) {
  const g = new THREE.Group();
  const trunkH = 1.6 + rng.range(0, 1.1);
  const trunk = new THREE.Mesh(GEO.trunk, MAT.trunk);
  trunk.scale.y = trunkH;
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);
  // Three stacked cones — a clearly recognisable conifer silhouette.
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const r = 1.5 - i * 0.38;
    const h = 1.5 - i * 0.18;
    const c = new THREE.Mesh(GEO.cone(r, h, 6), i % 2 ? MAT.leafB : MAT.leafA);
    c.position.y = trunkH + 0.2 + i * (h * 0.62);
    c.rotation.y = rng.range(0, Math.PI);
    c.castShadow = true;
    g.add(c);
  }
  g.userData.foliage = g.children.slice(1);
  return g;
}

export function makeBush(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const lobe = new THREE.Mesh(GEO.cone(0.55 + rng.range(0, 0.2), 0.9, 5), MAT.bush);
    lobe.position.set(rng.range(-0.3, 0.3), 0.45, rng.range(-0.3, 0.3));
    lobe.castShadow = true;
    g.add(lobe);
  }
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(GEO.berry, MAT.berry);
    b.position.set(rng.range(-0.5, 0.5), 0.5 + rng.range(0, 0.4), rng.range(-0.5, 0.5));
    g.add(b);
  }
  return g;
}

// Crop with three visible growth stages: sprout -> stalks -> golden grain.
export function makeCrop() {
  const g = new THREE.Group();
  const stalks = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(GEO.cone(0.12, 0.6, 4), MAT.sprout);
    s.position.set((i % 2 ? 0.22 : -0.22), 0.3, (i < 2 ? 0.22 : -0.22));
    g.add(s);
    stalks.push(s);
  }
  g.userData.stalks = stalks;
  g.scale.setScalar(0.35);
  return g;
}
export function setCropGrowth(mesh, t) {
  const s = 0.35 + t * 0.95;
  mesh.scale.set(s, 0.35 + t * 1.5, s);
  const ripe = t > 0.75;
  for (const st of mesh.userData.stalks) st.material = ripe ? MAT.grain : MAT.sprout;
}

// Held tool meshes, parented to a hand — each clearly distinct so you can
// read an agent's kit at a glance.
export function makeTool(type) {
  const g = new THREE.Group();
  if (type === 'bow') {
    const limb = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 5, 9, Math.PI * 1.25), MAT.shaft);
    const str = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.78, 3),
      new THREE.MeshStandardMaterial({ color: 0xd9d2c0 }));
    str.position.x = 0.18;
    g.add(limb, str);
  } else if (type === 'sword') {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 4), MAT.shaft);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.08), MAT.flint);
    guard.position.y = 0.18;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.95, 0.03), MAT.flint);
    blade.position.y = 0.68;
    g.add(grip, guard, blade);
  } else if (type === 'ladder') {
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.3, 0.05), MAT.shaft);
    railL.position.x = -0.16;
    const railR = railL.clone(); railR.position.x = 0.16;
    g.add(railL, railR);
    for (let i = 0; i < 5; i++) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.05), MAT.shaft);
      rung.position.y = -0.5 + i * 0.28;
      g.add(rung);
    }
  } else { // pickaxe
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 4), MAT.shaft);
    const headM = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.08), MAT.flint);
    headM.position.y = 0.5; headM.rotation.z = 0.18;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 4), MAT.flint);
    spike.position.set(0, 0.5, 0.18); spike.rotation.x = Math.PI / 2;
    g.add(haft, headM, spike);
  }
  g.rotation.x = Math.PI * 0.5;
  return g;
}

// ---- Landmarks & scenery (low-poly, cheap, static) ----
const LM = {
  rock: new THREE.MeshStandardMaterial({ color: 0x7d7a72, roughness: 1, flatShading: true }),
  rockDark: new THREE.MeshStandardMaterial({ color: 0x5b594f, roughness: 1, flatShading: true }),
  snow: new THREE.MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.6, flatShading: true }),
  ore: new THREE.MeshStandardMaterial({ color: 0x9aa6b4, roughness: 0.55, metalness: 0.4, emissive: 0x10131a, flatShading: true }),
  water: new THREE.MeshStandardMaterial({ color: 0x2f6f9e, roughness: 0.25, metalness: 0.2, transparent: true, opacity: 0.78 }),
  reed: new THREE.MeshStandardMaterial({ color: 0x5f7d3a, roughness: 0.8 }),
  deadwood: new THREE.MeshStandardMaterial({ color: 0x5a4d3b, roughness: 1, flatShading: true }),
  shroom: new THREE.MeshStandardMaterial({ color: 0xc4503f, roughness: 0.6, emissive: 0x200, flatShading: true })
};

// A peak of stacked rocky cones with a snow cap; returns its blocking radius.
export function makeMountain(rng, h = 16) {
  const g = new THREE.Group();
  const tiers = 4;
  let r = 9 + rng.range(0, 4);
  for (let i = 0; i < tiers; i++) {
    const ch = h * (0.42 - i * 0.07);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch + h * 0.3, 6),
      i === tiers - 1 ? LM.snow : (i % 2 ? LM.rockDark : LM.rock));
    cone.position.y = i * (h * 0.22);
    cone.rotation.y = rng.range(0, Math.PI);
    cone.castShadow = true; cone.receiveShadow = true;
    g.add(cone);
    r *= 0.66;
  }
  g.userData.blockR = 9 + rng.range(0, 4);
  return g;
}

export function makeOre(rng) {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + rng.range(0, 0.5), 0), LM.rock);
  rock.rotation.set(rng(), rng(), rng());
  rock.castShadow = true;
  g.add(rock);
  for (let i = 0; i < 4; i++) {
    const v = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), LM.ore);
    v.position.set(rng.range(-0.6, 0.6), rng.range(0.1, 0.8), rng.range(-0.6, 0.6));
    g.add(v);
  }
  return g;
}

export function makeBoulder(rng) {
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 + rng.range(0, 0.9), 0), LM.rock);
  m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
  m.castShadow = true;
  return m;
}

export function makeLake(rng, r) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 18), LM.water);
  disc.rotation.x = -Math.PI / 2;
  g.add(disc);
  const n = Math.floor(r * 1.4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const reed = new THREE.Mesh(new THREE.ConeGeometry(0.08, 1.1 + rng.range(0, 0.6), 4), LM.reed);
    reed.position.set(Math.sin(a) * (r - 0.4), 0.55, Math.cos(a) * (r - 0.4));
    g.add(reed);
  }
  return g;
}

export function makeFlowerPatch(rng) {
  const g = new THREE.Group();
  const cols = [0xff5a8a, 0xffd23f, 0x9b6bff, 0xff8a3a];
  for (let i = 0; i < 7; i++) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 3), LM.reed);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0),
      new THREE.MeshStandardMaterial({ color: cols[i % 4], emissive: 0x110, flatShading: true }));
    head.position.y = 0.26;
    const f = new THREE.Group(); f.add(stem, head);
    f.position.set(rng.range(-0.9, 0.9), 0.2, rng.range(-0.9, 0.9));
    g.add(f);
  }
  return g;
}

export function makeDeadTree(rng) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 2.4 + rng.range(0, 1), 5), LM.deadwood);
  trunk.position.y = 1.3; trunk.castShadow = true;
  g.add(trunk);
  for (let i = 0; i < 4; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.0, 4), LM.deadwood);
    br.position.y = 1.6 + i * 0.3;
    br.rotation.z = (i % 2 ? 1 : -1) * (0.7 + rng.range(0, 0.4));
    g.add(br);
  }
  return g;
}

export function makeMushroomRing(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2), LM.shroom);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.22, 4),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.8 }));
    const s = new THREE.Group(); cap.position.y = 0.22; stem.position.y = 0.11;
    s.add(stem, cap);
    s.position.set(Math.sin(a) * 1.1, 0, Math.cos(a) * 1.1);
    g.add(s);
  }
  return g;
}

// A low-poly quadruped: wedge body, snout, four legs, a triangular tail.
export class Animal {
  constructor(world, rng, x, z, herd, kind = 'herbivore', species = null) {
    this.world = world;
    this.rng = rng;
    this.herd = herd;
    this.kind = kind;
    this.predator = kind === 'wolf';
    this.horse = kind === 'horse';
    this.tamed = false;
    this.ownerEntity = null;
    if (kind === 'herbivore' && !species) species = Animal.pickSpecies(rng);
    this.species = this.predator ? 'wolf' : this.horse ? 'horse' : species;
    const sp = (this.predator || this.horse) ? null : CONFIG.nature.species[species];
    const L = CONFIG.logistics;
    this.alive = true;
    this.health = this.predator ? CONFIG.predator.health : this.horse ? L.horseHealth : sp.health;
    this.speed = this.predator ? CONFIG.predator.speed : this.horse ? L.horseSpeed : sp.speed;
    this.food = this.predator ? CONFIG.predator.health : this.horse ? L.horseFood : sp.food;
    this.gore = sp?.gore ?? 0;
    this.home = new THREE.Vector2(x, z);
    this.pos = new THREE.Vector3(x, world.heightAt(x, z), z);
    this.vel = new THREE.Vector3();
    this.heading = rng.range(-Math.PI, Math.PI);
    this._wanderT = 0;
    this._strikeCd = 0;

    const g = new THREE.Group();
    const scale = this.predator ? 0.78 : this.horse ? 1.15 : sp.scale;
    const hide = this.predator ? MAT.wolf
      : this.horse ? Animal._hideMat(0x6b4a2a) : Animal._hideMat(sp.color);
    const dark = this.predator ? MAT.wolfDark : MAT.hideDark;
    const body = new THREE.Mesh(ANIMAL_BODY, hide);
    body.position.y = 0.95;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.6, 5), hide);
    head.rotation.z = -Math.PI / 2;
    head.position.set(0.95, this.predator ? 0.95 : 1.05, 0);
    const snout = new THREE.Mesh(ANIMAL_SNOUT, dark);
    snout.rotation.z = -Math.PI / 2;
    snout.position.set(1.3, this.predator ? 0.85 : 1.0, 0);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 4), dark);
    tail.position.set(-0.78, 1.05, 0);
    tail.rotation.z = this.predator ? Math.PI / 1.8 : Math.PI / 2.4;
    g.add(body, head, snout, tail);
    if (this.predator) {
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 4), hide);
        ear.position.set(0.95, 1.3, sx * 0.13);
        g.add(ear);
      }
    }
    for (const [lx, lz] of [[0.5, 0.28], [0.5, -0.28], [-0.5, 0.28], [-0.5, -0.28]]) {
      const leg = new THREE.Mesh(GEO.leg, dark);
      leg.position.set(lx, 0.35, lz);
      leg.castShadow = true;
      g.add(leg);
    }
    g.scale.setScalar(scale);
    g.position.copy(this.pos);
    this.mesh = g;
    world.scene.add(g);
  }

  static pickSpecies(rng) {
    const sp = CONFIG.nature.species;
    const total = Object.values(sp).reduce((s, v) => s + v.weight, 0);
    let r = rng() * total;
    for (const [name, v] of Object.entries(sp)) { if ((r -= v.weight) <= 0) return name; }
    return 'deer';
  }

  static _hideMat(color) {
    Animal._hideCache ??= new Map();
    let m = Animal._hideCache.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true });
      Animal._hideCache.set(color, m);
    }
    return m;
  }

  _applyMove(speed, dt) {
    this.pos.x += Math.sin(this.heading) * speed * dt;
    this.pos.z += Math.cos(this.heading) * speed * dt;
    const lim = this.world.size * 0.97;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
    this.pos.y = this.world.heightAt(this.pos.x, this.pos.z);
    this.mesh.position.copy(this.pos);
    // Body's head is +X; movement forward is (sin h, cos h) — so the mesh
    // must yaw to heading - 90° (the old +90° pointed it backwards).
    this.mesh.rotation.y = this.heading - Math.PI / 2;
    this.mesh.position.y += Math.abs(Math.sin(performance.now() * 0.006 + this.pos.x)) *
      0.05 * (speed > 1 ? 1 : 0.2);
  }

  // Penned livestock: graze calmly, never flee, stay near the paddock.
  grazeUpdate(dt, center, radius) {
    if (!this.alive) return;
    this._wanderT -= dt;
    const far = Math.hypot(this.pos.x - center.x, this.pos.z - center.z) > radius * 0.8;
    if (this._wanderT <= 0 || far) {
      this._wanderT = this.rng.range(2, 5);
      this.heading = far
        ? Math.atan2(center.x - this.pos.x, center.z - this.pos.z)
        : this.heading + this.rng.range(-1.2, 1.2);
    }
    this._applyMove(this.speed * 0.3, dt);
  }

  // Ridden: the horse IS where its rider is, moving as one mount.
  rideUpdate(owner) {
    if (!this.alive) return;
    this.pos.x = owner.pos.x;
    this.pos.z = owner.pos.z;
    this.pos.y = owner.pos.y;
    this.heading = owner.heading;
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = this.heading - Math.PI / 2;
  }

  // Predator: stalk the supplied quarry (prey animal or vulnerable agent);
  // returns true while in striking range so the world can resolve a bite.
  predatorUpdate(dt, quarryPos, quarryDist) {
    if (!this.alive) return false;
    this._strikeCd = Math.max(0, this._strikeCd - 1);
    if (quarryPos) {
      this.heading = Math.atan2(quarryPos.x - this.pos.x, quarryPos.z - this.pos.z);
      this._applyMove(CONFIG.predator.speed * (quarryDist < CONFIG.predator.attackRadius ? 0.2 : 1), dt);
      return quarryDist < CONFIG.predator.attackRadius;
    }
    this._wanderT -= dt;
    if (this._wanderT <= 0) {
      this._wanderT = this.rng.range(1.5, 3.5);
      this.heading += this.rng.range(-1.4, 1.4);
    }
    this._applyMove(CONFIG.predator.speed * 0.4, dt);
    return false;
  }

  // Graze near the herd home; bolt away from the nearest agent that comes
  // within flee range. Animals never path globally — purely local.
  update(dt, nearestAgentDist, nearestAgentPos) {
    if (!this.alive) return;
    const C = CONFIG.nature;
    let speed = this.speed * 0.35;
    if (nearestAgentPos && nearestAgentDist < C.animalFleeRadius) {
      const away = new THREE.Vector3().subVectors(this.pos, nearestAgentPos).setY(0).normalize();
      this.heading = Math.atan2(away.x, away.z);
      speed = this.speed;
    } else {
      this._wanderT -= dt;
      if (this._wanderT <= 0) {
        this._wanderT = this.rng.range(1.5, 4);
        const toHome = Math.atan2(this.home.x - this.pos.x, this.home.y - this.pos.z);
        const far = this.pos.distanceTo(new THREE.Vector3(this.home.x, this.pos.y, this.home.y)) > C.animalWanderRadius;
        this.heading = far ? toHome : this.heading + this.rng.range(-1.2, 1.2);
      }
    }
    this._applyMove(speed, dt);
  }

  hurt(dmg) {
    this.health -= dmg;
    if (this.health <= 0) { this.alive = false; return true; }
    return false;
  }

  // Lets agents fight animals/wolves with the same code path as melee
  // against other agents (a downed beast becomes a carcass).
  damage(amount) {
    if (this.hurt(amount)) { this.world.dropCarcass(this.pos, this.food); return true; }
    return false;
  }

  remove() {
    this.world.scene.remove(this.mesh);
    this.mesh.traverse((o) => o.geometry && !Object.values(GEO).includes(o.geometry) &&
      o.geometry !== ANIMAL_BODY && o.geometry !== ANIMAL_SNOUT && o.geometry.dispose());
  }
}

export { MAT as NATURE_MAT };
