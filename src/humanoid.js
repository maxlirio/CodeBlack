import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

// Low-poly humanoid backed by Mike Newbon's Soldier.glb (CC-BY 4.0,
// distributed by three.js). One GLTF is loaded at startup and every
// villager is a SkeletonUtils.clone() that shares geometry, materials
// and the original animation clips — so 60 villagers cost roughly one
// model's worth of memory.
//
// We keep the original API (createHumanoid / applyRoleStyle /
// animateHumanoid) so the rest of the codebase doesn't have to know
// anything changed.

let _src = null;             // { sceneTemplate, clips: { idle, walk, run } }
const STATE_TO_CLIP = {
  idle: 'idle', turn: 'idle',
  walk: 'walk', interact: 'walk', build: 'walk',
  run: 'run', attack: 'run',
};

// Called once at app startup before any humanoid is created.
export async function loadAssets() {
  if (_src) return;
  const loader = new GLTFLoader();
  const url = `${import.meta.env.BASE_URL}assets/soldier.glb`;
  const gltf = await loader.loadAsync(url);
  // Sort clips by their lowercased name into the slots our animator
  // expects. Soldier.glb ships with Idle / Walk / Run.
  const clips = {};
  for (const c of gltf.animations) {
    const n = c.name.toLowerCase();
    if (n.includes('idle')) clips.idle = c;
    else if (n.includes('run')) clips.run = c;
    else if (n.includes('walk')) clips.walk = c;
  }
  if (!clips.idle && gltf.animations[0]) clips.idle = gltf.animations[0];
  if (!clips.walk) clips.walk = clips.idle;
  if (!clips.run)  clips.run  = clips.walk;
  // Pre-cast shadows + tune material flags on the template so every
  // clone inherits them.
  gltf.scene.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
  });
  _src = { sceneTemplate: gltf.scene, clips };
}

function makePlaceholder(color) {
  // Used only if a humanoid is created before loadAssets() resolves —
  // shouldn't happen in normal flow but keeps the codebase robust.
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.3), mat);
  torso.position.y = 1.0;
  g.add(torso);
  return g;
}

export function createHumanoid(color) {
  if (!_src) return makePlaceholder(color);

  const group = new THREE.Group();
  // SkeletonUtils.clone gives each villager its own animatable skeleton
  // while keeping geometry + textures shared.
  const model = cloneSkinned(_src.sceneTemplate);
  // The bundled soldier model is ~1.8 units tall — close to the world's
  // unit scale, but a touch tall for our camera framing. Nudge down so
  // the existing camera offsets and animations look right.
  model.scale.setScalar(1.55);
  model.position.y = 0;
  // Tint each mesh's material toward the tribe colour. We clone the
  // materials so per-entity tinting doesn't leak to siblings, and we
  // average with white so the baked detail stays visible instead of
  // being drowned out by the tribe shade.
  const tintCache = new Map();
  const white = new THREE.Color(0xffffff);
  const tribeC = new THREE.Color(color);
  model.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.material) return;
    let m = tintCache.get(o.material);
    if (!m) {
      m = o.material.clone();
      if (m.color) {
        const base = m.color.clone();
        m.color = base.multiply(tribeC.clone().lerp(white, 0.72));
      }
      tintCache.set(o.material, m);
    }
    o.material = m;
  });
  group.add(model);

  // Banner: small mast + flag above the head in the pure tribe colour
  // so allegiance reads at RTS zoom even when the body tint is subtle.
  const mast = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.85, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x1c2333 }));
  mast.position.y = 2.7;
  const flagMat = new THREE.MeshStandardMaterial({
    color, side: THREE.DoubleSide, roughness: 0.6, flatShading: true,
  });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.34), flagMat);
  flag.position.set(0.32, 2.92, 0);
  group.add(mast, flag);

  // Animation: one mixer per villager. We play all three clips at the
  // same time and just modulate their effective weight — this gives us
  // smooth state transitions without messing with crossFade timing.
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const name of ['idle', 'walk', 'run']) {
    const clip = _src.clips[name];
    if (!clip) continue;
    const a = mixer.clipAction(clip);
    a.setEffectiveWeight(name === 'idle' ? 1 : 0);
    a.play();
    actions[name] = a;
  }

  // Find the right-hand bone so the rest of the code can keep doing
  // `mesh.userData.rig.armR.add(toolMesh)`. Soldier.glb uses Mixamo-rig
  // bone names — we cover a few variants and fall back to a fixed
  // group on the model's right side if no bone matches.
  let rightHand = null;
  model.traverse((o) => {
    if (!o.isBone || rightHand) return;
    const n = o.name;
    if (/RightHand$|R_?Hand$|hand_?R$/i.test(n) ||
        /mixamorig.*RightHand/i.test(n)) rightHand = o;
  });
  if (!rightHand) {
    rightHand = new THREE.Group();
    rightHand.position.set(0.35, 1.3, 0);
    model.add(rightHand);
  }

  group.userData.mixer = mixer;
  group.userData.actions = actions;
  group.userData.flagMat = flagMat;
  group.userData.anim = { target: 'idle' };
  group.userData.role = null;
  // Compatibility shim: legacy code (tool attach in entity.js) reaches
  // into mesh.userData.rig.armR. We point that at the hand bone so a
  // tool group follows the hand's animation. Other rig fields are
  // left unfilled — nothing else reads them.
  group.userData.rig = { armR: rightHand };
  return group;
}

// We don't have per-role outfit assets for the soldier model — its
// textures are baked. For now this is a no-op stub so callers don't
// crash; future work could swap a hat/tool prop above the head per role.
export function applyRoleStyle(group, role) {
  if (group.userData) group.userData.role = role;
}

// dt in seconds; speed01 is locomotion magnitude 0..1 (used to choose
// between walk and run when the sim has commanded a generic "walk").
export function animateHumanoid(group, state, dt, speed01 = 0) {
  const mixer = group.userData?.mixer;
  const actions = group.userData?.actions;
  if (!mixer || !actions) return;
  // Refine the simulation state into one of the three Soldier clips.
  // The state machine the rest of the code uses has more states than
  // the model has animations; we collapse intelligently.
  let target = STATE_TO_CLIP[state] || 'idle';
  // If the sim says "walk" but we're sprinting, blend toward run.
  if (target === 'walk' && speed01 > 0.7) target = 'run';
  group.userData.anim.target = target;
  // Smoothly fade each action's weight toward 1 (target) or 0.
  const k = 1 - Math.exp(-10 * dt);
  for (const [name, a] of Object.entries(actions)) {
    const goal = name === target ? 1 : 0;
    const cur = a.getEffectiveWeight();
    a.setEffectiveWeight(cur + (goal - cur) * k);
  }
  mixer.update(dt);
  // Apply any externally-set groundY so vertical bob from the asset's
  // animation still rides on terrain height like before.
  if (group.userData.groundY != null) group.position.y = group.userData.groundY;
}
