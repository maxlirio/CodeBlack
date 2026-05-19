import * as THREE from 'three';
import { lerp } from './rng.js';

// Low-poly box humanoid with a clear front (visor) so orientation,
// grouping and conflict read at a glance. Animation is fully procedural:
// limb rotation driven by behaviour state, blended smoothly each frame.
const STATES = ['idle', 'walk', 'run', 'turn', 'interact', 'build', 'attack'];

export function createHumanoid(color) {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2333, roughness: 0.6 });
  // Torso has its own material so a job outfit can recolour the tunic
  // without changing the head/arms.
  const tunic = new THREE.MeshStandardMaterial({ color, roughness: 0.75, flatShading: true });

  const part = (w, h, d, mat = skin) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    return m;
  };

  const torso = part(0.7, 0.95, 0.42, tunic);
  torso.position.y = 1.15;
  group.add(torso);

  const head = part(0.42, 0.42, 0.42);
  head.position.y = 1.85;
  group.add(head);
  // Visor marks the facing direction (silhouette readability).
  const visor = part(0.3, 0.12, 0.06, dark);
  visor.position.set(0, 1.86, 0.24);
  group.add(visor);

  const limb = (x, mat = skin) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0, 0);
    const seg = part(0.2, 0.78, 0.2, mat);
    seg.position.y = -0.39;
    pivot.add(seg);
    return pivot;
  };

  const armL = limb(-0.46); armL.position.y = 1.55;
  const armR = limb(0.46); armR.position.y = 1.55;
  const legL = limb(-0.18, dark); legL.position.y = 0.72;
  const legR = limb(0.18, dark); legR.position.y = 0.72;
  group.add(armL, armR, legL, legR);

  // Tribe banner: a small mast + flag whose colour is set per tribe so
  // settlements and allegiance read instantly, like AoE player colours.
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.9, 0.04), dark);
  mast.position.set(0, 2.55, 0);
  const flagMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, side: THREE.DoubleSide });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), flagMat);
  flag.position.set(0.27, 2.78, 0);
  group.add(mast, flag);

  group.userData.rig = { torso, head, armL, armR, legL, legR };
  group.userData.flagMat = flagMat;
  group.userData.mats = { skin, tunic, dark };
  group.userData.anim = { state: 'idle', blend: 0, phase: 0 };
  return group;
}

// Outfit by trade — readable at a glance. Recolours the tunic and swaps a
// distinct headpiece (helmet, hood, straw hat…). Cheap to call; only
// rebuilds when the role actually changes.
const OUTFIT = {
  Warrior:    { tunic: 0x6b7079, hat: 'helmet' },
  Hunter:     { tunic: 0x3f5b35, hat: 'hood' },
  Forager:    { tunic: 0xb98a4a, hat: null },
  Farmer:     { tunic: 0xc7b27a, hat: 'straw' },
  Builder:    { tunic: 0x7a5a36, hat: 'cap' },
  Woodcutter: { tunic: 0x6e4b2c, hat: 'cap' },
  Toolmaker:  { tunic: 0x8a8170, hat: 'cap' },
  Keeper:     { tunic: 0x4a6a8a, hat: null },
  Raider:     { tunic: 0x7a3a3a, hat: 'helmet' },
  Diplomat:   { tunic: 0xb06ab0, hat: null },
  Scout:      { tunic: 0x6a8f6a, hat: 'hood' }
};

export function applyRoleStyle(group, role) {
  if (group.userData.role === role) return;
  group.userData.role = role;
  const o = OUTFIT[role] ?? OUTFIT.Forager;
  group.userData.mats.tunic.color.setHex(o.tunic);

  if (group.userData.hat) { group.remove(group.userData.hat); group.userData.hat = null; }
  if (!o.hat) return;
  let hat;
  const M = (c, r = 0.6) => new THREE.MeshStandardMaterial({ color: c, roughness: r, flatShading: true });
  if (o.hat === 'helmet') {
    hat = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2), M(0x9aa0a8));
    const crest = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.34), M(0xb23b3b));
    crest.position.y = 0.16;
    hat.add(dome, crest);
    hat.position.y = 2.06;
  } else if (o.hat === 'hood') {
    hat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.42, 5), M(0x33402c));
    hat.position.y = 2.12;
  } else if (o.hat === 'straw') {
    hat = new THREE.Group();
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 8), M(0xd8c074));
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.18, 8), M(0xd8c074));
    top.position.y = 0.1;
    hat.add(brim, top);
    hat.position.y = 2.04;
  } else { // cap
    hat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.42), M(0x4a3a26));
    hat.position.y = 2.05;
  }
  hat.traverse?.((m) => { m.castShadow = true; });
  group.add(hat);
  group.userData.hat = hat;
}

// dt in seconds; speed01 is current locomotion magnitude 0..1.
export function animateHumanoid(group, state, dt, speed01 = 0) {
  const a = group.userData.anim;
  const r = group.userData.rig;
  if (!STATES.includes(state)) state = 'idle';

  // Smoothly blend toward the active state's intensity.
  a.state = state;
  const target = state === 'idle' ? 0 : 1;
  a.blend = lerp(a.blend, target, 1 - Math.exp(-8 * dt));

  const cadence = state === 'run' ? 13 : state === 'walk' ? 8 : 6;
  a.phase += dt * cadence * (0.4 + speed01);
  const swing = Math.sin(a.phase);

  let armA = 0, legA = 0, torsoLean = 0, armRaise = 0;

  if (state === 'walk' || state === 'run') {
    const amp = state === 'run' ? 1.15 : 0.7;
    legA = swing * amp;
    armA = -swing * amp * 0.8;
    torsoLean = state === 'run' ? 0.22 : 0.1;
  } else if (state === 'turn') {
    armA = Math.sin(a.phase * 0.6) * 0.25;
  } else if (state === 'interact' || state === 'build') {
    // Repetitive work cycle — both arms pump forward.
    armRaise = -1.1 + Math.sin(a.phase * 1.6) * 0.5;
    torsoLean = 0.18 + Math.sin(a.phase * 1.6) * 0.06;
  } else if (state === 'attack') {
    armRaise = -1.6 + Math.max(0, Math.sin(a.phase * 3.2)) * 1.4;
    torsoLean = 0.3;
  } else {
    // Idle: subtle breathing sway.
    armA = Math.sin(a.phase * 0.5) * 0.06;
    torsoLean = Math.sin(a.phase * 0.5) * 0.03;
  }

  const b = a.blend;
  r.legL.rotation.x = legA * b;
  r.legR.rotation.x = -legA * b;
  r.armL.rotation.x = (armA + armRaise) * b;
  r.armR.rotation.x = (-armA + armRaise) * b;
  r.torso.rotation.x = torsoLean * b;
  r.head.rotation.x = -torsoLean * 0.5 * b;
  // Tiny vertical bob sells locomotion weight.
  const bob = (state === 'walk' || state === 'run') ? Math.abs(Math.sin(a.phase)) * 0.07 * b : 0;
  group.position.y = group.userData.groundY + bob;
}
