import * as THREE from 'three';
import { CONFIG } from './config.js';

// Persistent physical world: procedurally generated terrain, scarce
// regrowing resources, and player-built structures that endure and
// reshape navigation/visibility.
export class World {
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.size = CONFIG.world.size;
    this.resources = [];
    this.structures = [];

    // Two octaves of value-ish noise baked from the seeded RNG, so the
    // terrain is reproducible and height is cheap to sample analytically.
    this.n1 = { fx: rng.range(0.02, 0.05), fz: rng.range(0.02, 0.05), px: rng() * 9, pz: rng() * 9 };
    this.n2 = { fx: rng.range(0.08, 0.13), fz: rng.range(0.08, 0.13), px: rng() * 9, pz: rng() * 9 };

    this._buildLighting();
    this._buildTerrain();
    this._seedResources();
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

  _seedResources() {
    for (let i = 0; i < CONFIG.world.resourceCount; i++) this._spawnResource();
  }

  _spawnResource() {
    const r = this.size * 0.92;
    const x = this.rng.range(-r, r);
    const z = this.rng.range(-r, r);
    const y = this.heightAt(x, z);
    const geo = new THREE.IcosahedronGeometry(0.7, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4fd28a, emissive: 0x123, roughness: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + 0.7, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.resources.push({ pos: new THREE.Vector3(x, y + 0.7, z), mesh, available: true, regrowAt: 0 });
  }

  consumeResource(res, tick) {
    res.available = false;
    res.regrowAt = tick + CONFIG.world.resourceRegrowTicks;
    res.mesh.visible = false;
    return CONFIG.world.resourceEnergy;
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

  update(tick) {
    for (const res of this.resources) {
      if (!res.available && tick >= res.regrowAt) {
        res.available = true;
        res.mesh.visible = true;
      }
    }
  }
}
