import { clamp } from './rng.js';

export const TRAIT_KEYS = ['aggression', 'curiosity', 'caution', 'sociability', 'loyalty', 'riskTolerance'];

export function randomTraits(rng) {
  const t = {};
  for (const k of TRAIT_KEYS) t[k] = rng.range(0.15, 0.85);
  return t;
}

// Sexual-ish/asexual inheritance: blend a parent (or two) with gaussian
// mutation. Traits stay in [0,1].
export function inheritTraits(parentA, parentB, rng, cfg) {
  const t = {};
  for (const k of TRAIT_KEYS) {
    const base = parentB ? (parentA[k] + parentB[k]) / 2 : parentA[k];
    const mut = rng.chance(cfg.mutationRate) ? rng.gauss() * cfg.mutationScale : 0;
    t[k] = clamp(base + mut, 0.02, 0.98);
  }
  return t;
}

// Experience nudges a trait toward what worked. Tiny per-event so identity
// is stable but drifts over a lifetime.
export function driftTrait(traits, key, dir, amount) {
  traits[key] = clamp(traits[key] + dir * amount, 0.02, 0.98);
}
