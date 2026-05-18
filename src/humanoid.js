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

  const part = (w, h, d, mat = skin) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    return m;
  };

  const torso = part(0.7, 0.95, 0.42);
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
  group.userData.anim = { state: 'idle', blend: 0, phase: 0 };
  return group;
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
