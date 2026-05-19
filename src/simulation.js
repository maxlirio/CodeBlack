import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';
import { World } from './world.js';
import { Entity } from './entity.js';
import { Evolution } from './evolution.js';
import { inheritTraits } from './personality.js';
import { recomputeTribes } from './tribes.js';
import { Interior } from './interior.js';

// Owns the renderer, the fixed-tick simulation loop, and the UI. Physics,
// movement, perception, animation-state and decisions all advance on the
// same fixed interval; rendering interpolates between ticks.
export class Simulation {
  constructor(mount, seed) {
    this.mount = mount;
    this.seed = seed >>> 0;
    this.running = true;
    this.speed = 1;
    this.tickCount = 0;
    this.selected = null;
    this.acc = 0;
    this.mode = 'free';          // 'free' (WASD) | 'follow' | 'play'
    this.player = null;          // entity the human is controlling
    this.keys = new Set();
    this._attackQueued = false;  // a click / Space press waiting to resolve
    this._placing = false;       // build-placement ghost active
    this._ghost = null;
    this._buildOrder = null;
    this._initRenderer();
    this._initScene();
    this._bindUI();
    this._bindInput();
    this._last = performance.now();
    requestAnimationFrame(this._frame);
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.mount.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.5, 600);
    this.camera.position.set(0, 70, 95);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.maxDistance = 240;
    this.controls.minDistance = 6;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.ray = new THREE.Raycaster();
    this._mouseNDC = { x: 0, y: 0 };
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      this._mouseNDC.x = (e.clientX / innerWidth) * 2 - 1;
      this._mouseNDC.y = -(e.clientY / innerHeight) * 2 + 1;
      // In world play / tower the mouse turns the head; indoors it is a
      // free cursor for clicking objects (no camera spin, no hidden mouse).
      if (this.mode === 'play' && !this.interior) {
        this._camYaw -= (e.movementX || 0) * 0.0035;
        this._camPitch = Math.min(1.35, Math.max(0.12,
          this._camPitch + (e.movementY || 0) * 0.0028));
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.mode === 'play') {
        if (this.interior) this._interiorClick(e);
        else if (this._placing) this._confirmPlacing();
        else this._attackQueued = true;
      } else this._pick(e);
    });
  }

  // Inside a building: a click works the prop under the crosshair
  // (shelves, kin, banner).
  _interiorClick() {
    const it = this.interior;
    this._cgRay ??= new THREE.Raycaster();
    this._cgRay.setFromCamera(this._mouseNDC, this.camera); // click where the cursor is
    const hit = this._cgRay.intersectObjects(it.props, true)[0];
    const msg = hit ? it.interact(hit.object) : 'Nothing there — click an object.';
    this._flash(msg);
  }

  _flash(text) {
    const el = this.ui?.interiorMsg;
    if (!el) return;
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  // WASD/QE free-fly until you click a villager (then the camera follows);
  // pressing a movement key drops follow back to free flight.
  _bindInput() {
    const MOVE = new Set(['w', 'a', 's', 'd', 'q', 'e']); // WASD/QE only
    const ARROWS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown']);
    this._buildSel = 'house';
    this._buildRot = 0;
    this._craftSel = 'sword';
    const BUILD_KEYS = { 1: 'house', 2: 'wall', 3: 'storehouse', 4: 'tower', 5: 'center', 6: 'gate' };
    const CRAFT_KEYS = { 7: 'sword', 8: 'bow', 9: 'pickaxe', 0: 'ladder' };
    const isSpace = (k) => k === ' ' || k === 'spacebar';
    addEventListener('keydown', (ev) => {
      const k = ev.key.toLowerCase();
      const fresh = !this.keys.has(k);
      this.keys.add(k);
      if (this.mode === 'follow' && MOVE.has(k)) this._setMode('free');
      if (this.mode === 'play') {
        const inside = this.interior || this.towerPerch;
        if (k === 'escape') {
          if (this._placing) this._cancelPlacing();
          else if (inside) this._exitInterior();
          else this._exitPlay();
        } else if (k === 'r' && fresh) {
          inside ? this._exitInterior() : this._enterInterior();
        } else if (inside) { /* look/move only */ }
        else if (this._placing && ARROWS.has(k)) {
          // Arrow keys spin the structure you're positioning.
          this._buildRot += (k === 'arrowright' || k === 'arrowdown') ? -0.26 : 0.26;
        } else {
          if (BUILD_KEYS[k]) { this._buildSel = BUILD_KEYS[k]; if (this._placing) this._makeGhost(); }
          if (CRAFT_KEYS[k]) this._craftSel = CRAFT_KEYS[k];
          if (k === 'b' && fresh) this._togglePlacing();
          // Space = attack (same as a mouse click); auto ranged or melee.
          if (isSpace(k) && fresh && !this._placing) this._attackQueued = true;
        }
        ev.preventDefault();
      }
    });
    addEventListener('keyup', (ev) => this.keys.delete(ev.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());

    // Camera-look state (driven by the pointermove handler in _initRenderer).
    this._camYaw = Math.PI;
    this._camPitch = 0.42;
    this._camDist = 9;
    addEventListener('wheel', (ev) => {
      if (this.mode !== 'play') return;
      this._camDist = Math.min(16, Math.max(4, this._camDist + Math.sign(ev.deltaY)));
    }, { passive: true });
  }

  _setMode(mode) {
    this.mode = mode;
    const c = this.controls;
    if (mode === 'free') {
      c.enablePan = true; c.enabled = true; c.minDistance = 6; c.maxDistance = 240;
    } else if (mode === 'follow') {
      c.enablePan = false; c.enabled = true; c.minDistance = 6; c.maxDistance = 120;
    } else if (mode === 'play') {
      c.enabled = false; // hand the camera to our collision-aware rig
    }
    this._syncModeUI();
  }

  _enterPlay() {
    if (!this.selected || !this.selected.alive) return;
    this.player = this.selected;
    this.player.controller = (self, p) => this._playerChoice(self, p);
    this._setMode('play');
  }

  _exitPlay() {
    if (this.interior || this.towerPerch) this._exitInterior();
    this.towerPerch = null;
    if (this._ghost) { this.scene.remove(this._ghost); this._ghost = null; }
    this._placing = false;
    this._buildOrder = null;
    if (this.player) this.player.controller = null;
    this.player = null;
    this._attackQueued = false;
    this._setMode(this.selected && this.selected.alive ? 'follow' : 'free');
  }

  // Enter the nearest building of YOUR OWN tribe you're standing at.
  // A watchtower is a vantage point in the world, not a separate room.
  _enterInterior() {
    const pl = this.player;
    if (!pl) return;
    // "Yours" via robust, churn-proof ownership: you built it, a kinsman
    // built it, it flies your tribe's tag, OR its builder is a living
    // member of your tribe right now (tribe ids drift after captures, so
    // we trust the owner's *current* allegiance, not the frozen tag).
    const byId = new Map(this.entities.filter((e) => e.alive).map((e) => [e.id, e]));
    const mine = (st) => {
      if (st.owner === pl.id || pl.kin.has(st.owner) || st.tribe === pl.tribeId) return true;
      const o = byId.get(st.owner);
      return !!o && (o.tribeId === pl.tribeId || o.id === pl.id);
    };
    let near = null, nd = 6;
    for (const st of this.world.structures) {
      if (st.type === 'wall' || st.type === 'gate' || st.type === 'ram') continue;
      if (!mine(st)) continue;
      const d = Math.hypot(st.pos.x - pl.pos.x, st.pos.z - pl.pos.z);
      if (d < nd) { nd = d; near = st; }
    }
    if (!near) { this._flash('Stand right next to one of your own tribe’s buildings, then press R.'); return; }
    if (near.type === 'tower') {
      this.towerPerch = near;     // climb up — stay in the world, just high
      this._syncModeUI();
      this._flash('Climbed the watchtower. Look around · click/Space to shoot · R / Esc to come down.');
      return;
    }
    this.interior = new Interior(near, pl, this.world);
    this._intPos = new THREE.Vector3(0, 0, this.interior.bound * 0.6);
    this._syncModeUI();
    this._flash(`Entered ${near.type}. Mouse looks · click to use · R / Esc to leave.`);
  }

  _exitInterior() {
    if (this.towerPerch) { this.towerPerch = null; this._syncModeUI(); return; }
    if (!this.interior) return;
    this.interior.dispose();
    this.interior = null;
    this._syncModeUI();
  }

  // ---- Click-to-place building ----
  static FOOTPRINT = {
    house: [2.6, 2.6], wall: [4.2, 1.0], gate: [3.4, 1.4], storehouse: [4, 4],
    tower: [3, 3], center: [6, 6]
  };

  _togglePlacing() {
    if (this._placing) return this._cancelPlacing();
    this._placing = true;
    this._buildRot = 0;
    this._buildOrder = null;
    this._makeGhost();
    this._flash(`Placing ${this._buildSel} — point with the mouse, ←/→ rotate, click to set (1-6 type, Esc cancels).`);
  }

  _cancelPlacing() {
    this._placing = false;
    if (this._ghost) { this.scene.remove(this._ghost); this._ghost = null; }
    this._flash('Placement cancelled.');
  }

  _makeGhost() {
    if (this._ghost) this.scene.remove(this._ghost);
    const [w, d] = Simulation.FOOTPRINT[this._buildSel] ?? [2.6, 2.6];
    const box = new THREE.BoxGeometry(w, 3, d);
    this._ghost = new THREE.LineSegments(new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xffffff }));
    this._ghost.renderOrder = 999;
    this.scene.add(this._ghost);
  }

  _groundAhead() {
    this._cgRay ??= new THREE.Raycaster();
    this._cgRay.setFromCamera(this._mouseNDC, this.camera); // place under the cursor
    const hit = this._cgRay.intersectObject(this.world.terrain, false)[0];
    if (hit) return hit.point;
    // Fallback: project forward from the player onto the terrain height.
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f); f.y = 0; f.normalize();
    const px = this.player.pos.x + f.x * 6, pz = this.player.pos.z + f.z * 6;
    return new THREE.Vector3(px, this.world.heightAt(px, pz), pz);
  }

  _updateGhost() {
    if (!this._ghost || !this.player) return;
    const g = this._groundAhead();
    this._ghost.position.set(g.x, g.y + 1.5, g.z);
    this._ghost.rotation.y = this._buildRot;
    const blocked = this.world.countStructures(g.x, g.z, 'wall', 2) +
      this.world.countStructures(g.x, g.z, 'house', 2.5) > 0;
    this._ghost.material.color.setHex(blocked ? 0xff5a5a : 0xffffff);
  }

  _confirmPlacing() {
    if (!this.player) return;
    const g = this._groundAhead();
    this._buildOrder = { type: this._buildSel, x: g.x, z: g.z, rot: this._buildRot };
    this._placing = false;
    if (this._ghost) { this.scene.remove(this._ghost); this._ghost = null; }
    this._flash(`Walking over to build a ${this._buildSel}.`);
  }

  // Translate live keyboard state into the same choice objects the utility
  // AI produces, so the agent executes player intent through identical code.
  _playerChoice(self, p) {
    // Inside a building, or perched up the tower, the body stays put.
    if (this.interior || this.towerPerch) {
      // From the tower you can still shoot down at the field below.
      if (this.towerPerch && this._attackQueued && (self._rangedReach?.() ?? 0) > 0) {
        this._attackQueued = false;
        const f = new THREE.Vector3();
        this.camera.getWorldDirection(f);
        return { action: 'SHOOT', aim: { x: f.x, z: f.z }, power: 1 };
      }
      this._attackQueued = false;
      return { action: 'IDLE' };
    }
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    // Camera-right = forward x up  →  (-fz, 0, fx). The old (fz,0,-fx)
    // was the negation, which swapped A/D (left ↔ right).
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const K = this.keys;
    const dir = new THREE.Vector3();
    if (K.has('w')) dir.add(fwd);
    if (K.has('s')) dir.sub(fwd);
    if (K.has('d')) dir.add(right);
    if (K.has('a')) dir.sub(right);

    // A confirmed build order: walk to the chosen spot and raise it there.
    if (this._buildOrder) {
      const o = this._buildOrder;
      const done = this.world.countStructures(o.x, o.z, o.type, 3.5) > 0;
      if (done) { this._buildOrder = null; this._flash(`${o.type} built.`); }
      else return { action: 'BUILD', build: o.type, spot: { x: o.x, z: o.z }, facing: o.rot, force: true };
    }
    // While positioning a building, movement still works but no attacks.
    if (this._placing) {
      if (dir.lengthSq() > 1e-4) return { action: 'PLAYER_MOVE', dir: { x: dir.x, z: dir.z }, run: K.has('shift') };
      return { action: 'IDLE' };
    }

    // --- Combat: one button (click or Space) that just works ---
    // It auto-resolves: if you carry a bow/spear and a target is within
    // ranged reach roughly in the crosshair, you shoot it; otherwise you
    // melee-strike the nearest thing you're facing; otherwise a swing.
    if (this._attackQueued) {
      this._attackQueued = false;
      const facing = (pos, loose = 0.0) => {
        const dx = pos.x - self.pos.x, dz = pos.z - self.pos.z;
        const L = Math.hypot(dx, dz) || 1;
        return (dx / L) * fwd.x + (dz / L) * fwd.z > loose;
      };
      const reach = self._rangedReach?.() ?? 0;
      if (reach > 0 && self._shootCd <= 0) {
        let best = null, bestDot = Math.cos(CONFIG.projectile.autoAimCone);
        const cands = [
          ...p.animals.map((a) => a.animal),
          ...p.entities.filter((e) => e.entity.tribeId !== self.tribeId &&
            !self.kin.has(e.entity.id)).map((e) => e.entity)
        ];
        for (const c of cands) {
          const dx = c.pos.x - self.pos.x, dz = c.pos.z - self.pos.z;
          const L = Math.hypot(dx, dz) || 1;
          if (L > reach) continue;
          const dot = (dx / L) * fwd.x + (dz / L) * fwd.z;
          if (dot > bestDot) { bestDot = dot; best = { x: dx, z: dz }; }
        }
        // Fire at the locked target, or just straight ahead.
        return { action: 'SHOOT', aim: best ?? { x: fwd.x, z: fwd.z }, power: 1 };
      }
      const foe = p.entities.find((e) => e.entity.tribeId !== self.tribeId &&
        !self.kin.has(e.entity.id) && e.dist < 7 && facing(e.entity.pos));
      const wolf = p.animals.find((a) => a.animal.predator && a.dist < 8 && facing(a.animal.pos));
      const prey = p.animals.find((a) => !a.animal.predator && !a.animal.horse && a.dist < 8 && facing(a.animal.pos));
      const es = p.structures.find(({ st, dist }) => st.tribe != null &&
        st.tribe !== self.tribeId && dist < 7 && facing(st.pos));
      if (foe) return { action: 'ATTACK', victim: foe.entity, target: foe.entity.pos };
      if (wolf) return { action: 'DEFEND', victim: wolf.animal, target: wolf.animal.pos };
      if (prey) return { action: 'HUNT', animal: prey.animal, target: prey.animal.pos };
      if (es) return { action: 'RAID', struct: es.st, target: es.st.pos };
      return { action: 'PLAYER_STRIKE' }; // a swing at empty air
    }
    if (K.has('g')) return { action: 'FORTIFY' };
    if (K.has('f')) return { action: 'FARM' };
    if (K.has('c')) return { action: 'CRAFT', craftType: this._craftSel };
    if (K.has('e')) {
      const tr = p.trees[0];
      const food = p.resources[0];
      const ore = p.ores[0];
      const store = p.structures.find(({ st }) => st.type === 'storehouse');
      if (food && food.dist < CONFIG.entity.eatRadius) return { action: 'EAT', target: food.res.pos, food: food.res };
      if (ore && ore.dist < 9) return { action: 'MINE', ore: ore.ore, target: ore.ore.pos };
      if (tr && tr.dist < 9) return { action: 'GATHER_WOOD', tree: tr.tree, target: tr.tree.pos };
      if (store) return { action: 'STOCKPILE', store: store.st, target: store.st.pos };
    }
    return { action: 'PLAYER_MOVE', dir: { x: dir.x, z: dir.z }, run: K.has('shift') };
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e6); // open sky
    this.rng = makeRng(this.seed);
    this.world = new World(this.scene, this.rng);
    this.world.tickNow = 0;
    this.world.skillNames = new Set();
    this.world.inventions = [];
    this.world.onInvent = (ent, skill) => {
      this.world.inventions.push({ skill: skill.name, gen: ent.generation, tick: this.tickCount });
    };
    this.world.spawnChild = (a, b) => this._spawnChild(a, b);

    this.evolution = new Evolution(this.world, this.rng);
    this.tribes = [];
    this.entities = [];
    this.world.entities = this.entities; // interiors look up kin by id
    this.interior = null;
    this.towerPerch = null;
    for (let i = 0; i < CONFIG.population.initial; i++) {
      this.entities.push(new Entity(this.world, this.rng, { generation: 1 }));
    }
  }

  // A child of two pair-bonded parents: blended mutated traits, skills from
  // the fitter parent, born at the family home, kin-linked to parents and
  // siblings so families cohere and tribes grow from lineages.
  _spawnChild(a, b) {
    if (this.entities.filter((e) => e.alive).length >= CONFIG.population.max) return;
    const traits = inheritTraits(a.traits, b.traits, this.rng, CONFIG.evolution);
    const fitter = a.fitness >= b.fitness ? a : b;
    const home = a.home ?? b.home;
    const base = home ? home.pos : a.pos;
    const ang = this.rng.range(-Math.PI, Math.PI);
    const kin = new Set([a.id, b.id, ...a.kin, ...b.kin]);
    const child = new Entity(this.world, this.rng, {
      traits,
      skills: fitter.skills.exportSkills(),
      generation: Math.max(a.generation, b.generation) + 1,
      parents: [a.id, b.id],
      kin: [...kin],
      familyId: a.familyId,
      homeStructure: home ?? null,
      x: base.x + Math.sin(ang) * 3,
      z: base.z + Math.cos(ang) * 3,
      energy: 62
    });
    a.registerChild(child);
    b.registerChild(child);
    // Existing siblings adopt the newborn as kin too.
    for (const e of this.entities) if (e.alive && (e.kin.has(a.id) || e.kin.has(b.id))) {
      e.kin.add(child.id);
      child.kin.add(e.id);
    }
    this.entities.push(child);
    this.evolution.births++;
    this.evolution.generation = Math.max(this.evolution.generation, child.generation);
  }

  reset() {
    if (this.interior) { this.interior.dispose(); this.interior = null; }
    this.towerPerch = null;
    this._placing = false; this._ghost = null; this._buildOrder = null;
    for (const e of this.entities) e.alive && e.die();
    while (this.mount.firstChild) this.mount.removeChild(this.mount.firstChild);
    this.renderer.dispose();
    this.tickCount = 0;
    this.selected = null;
    this.player = null;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this._initRenderer();
    this._initScene();
    this._setMode('free');
  }

  _step(dt) {
    this.tickCount++;
    this.world.tickNow = this.tickCount;
    this.world.update(this.tickCount, this.entities, dt);
    for (const e of this.entities) e.tick(this.entities, this.tickCount, dt);
    this.evolution.maintain(this.entities);
    if (this.tickCount % CONFIG.tribe.recomputeTicks === 0) {
      this.tribes = recomputeTribes(this.entities, this.world);
    }
  }

  _frame = () => {
    requestAnimationFrame(this._frame);
    const now = performance.now();
    let rdt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;

    if (this.running) {
      const fixed = 1 / CONFIG.sim.tickRate;
      this.acc += rdt * this.speed;
      let steps = 0;
      while (this.acc >= fixed && steps < CONFIG.sim.maxSubSteps) {
        this._step(fixed);
        this.acc -= fixed;
        steps++;
      }
      if (steps === CONFIG.sim.maxSubSteps) this.acc = 0;
    }

    for (const e of this.entities) e.render(rdt * (this.running ? this.speed : 1));

    if (this.interior) {
      if (!this.player || !this.player.alive) { this._exitInterior(); this._exitPlay(); }
      else {
        this.interior.update(rdt);
        this._interiorCamera(rdt);
        this.renderer.render(this.interior.scene, this.camera);
        this._updateHUD();
        return;
      }
    }
    if (this.towerPerch && (!this.player || !this.player.alive)) { this._exitInterior(); this._exitPlay(); }
    if (this.towerPerch) this._towerCamera();
    else this._updateCamera(rdt);
    if (this._placing) this._updateGhost();
    this.renderer.render(this.scene, this.camera);
    this._updateHUD();
  };

  // Perched atop the watchtower: a fixed high vantage over the real world,
  // free mouse-look, from which the player can rain arrows on the field.
  _towerCamera() {
    const s = this.towerPerch;
    if (!this.world.structures.includes(s)) { this._exitInterior(); return; }
    const yaw = this._camYaw, pitch = this._camPitch;
    const eye = new THREE.Vector3(s.pos.x, s.pos.y + 7.2, s.pos.z);
    this.camera.position.lerp(eye, 0.4);
    const cp = Math.cos(pitch);
    this.camera.lookAt(
      eye.x + Math.sin(yaw) * cp,
      eye.y - Math.sin(pitch),
      eye.z + Math.cos(yaw) * cp
    );
  }

  // First-person inside a room: mouse looks (reusing the play yaw/pitch),
  // WASD walks within the room bounds.
  _interiorCamera(rdt) {
    const it = this.interior;
    const yaw = this._camYaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const K = this.keys;
    const mv = new THREE.Vector3();
    if (K.has('w')) mv.add(fwd);
    if (K.has('s')) mv.sub(fwd);
    if (K.has('d')) mv.add(right);
    if (K.has('a')) mv.sub(right);
    if (mv.lengthSq() > 0) {
      mv.normalize().multiplyScalar(7 * rdt);
      this._intPos.x = THREE.MathUtils.clamp(this._intPos.x + mv.x, -it.bound, it.bound);
      this._intPos.z = THREE.MathUtils.clamp(this._intPos.z + mv.z, -it.bound, it.bound);
    }
    this.camera.position.set(this._intPos.x, it.eye, this._intPos.z);
    const pitch = this._camPitch - 0.5; // look level-ish, not down at feet
    const cp = Math.cos(pitch);
    this.camera.lookAt(
      this._intPos.x + Math.sin(yaw) * cp,
      it.eye - Math.sin(pitch),
      this._intPos.z + Math.cos(yaw) * cp
    );
  }

  _updateCamera(rdt) {
    if (this.mode === 'play') {
      if (!this.player || !this.player.alive) { this._exitPlay(); return; }
      this._playCamera();
      return;
    }
    if (this.mode === 'follow') {
      if (this.selected && this.selected.alive) this.controls.target.lerp(this.selected.pos, 0.1);
      else this._setMode('free');
    } else {
      // Free flight: WASD slides the focus over the ground, QE changes height.
      const K = this.keys;
      const f = new THREE.Vector3();
      this.camera.getWorldDirection(f); f.y = 0; f.normalize();
      const r = new THREE.Vector3(-f.z, 0, f.x); // camera-right (A/D fixed)
      const spd = 60 * rdt;
      const mv = new THREE.Vector3();
      if (K.has('w')) mv.add(f);
      if (K.has('s')) mv.sub(f);
      if (K.has('d')) mv.add(r);
      if (K.has('a')) mv.sub(r);
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(spd);
        this.controls.target.add(mv);
        this.camera.position.add(mv);
      }
      if (K.has('q')) this.camera.position.y += spd * 0.6;
      if (K.has('e')) this.camera.position.y = Math.max(4, this.camera.position.y - spd * 0.6);
    }
    this.controls.update();
  }

  // Over-the-shoulder rig: orbits with the mouse, and never ends up inside
  // terrain or a building — it pulls in and lifts to keep the agent in view.
  _playCamera() {
    const p = this.player.pos;
    const head = new THREE.Vector3(p.x, p.y + 1.8, p.z);
    const cp = Math.cos(this._camPitch);
    const dir = new THREE.Vector3(
      Math.sin(this._camYaw) * cp,
      Math.sin(this._camPitch),
      Math.cos(this._camYaw) * cp
    );
    let dist = this._camDist;

    // Cast from the agent's head outward; if a wall/tower/tree blocks the
    // view, shorten the boom so we stay this side of it.
    const occluders = [this.world.terrain,
      ...this.world.structures.map((s) => s.mesh),
      ...this.world.trees.map((t) => t.mesh)];
    this._camRay ??= new THREE.Raycaster();
    this._camRay.set(head, dir);
    this._camRay.far = dist;
    const hit = this._camRay.intersectObjects(occluders, true)[0];
    if (hit) dist = Math.max(2.5, hit.distance - 0.6);

    const cam = head.clone().addScaledVector(dir, dist);
    // Never sink below the ground.
    const gy = this.world.heightAt(cam.x, cam.z) + 1.4;
    if (cam.y < gy) cam.y = gy;

    this.camera.position.lerp(cam, 0.35);
    this.camera.lookAt(head);

    const s = this.player, ph = this.ui.ph;
    ph.energy.textContent = Math.round(s.energy);
    ph.wood.textContent = s.wood;
    ph.stone.textContent = s.stone;
    ph.weapon.textContent = s.tool ? `${s.tool.type} ×${s.tool.dur}` : 'none';
    ph.build.textContent = this._buildSel;
    ph.craft.textContent = this._craftSel;
    ph.clan.textContent = `#${s.tribeId} (${s.tribeSize})`;
    ph.clan.style.color = `#${s.tribeColor.getHexString()}`;
    ph.era.textContent = ['', 'I', 'II', 'III', 'IV'][s.tribeEra] ?? 'I';
    ph.role.textContent = s.role();
    ph.kin.textContent = s.kin.size;

    // Crosshair turns amber when a ranged weapon can fire (ready to shoot).
    const ch = this.ui.crosshair;
    const ready = (s._rangedReach?.() ?? 0) > 0 && (s._shootCd ?? 0) <= 0;
    ch.style.borderColor = ready ? 'rgba(255,210,127,0.9)' : 'rgba(255,255,255,0.6)';
  }

  _pick(ev) {
    const x = (ev.clientX / innerWidth) * 2 - 1;
    const y = -(ev.clientY / innerHeight) * 2 + 1;
    this.ray.setFromCamera({ x, y }, this.camera);
    const meshes = this.entities.filter((e) => e.alive).map((e) => e.mesh);
    const hit = this.ray.intersectObjects(meshes, true)[0];
    if (hit) {
      let o = hit.object;
      while (o && o.userData.entityId == null) o = o.parent;
      const ent = o ? this.entities.find((e) => e.id === o.userData.entityId) : null;
      if (ent) {
        this.selected = ent;
        if (this.mode !== 'play') this._setMode('follow'); // click a villager → follow
        this._syncModeUI();
      }
    }
  }

  _bindUI() {
    this.ui = {
      hud: document.getElementById('hud'),
      tick: document.getElementById('hud-tick'),
      gen: document.getElementById('hud-gen'),
      pop: document.getElementById('hud-pop'),
      deaths: document.getElementById('hud-deaths'),
      births: document.getElementById('hud-births'),
      tribes: document.getElementById('hud-tribes'),
      biggest: document.getElementById('hud-biggest'),
      era: document.getElementById('hud-era'),
      houses: document.getElementById('hud-houses'),
      walls: document.getElementById('hud-walls'),
      stores: document.getElementById('hud-stores'),
      towers: document.getElementById('hud-towers'),
      centres: document.getElementById('hud-centres'),
      food: document.getElementById('hud-food'),
      animals: document.getElementById('hud-animals'),
      wolves: document.getElementById('hud-wolves'),
      crops: document.getElementById('hud-crops'),
      armed: document.getElementById('hud-armed'),
      skills: document.getElementById('hud-skills'),
      inspector: document.getElementById('inspector'),
      modeTag: document.getElementById('mode-tag'),
      playBtn: document.getElementById('play-btn'),
      playHelp: document.getElementById('play-help'),
      playerHud: document.getElementById('player-hud'),
      crosshair: document.getElementById('crosshair'),
      interiorMsg: document.getElementById('interior-msg'),
      ph: {
        energy: document.getElementById('ph-energy'),
        wood: document.getElementById('ph-wood'),
        stone: document.getElementById('ph-stone'),
        weapon: document.getElementById('ph-weapon'),
        clan: document.getElementById('ph-clan'),
        era: document.getElementById('ph-era'),
        role: document.getElementById('ph-role'),
        kin: document.getElementById('ph-kin'),
        build: document.getElementById('ph-build'),
        craft: document.getElementById('ph-craft')
      }
    };
    const pause = document.getElementById('btn-pause');
    pause.onclick = () => { this.running = !this.running; pause.textContent = this.running ? 'Pause' : 'Resume'; };
    const sp = document.getElementById('btn-speed');
    sp.onclick = () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      sp.textContent = `${this.speed}x`;
    };
    document.getElementById('btn-reset').onclick = () => this.reset();
    this.ui.playBtn.onclick = () => (this.mode === 'play' ? this._exitPlay() : this._enterPlay());

    // Collapsible panels — the world starts clean, text only on demand.
    const toggle = (btnId, panel) => {
      const b = document.getElementById(btnId);
      b.onclick = () => { panel.classList.toggle('hidden'); b.classList.toggle('on', !panel.classList.contains('hidden')); };
    };
    toggle('tb-stats', this.ui.hud);
    toggle('tb-agent', this.ui.inspector);
    toggle('tb-help', this.ui.playHelp);
    this._setMode('free');
  }

  _syncModeUI() {
    const playing = this.mode === 'play';
    const tag = { free: 'FREE CAM', follow: 'FOLLOWING', play: 'PLAYING' }[this.mode];
    this.ui.modeTag.textContent = tag;
    this.ui.modeTag.style.color = playing ? '#ff8aa0' : this.mode === 'follow' ? '#7fb2ff' : '#4fd28a';
    this.ui.playerHud.style.display = playing ? 'block' : 'none';
    this.ui.crosshair.style.display = playing ? 'block' : 'none';
    const canPlay = !!(this.selected && this.selected.alive);
    this.ui.playBtn.style.display = (playing || canPlay) ? 'block' : 'none';
    this.ui.playBtn.textContent = playing ? '■ RELEASE CONTROL' : '▶ PLAY AS THIS VILLAGER';
    this.ui.playBtn.classList.toggle('playing', playing);
  }

  _updateHUD() {
    if (this.tickCount % 6 !== 0) return;
    const totalSkills = new Set();
    for (const e of this.entities) for (const k of e.skills.skills.keys()) totalSkills.add(k);
    this.ui.tick.textContent = this.tickCount;
    this.ui.gen.textContent = this.evolution.generation;
    this.ui.pop.textContent = this.entities.length;
    this.ui.deaths.textContent = this.evolution.deaths;
    this.ui.births.textContent = this.evolution.births;
    const tribes = this.tribes ?? [];
    this.ui.tribes.textContent = tribes.length;
    this.ui.biggest.textContent = tribes[0]?.size ?? 0;
    const ROM = ['I', 'I', 'II', 'III', 'IV'];
    this.ui.era.textContent = ROM[Math.max(1, ...tribes.map((t) => t.era ?? 1))] ?? 'I';
    let houses = 0, walls = 0, stores = 0, towers = 0, centres = 0, food = 0;
    for (const st of this.world.structures) {
      if (st.type === 'wall' || st.type === 'gate') walls++;
      else if (st.type === 'storehouse') { stores++; food += st.store?.food ?? 0; }
      else if (st.type === 'tower') towers++;
      else if (st.type === 'center') centres++;
      else houses++;
    }
    this.ui.houses.textContent = houses;
    this.ui.walls.textContent = walls;
    this.ui.stores.textContent = stores;
    this.ui.towers.textContent = towers;
    this.ui.centres.textContent = centres;
    this.ui.food.textContent = Math.round(food);
    const wolves = this.world.animals.filter((a) => a.predator).length;
    this.ui.animals.textContent = this.world.animals.length - wolves;
    this.ui.wolves.textContent = wolves;
    this.ui.crops.textContent = this.world.crops.length;
    this.ui.armed.textContent = this.entities.filter((e) => e.alive && e.weapon).length;
    this.ui.skills.textContent = totalSkills.size;

    const s = this.selected;
    if (!s || !s.alive) {
      if (s && !s.alive) { this.selected = null; this._syncModeUI(); }
      this.ui.inspector.innerHTML =
        '<h3>No agent selected</h3><div class="hint">Click any humanoid to follow its mind.</div>';
      return;
    }
    const bar = (v, c = '#5b8bff') =>
      `<div class="bar"><i style="width:${Math.round(v * 100)}%;background:${c}"></i></div>`;
    const t = s.traits;
    const sk = [...s.skills.skills.values()].map((x) => x.name).join(', ') || '—';
    const swatch = `#${s.tribeColor.getHexString()}`;
    const homeTxt = s.home ? (s.atHome() ? 'at home' : 'has home') : 'homeless';
    const youTag = this.player === s
      ? '<div style="color:#ff8aa0;font-weight:700">● YOU ARE CONTROLLING THIS VILLAGER</div>' : '';
    this.ui.inspector.innerHTML = `
      <h3>Agent #${s.id} · gen ${s.generation}</h3>
      ${youTag}
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${swatch};vertical-align:middle"></span>
        tribe ${s.tribeId} · ${s.tribeSize} members · Era ${['','I','II','III','IV'][s.tribeEra] ?? 'I'}</div>
      <div>role <b style="color:#7fb2ff">${s.role()}</b> · family ${s.kin.size} kin · ${homeTxt}</div>
      <div>energy</div>${bar(s.energy / CONFIG.entity.maxEnergy, s.energy < 30 ? '#ff6b6b' : '#4fd28a')}
      <div>action <b style="color:#7fb2ff">${s.action}</b> · anim ${s.animState}</div>
      <div>${s.weapon ? `armed (spear ×${s.weaponDur})` : 'unarmed'} · wood ${s.wood}</div>
      <div style="margin-top:6px">aggression</div>${bar(t.aggression, '#ff7a59')}
      <div>curiosity</div>${bar(t.curiosity)}
      <div>caution</div>${bar(t.caution)}
      <div>sociability</div>${bar(t.sociability, '#4fd28a')}
      <div>loyalty</div>${bar(t.loyalty, '#4fd28a')}
      <div>risk tolerance</div>${bar(t.riskTolerance, '#ff7a59')}
      <div class="hint">skills: ${sk}</div>
      <div class="hint">relationships tracked: ${s.social.rel.size} · age ${s.age.toFixed(0)}s</div>`;
  }
}
