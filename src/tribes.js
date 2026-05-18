import * as THREE from 'three';
import { CONFIG } from './config.js';

// Tribes are never declared. Each recompute we union agents that share a
// strong trust bond (kin count strongly) or whose homes sit in the same
// village cluster. Connected components become tribes; the largest gives
// the tribe its identity colour. This is label propagation over the same
// local social graph the agents already maintain.
export function recomputeTribes(entities, world) {
  const living = entities.filter((e) => e.alive);
  const parent = new Map();
  const find = (a) => {
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); }
    return a;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const e of living) parent.set(e.id, e.id);

  const byId = new Map(living.map((e) => [e.id, e]));
  for (const e of living) {
    for (const [oid, r] of e.social.rel) {
      if (!byId.has(oid)) continue;
      const kin = e.kin.has(oid);
      if (kin || (r.trust >= CONFIG.tribe.linkTrust && r.hostility < 0.3)) union(e.id, oid);
    }
  }

  // Agents whose homes are in the same village also share a tribe.
  const homed = living.filter((e) => e.home);
  for (let i = 0; i < homed.length; i++) {
    for (let j = i + 1; j < homed.length; j++) {
      const a = homed[i].home.pos;
      const b = homed[j].home.pos;
      if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < CONFIG.tribe.homeMergeDist ** 2) union(homed[i].id, homed[j].id);
    }
  }

  // Collate components, size them, hand out stable-ish colours.
  const groups = new Map();
  for (const e of living) {
    const root = find(e.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }

  const tribes = [];
  for (const [root, members] of groups) {
    const hue = (Math.abs(hash(root)) % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.62, 0.55);
    const centroid = new THREE.Vector3();
    let homes = 0;
    for (const m of members) {
      m.tribeId = root;
      m.tribeColor = color;
      m.tribeSize = members.length;
      m.setTribeColor(color);
      centroid.add(m.pos);
      if (m.home) homes++;
    }
    centroid.multiplyScalar(1 / members.length);
    tribes.push({ id: root, members, size: members.length, centroid, homes });
  }
  tribes.sort((a, b) => b.size - a.size);
  return tribes;
}

function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = n + (n << 3);
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  return (n ^ (n >>> 15)) | 0;
}
