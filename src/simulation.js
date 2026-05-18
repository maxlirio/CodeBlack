import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONFIG } from './config.js';
import { makeRng } from './rng.js';
import { World } from './world.js';
import { Entity } from './entity.js';
import { Evolution } from './evolution.js';
import { inheritTraits } from './personality.js';
import { recomputeTribes } from './tribes.js';

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
    this._initRenderer();
    this._initScene();
    this._bindUI();
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
    this.renderer.domElement.addEventListener('pointerdown', (e) => this._pick(e));
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);
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
    for (const e of this.entities) e.alive && e.die();
    while (this.mount.firstChild) this.mount.removeChild(this.mount.firstChild);
    this.renderer.dispose();
    this.tickCount = 0;
    this.selected = null;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this._initRenderer();
    this._initScene();
  }

  _step(dt) {
    this.tickCount++;
    this.world.tickNow = this.tickCount;
    this.world.update(this.tickCount);
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
    this.controls.update();
    if (this.selected && this.selected.alive) {
      this.controls.target.lerp(this.selected.pos, 0.08);
    }
    this.renderer.render(this.scene, this.camera);
    this._updateHUD();
  };

  _pick(ev) {
    const x = (ev.clientX / innerWidth) * 2 - 1;
    const y = -(ev.clientY / innerHeight) * 2 + 1;
    this.ray.setFromCamera({ x, y }, this.camera);
    const meshes = this.entities.filter((e) => e.alive).map((e) => e.mesh);
    const hit = this.ray.intersectObjects(meshes, true)[0];
    if (hit) {
      let o = hit.object;
      while (o && o.userData.entityId == null) o = o.parent;
      this.selected = o ? this.entities.find((e) => e.id === o.userData.entityId) : null;
    }
  }

  _bindUI() {
    this.ui = {
      tick: document.getElementById('hud-tick'),
      gen: document.getElementById('hud-gen'),
      pop: document.getElementById('hud-pop'),
      deaths: document.getElementById('hud-deaths'),
      births: document.getElementById('hud-births'),
      tribes: document.getElementById('hud-tribes'),
      biggest: document.getElementById('hud-biggest'),
      houses: document.getElementById('hud-houses'),
      walls: document.getElementById('hud-walls'),
      skills: document.getElementById('hud-skills'),
      inspector: document.getElementById('inspector')
    };
    const pause = document.getElementById('btn-pause');
    pause.onclick = () => { this.running = !this.running; pause.textContent = this.running ? 'Pause' : 'Resume'; };
    const sp = document.getElementById('btn-speed');
    sp.onclick = () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      sp.textContent = `Speed: ${this.speed}x`;
    };
    document.getElementById('btn-reset').onclick = () => this.reset();
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
    let houses = 0, walls = 0;
    for (const st of this.world.structures) st.type === 'wall' ? walls++ : houses++;
    this.ui.houses.textContent = houses;
    this.ui.walls.textContent = walls;
    this.ui.skills.textContent = totalSkills.size;

    const s = this.selected;
    if (!s || !s.alive) {
      if (s && !s.alive) this.selected = null;
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
    this.ui.inspector.innerHTML = `
      <h3>Agent #${s.id} · gen ${s.generation}</h3>
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${swatch};vertical-align:middle"></span>
        tribe ${s.tribeId} · ${s.tribeSize} members</div>
      <div>family: ${s.kin.size} kin · ${homeTxt}</div>
      <div>energy</div>${bar(s.energy / CONFIG.entity.maxEnergy, s.energy < 30 ? '#ff6b6b' : '#4fd28a')}
      <div>action <b style="color:#7fb2ff">${s.action}</b> · anim ${s.animState}</div>
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
