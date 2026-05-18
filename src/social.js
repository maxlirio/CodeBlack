import { CONFIG } from './config.js';
import { clamp } from './rng.js';

// Per-individual relationship ledger. Trust/hostility/familiarity move
// from concrete interactions; groups are never declared — they emerge
// because clustering near trusted agents lowers perceived danger.
export class Social {
  constructor() {
    this.rel = new Map(); // otherId -> {trust, hostility, familiarity}
  }

  get(id) {
    let r = this.rel.get(id);
    if (!r) {
      r = { trust: 0.1, hostility: 0, familiarity: 0 };
      this.rel.set(id, r);
    }
    return r;
  }

  cooperate(id) {
    const r = this.get(id);
    r.trust = clamp(r.trust + CONFIG.social.trustGainCoop, 0, 1);
    r.hostility = clamp(r.hostility - 0.04, 0, 1);
  }

  sharedDanger(id) {
    const r = this.get(id);
    r.trust = clamp(r.trust + CONFIG.social.trustGainProxDanger, 0, 1);
  }

  conflict(id) {
    const r = this.get(id);
    r.hostility = clamp(r.hostility + CONFIG.social.hostilityGainConflict, 0, 1);
    r.trust = clamp(r.trust - 0.18, 0, 1);
  }

  abandoned(id) {
    const r = this.get(id);
    r.trust = clamp(r.trust - CONFIG.social.trustLossAbandon, 0, 1);
  }

  familiar(id) {
    const r = this.get(id);
    r.familiarity = clamp(r.familiarity + CONFIG.social.familiarityGainPerTick, 0, 1);
  }

  decay() {
    const d = CONFIG.social.decay;
    for (const r of this.rel.values()) {
      r.trust += (0.1 - r.trust) * d;
      r.hostility *= 1 - d * 3;
    }
  }

  isAlly(id) {
    const r = this.rel.get(id);
    return !!r && r.trust >= CONFIG.social.groupTrustThreshold && r.hostility < 0.3;
  }
}

export const SIGNALS = ['WARN', 'HELP', 'RALLY'];
