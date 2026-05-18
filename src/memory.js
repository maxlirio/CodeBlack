// Layered memory. Short-term is a decaying ring of recent events used by
// the decision system "in the moment". Long-term is reinforced statistics
// per event kind — the substrate for learning and skill discovery.
export class Memory {
  constructor() {
    this.short = [];               // {kind, pos, tick, valence}
    this.long = new Map();         // kind -> {count, value}
  }

  remember(kind, tick, pos = null, valence = 0) {
    this.short.push({ kind, tick, pos: pos ? pos.clone() : null, valence });
    if (this.short.length > 24) this.short.shift();
    const e = this.long.get(kind) ?? { count: 0, value: 0 };
    e.count += 1;
    e.value += (valence - e.value) * 0.25;   // running, recency-weighted
    this.long.set(kind, e);
  }

  decay(tick) {
    // Forget stale short-term events (older than ~30s at 20Hz).
    this.short = this.short.filter((e) => tick - e.tick < 600);
  }

  recent(kind, tick, within = 200) {
    return this.short.find((e) => e.kind === kind && tick - e.tick < within) ?? null;
  }

  // Best remembered resource location still recent enough to chase.
  lastResource(tick) {
    for (let i = this.short.length - 1; i >= 0; i--) {
      const e = this.short[i];
      if (e.kind === 'saw_resource' && e.pos && tick - e.tick < 1200) return e.pos;
    }
    return null;
  }

  lastThreat(tick) {
    for (let i = this.short.length - 1; i >= 0; i--) {
      const e = this.short[i];
      if (e.kind === 'threat' && e.pos && tick - e.tick < 400) return e.pos;
    }
    return null;
  }

  valenceOf(kind) {
    return this.long.get(kind)?.value ?? 0;
  }
}
