import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createHumanoid } from './humanoid.js';
import { clamp } from './rng.js';

// A small explorable room rendered in place of the world when the player
// walks into a building. Each structure type has its own layout and
// clickable props: storehouse shelves (store / retrieve), a watchtower
// you climb and fire a bow from, a house where kin gather to talk.
const M = {
  floor: new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.95 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x6a5740, roughness: 0.9, side: THREE.DoubleSide }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.85 }),
  shelf: new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.8, emissive: 0x140d04 }),
  crate: new THREE.MeshStandardMaterial({ color: 0xb98a4a, roughness: 0.85 }),
  fire: new THREE.MeshStandardMaterial({ color: 0xff7a2f, emissive: 0xff5a1f, emissiveIntensity: 1.4 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8d8576, roughness: 0.95, side: THREE.DoubleSide })
};

export class Interior {
  constructor(struct, player, world) {
    this.struct = struct;
    this.player = player;
    this.world = world;
    this.type = struct.type;
    this.props = [];                       // clickable meshes
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.FogExp2(0x0a0c12, 0.02);

    this.scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x20160e, 0.5));
    const lamp = new THREE.PointLight(0xffd9a0, 1.2, 40);
    lamp.position.set(0, 5, 0);
    this.scene.add(lamp);
    this.lamp = lamp;

    // Half-extent the player may walk within; eye height for the camera.
    this.bound = 5.5;
    this.eye = 1.7;
    this.openSky = false;

    ({ house: () => this._house(),
       storehouse: () => this._storehouse(),
       tower: () => this._tower(),
       center: () => this._center()
    }[this.type] ?? (() => this._center()))();

    if (!this.openSky) this._shell();
  }

  _shell() {
    const s = this.bound + 1;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(s * 2, s * 2), M.floor);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const ceil = floor.clone(); ceil.position.y = 5.2; ceil.rotation.x = Math.PI / 2;
    this.scene.add(ceil);
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(s * 2, 5.2), M.wall);
      w.position.y = 2.6;
      if (i === 0) { w.position.z = -s; }
      else if (i === 1) { w.position.z = s; w.rotation.y = Math.PI; }
      else if (i === 2) { w.position.x = -s; w.rotation.y = Math.PI / 2; }
      else { w.position.x = s; w.rotation.y = -Math.PI / 2; }
      this.scene.add(w);
    }
  }

  _addProp(mesh, action, label) {
    mesh.userData.action = action;
    mesh.userData.label = label;
    this.props.push(mesh);
    this.scene.add(mesh);
    return mesh;
  }

  _house() {
    // A hearth, and kin standing around it to talk to.
    const hearth = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.5, 7), M.stone);
    hearth.position.set(0, 0.25, -3);
    this.scene.add(hearth);
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 6), M.fire);
    fire.position.set(0, 1.0, -3);
    this.scene.add(fire);
    this._fire = fire;
    this.lamp.position.set(0, 2.5, -2);
    this.lamp.color.setHex(0xff9a4a);

    const kinIds = [...this.player.kin].slice(0, 4);
    const spots = [[-2.5, 1.5], [2.5, 1.5], [-1.6, -1], [1.8, -1.2]];
    kinIds.forEach((id, i) => {
      const [x, z] = spots[i] ?? [i, 2];
      const fig = createHumanoid(this.player.tribeColor.clone());
      fig.scale.setScalar(0.9);
      fig.position.set(x, 0, z);
      fig.rotation.y = Math.atan2(-x, 3 + z);
      fig.userData.groundY = 0;
      this._addProp(fig, { kind: 'talk', kinId: id }, `Talk to kin #${id}`);
    });
    if (!kinIds.length) {
      const fig = createHumanoid(this.player.tribeColor.clone());
      fig.position.set(0, 0, 1.5);
      fig.userData.groundY = 0;
      this._addProp(fig, { kind: 'talk' }, 'Sit by the fire');
    }
  }

  _storehouse() {
    this.lamp.color.setHex(0xffe0b0);
    // Two food shelves + a wood crate stack, all clickable.
    for (let i = 0; i < 2; i++) {
      const rack = new THREE.Group();
      for (let s = 0; s < 3; s++) {
        const board = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.16, 1.1), M.shelf);
        board.position.y = 0.8 + s * 1.1;
        rack.add(board);
        for (let j = 0; j < 4; j++) {
          const sack = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), M.crate);
          sack.position.set(-1.3 + j * 0.85, 0.8 + s * 1.1 + 0.32, 0);
          rack.add(sack);
        }
      }
      rack.position.set(i ? 3.6 : -3.6, 0, -3.4);
      this._addProp(rack, { kind: 'food' }, 'Food store — click to deposit/withdraw');
    }
    const crates = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), M.crate);
      c.position.set((i % 2) * 1.0 - 0.5, 0.45 + Math.floor(i / 2) * 0.92, 3.4);
      crates.add(c);
    }
    this._addProp(crates, { kind: 'wood' }, 'Wood pile — click to deposit/withdraw');
  }

  _tower() {
    // We're up on the parapet: open sky, low crenellated wall, shoot out.
    this.openSky = true;
    this.scene.background = new THREE.Color(0x6f93c8);
    this.scene.fog = new THREE.FogExp2(0x6f93c8, 0.008);
    this.scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x4a4030, 0.95));
    const sun = new THREE.DirectionalLight(0xffe7c4, 1.0);
    sun.position.set(20, 30, 10); this.scene.add(sun);
    this.bound = 2.2; this.eye = 2.0;

    const deck = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.5, 8), M.stone);
    deck.position.y = -0.25; this.scene.add(deck);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const merl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.5), M.stone);
      merl.position.set(Math.sin(a) * 3, 0.55, Math.cos(a) * 3);
      merl.rotation.y = -a;
      this.scene.add(merl);
    }
    // Distant low-poly hills so the height reads.
    for (let i = 0; i < 14; i++) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(6 + i % 4 * 2, 5, 5),
        new THREE.MeshStandardMaterial({ color: 0x3f5640, roughness: 1 }));
      const a = (i / 14) * Math.PI * 2;
      h.position.set(Math.sin(a) * 60, -6, Math.cos(a) * 60);
      this.scene.add(h);
    }
  }

  _center() {
    this.lamp.color.setHex(0xffe0b0);
    const table = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.3, 8), M.wood);
    table.position.y = 1.0; this.scene.add(table);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 5), M.wood);
    pole.position.set(0, 2.6, -3.5); this.scene.add(pole);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.2),
      new THREE.MeshStandardMaterial({ color: this.player.tribeColor.clone(), side: THREE.DoubleSide }));
    banner.position.set(0.9, 3.3, -3.5);
    this._addProp(banner, { kind: 'rally' }, 'Tribe banner — rally your clan');
  }

  // Resolve a click on a prop. Returns a short feedback string.
  interact(obj) {
    let o = obj;
    while (o && !o.userData.action && o.parent) o = o.parent;
    const act = o?.userData?.action;
    if (!act) return null;
    const pl = this.player;
    const SP = CONFIG.stockpile;

    if (act.kind === 'food') {
      const store = this.struct.store;
      if (!store) return 'Nothing to store here.';
      // Hungry? take a meal. Well-fed? bank some of your surplus.
      if (pl.energy < 60 && store.food > 1) {
        const take = Math.min(store.food, CONFIG.entity.maxEnergy - pl.energy, 30);
        store.food -= take;
        pl.energy = clamp(pl.energy + take, 0, CONFIG.entity.maxEnergy);
        return `Took ${Math.round(take)} food (granary now ${Math.round(store.food)}).`;
      }
      if (pl.energy >= 60) {
        const give = Math.min(SP.depositChunk, pl.energy - 45);
        pl.energy -= give; store.food += give;
        return `Stored ${Math.round(give)} food (granary now ${Math.round(store.food)}).`;
      }
      return 'The shelves are bare — and you have nothing to spare.';
    }
    if (act.kind === 'wood') {
      const store = this.struct.store;
      if (!store) return 'Nothing to store here.';
      if (pl.wood > 0) { store.wood += pl.wood; const w = pl.wood; pl.wood = 0; return `Stored ${w} wood (pile: ${store.wood}).`; }
      if (store.wood > 0) { const t = Math.min(4, store.wood); store.wood -= t; pl.wood += t; return `Took ${t} wood (pile: ${store.wood}).`; }
      return 'No wood here, and none on you.';
    }
    if (act.kind === 'talk') {
      const e = act.kinId != null && this.world.entities
        ? this.world.entities.find((x) => x.id === act.kinId && x.alive) : null;
      if (e) {
        pl.social.cooperate(e.id); e.social.cooperate(pl.id);
        e.social.familiar(pl.id); pl.social.familiar(e.id);
        return `You share news with kin #${e.id}. Trust deepens.`;
      }
      return 'You rest a moment by the fire. Energy eases.';
    }
    if (act.kind === 'rally') {
      pl.signal = { type: 'RALLY', tick: this.world.tickNow ?? 0 };
      return 'You raise the banner — your clan will rally to you.';
    }
    return null;
  }

  // Fire a bow out over the battlements (tower only).
  shootOut(dir) {
    if (this.type !== 'tower') return 'You can only shoot from the tower.';
    if (!this.player.tool || !(CONFIG.tools[this.player.tool.type]?.ranged)) {
      return 'You need a bow to shoot from here.';
    }
    const top = new THREE.Vector3(this.struct.pos.x, this.struct.pos.y + 6, this.struct.pos.z);
    const r = CONFIG.tools[this.player.tool.type].ranged;
    this.world.spawnProjectile(top, dir, r.dmg * 1.3, this.player, 'arrow', r.speed * 1.2);
    if (--this.player.tool.dur <= 0) this.player.tool = null;
    return 'You loose an arrow over the wall.';
  }

  update(dt) {
    if (this._fire) {
      const s = 0.85 + Math.sin(performance.now() * 0.012) * 0.18;
      this._fire.scale.set(1, s, 1);
      this.lamp.intensity = 1.0 + s * 0.5;
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material])
        .forEach((m) => { if (!Object.values(M).includes(m)) m.dispose?.(); });
    });
  }
}
