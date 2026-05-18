import { CONFIG, PRIMITIVES } from './config.js';

// Emergent invention. Agents only ever execute the four primitives. A
// rolling window of recently-executed primitives is hashed; when the same
// short sequence is repeatedly followed by a survival gain it "stabilises"
// into a reusable named skill that biases future scoring. Skills spread by
// imitation (proximity + trust) and by genetic inheritance.
const ACTION_TO_PRIMITIVE = {
  IDLE: null,
  SEEK_RESOURCE: 'MOVE',
  EAT: 'GATHER',
  FLEE: 'MOVE',
  APPROACH: 'MOVE',
  AVOID: 'MOVE',
  EXPLORE: 'MOVE',
  GROUP: 'MOVE',
  COMMUNICATE: 'SIGNAL',
  BUILD: 'BUILD',
  FORTIFY: 'BUILD',
  RETURN_HOME: 'MOVE',
  DEFEND: 'MOVE',
  GATHER_WOOD: 'GATHER',
  CRAFT: 'CRAFT',
  HUNT: 'HUNT',
  FARM: 'GATHER',
  ATTACK: 'MOVE'
};

const PRIMITIVE_TO_ACTIONS = {
  MOVE: ['SEEK_RESOURCE', 'EXPLORE', 'GROUP'],
  GATHER: ['SEEK_RESOURCE', 'EAT', 'GATHER_WOOD', 'FARM'],
  BUILD: ['BUILD', 'FORTIFY'],
  SIGNAL: ['COMMUNICATE', 'GROUP'],
  CRAFT: ['CRAFT'],
  HUNT: ['HUNT']
};

export class SkillSystem {
  constructor() {
    this.window = [];                 // recent primitives
    this.candidates = new Map();      // seqKey -> success count
    this.skills = new Map();          // seqKey -> {name, boostActions, uses}
  }

  static primitiveFor(action) {
    return ACTION_TO_PRIMITIVE[action] ?? null;
  }

  record(action) {
    const p = ACTION_TO_PRIMITIVE[action];
    if (!p) return;
    this.window.push(p);
    if (this.window.length > CONFIG.skills.sequenceLength) this.window.shift();
  }

  // Called when an action produced a clear survival gain. Credits the
  // sequence that led here and may promote it to a stable skill.
  reinforce(globalSkillNames) {
    if (this.window.length < CONFIG.skills.sequenceLength) return null;
    const key = this.window.join('>');
    if (this.skills.has(key)) {
      this.skills.get(key).uses += 1;
      return null;
    }
    const c = (this.candidates.get(key) ?? 0) + 1;
    this.candidates.set(key, c);
    if (c >= CONFIG.skills.discoveryThreshold) {
      const boost = new Set();
      for (const p of new Set(this.window)) for (const a of PRIMITIVE_TO_ACTIONS[p]) boost.add(a);
      const name = nameFor(key, globalSkillNames);
      const skill = { name, key, boostActions: [...boost], uses: 1 };
      this.skills.set(key, skill);
      this.candidates.delete(key);
      return skill; // newly invented
    }
    return null;
  }

  // Multiplicative bonus an action receives from mastered skills.
  bonusFor(action) {
    let b = 1;
    for (const s of this.skills.values()) {
      if (s.boostActions.includes(action)) b += 0.12 + Math.min(0.4, s.uses * 0.01);
    }
    return b;
  }

  // Cultural diffusion: learn one skill the neighbour has and we don't.
  learnFrom(other) {
    for (const [k, s] of other.skills) {
      if (!this.skills.has(k)) {
        this.skills.set(k, { ...s, uses: 1 });
        return s;
      }
    }
    return null;
  }

  exportSkills() {
    return [...this.skills.entries()].map(([k, s]) => [k, { ...s, uses: 1 }]);
  }

  importSkills(list) {
    for (const [k, s] of list) this.skills.set(k, { ...s });
  }
}

const POOL = ['Forage', 'Shelter', 'Watch', 'Rally', 'Trail', 'Hoard', 'Ward', 'Pact', 'Roam', 'Craft'];
function nameFor(key, globalNames) {
  let n = POOL[Math.abs(hash(key)) % POOL.length];
  let i = 1;
  let candidate = n;
  while (globalNames.has(candidate)) candidate = `${n}-${++i}`;
  globalNames.add(candidate);
  return candidate;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export { PRIMITIVES };
