import { CONFIG } from './config.js';
import { inheritTraits } from './personality.js';
import { Entity } from './entity.js';

// Generational replacement. When the population dips, the fittest living
// agents act as parents; offspring inherit blended traits (mutated) and
// the parent's stabilised skills — so successful survival strategies and
// inventions propagate genetically across generations.
export class Evolution {
  constructor(world, rng) {
    this.world = world;
    this.rng = rng;
    this.generation = 1;
    this.births = 0;
    this.deaths = 0;
  }

  tournament(pool) {
    let best = null;
    for (let i = 0; i < CONFIG.evolution.tournamentSize; i++) {
      const c = pool[this.rng.int(0, pool.length - 1)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  }

  // Called every tick. Reaps the dead, refills toward the population floor.
  maintain(entities) {
    const before = entities.length;
    for (let i = entities.length - 1; i >= 0; i--) {
      if (!entities[i].alive) {
        this.deaths++;
        entities.splice(i, 1);
      }
    }

    const living = entities.filter((e) => e.alive);
    while (entities.length < CONFIG.population.min) {
      let traits, skills, gen = 1;
      if (living.length >= 2) {
        const a = this.tournament(living);
        const b = this.tournament(living);
        traits = inheritTraits(a.traits, b.traits, this.rng, CONFIG.evolution);
        skills = (a.fitness > b.fitness ? a : b).skills.exportSkills();
        gen = Math.max(a.generation, b.generation) + 1;
        this.generation = Math.max(this.generation, gen);
      } else if (living.length === 1) {
        traits = inheritTraits(living[0].traits, null, this.rng, CONFIG.evolution);
        skills = living[0].skills.exportSkills();
        gen = living[0].generation + 1;
      } else {
        traits = undefined; // fresh founders after a total collapse
      }
      const child = new Entity(this.world, this.rng, { traits, skills, generation: gen, energy: 70 });
      entities.push(child);
      this.births++;
    }
    return entities.length - before;
  }
}
