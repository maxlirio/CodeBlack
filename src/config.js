// Central tuning. Every emergent behaviour is sensitive to these numbers;
// they are deliberately collected here rather than scattered as magic values.
export const CONFIG = {
  world: {
    size: 120,            // half-extent of the square play field
    terrainSegments: 64,
    terrainAmplitude: 6
  },

  nature: {
    bushCount: 64,            // wild berry bushes — base forage, scarce
    bushEnergy: 30,
    bushRegrowTicks: 820,
    forests: 7,               // tree clusters
    treesPerForest: 9,
    treeWood: 4,              // wood units per tree before it is depleted
    treeRegrowTicks: 2600,
    woodPerChop: 1,
    herds: 5,
    animalsPerHerd: 5,
    animalEnergy: 78,         // food yielded by a kill (a feast — worth hunting)
    animalHealth: 34,
    animalSpeed: 5.6,
    animalFleeRadius: 16,
    animalWanderRadius: 30,
    carcassExpireTicks: 700,
    cropGrowTicks: 950,       // ticks from seed to harvest
    cropEnergy: 52,           // harvest yield — farming beats foraging
    cropPlantCost: 6          // energy spent planting a seed
  },

  population: {
    initial: 28,
    min: 14,               // evolution refills toward this floor
    max: 46
  },

  sim: {
    tickRate: 20,          // fixed ticks per second
    maxSubSteps: 5
  },

  entity: {
    radius: 0.9,
    walkSpeed: 3.2,
    runSpeed: 6.4,
    turnRate: 7.0,
    maxEnergy: 100,
    energyDrainPerSecond: 1.05,
    runEnergyMultiplier: 2.3,
    eatRadius: 2.2,
    interactRadius: 2.6,
    attackRadius: 2.2,
    attackDamage: 16,
    perceptionRadius: 26,
    perceptionFov: Math.PI * 0.95,   // not omniscient: limited cone + radius
    signalRadius: 22,
    buildEnergyCost: 30,
    buildMinEnergy: 62,
    gatherRadius: 2.4,        // reach for chopping wood / harvesting crops
    huntRadius: 2.4
  },

  hunt: {
    weaponWoodCost: 3,        // wood needed to craft a weapon
    weaponDurability: 6,      // kills before a weapon breaks
    craftMinEnergy: 40,
    unarmedDamage: 5,         // bare-handed: animals usually escape
    armedDamage: 18,          // with a crafted weapon: hunting is viable
    armedAttackBonus: 10,     // weapons also help in conflict between agents
    shareRadius: 7            // kin/tribe nearby share a kill (cooperation)
  },

  home: {
    restRadius: 9,            // recover faster / feel safer within this of home
    restRegenPerSecond: 3.2,  // energy regained per second while resting at home
    safetyBonus: 0.55,        // danger is scaled down by this near home
    homePull: 1.0             // base weight of the "go home" drive
  },

  family: {
    bondTrust: 0.48,          // mutual trust needed to pair-bond
    bondFamiliarity: 0.32,
    reproEnergy: 60,          // both partners need at least this much
    reproCost: 20,            // energy each parent spends on a child
    reproCooldownTicks: 700,
    minAge: 11,               // seconds before an agent can reproduce
    kinTrust: 0.55,           // trust floor toward parents/children/siblings
    tribeProxTrust: 0.02      // trust gained per tick standing among tribe/kin
  },

  tribe: {
    recomputeTicks: 40,       // how often tribe membership is re-derived
    linkTrust: 0.42,          // trust above this links two agents into a tribe
    homeMergeDist: 26,        // tribe homes within this distance grow a village
    rivalHostility: 0.34,     // baseline hostility added toward other tribes
    fortifyThreatTicks: 360   // recent threat-at-home window that triggers walls
  },

  structures: {
    houseCost: 34,
    houseMinEnergy: 70,
    wallCost: 14,
    wallMinEnergy: 30,
    wallRing: 13,             // walls are raised on this radius around home
    maxHousesPerVillage: 5,
    peoplePerHouse: 3         // a village only needs more houses as it grows
  },

  social: {
    trustGainCoop: 0.08,
    trustGainProxDanger: 0.05,
    trustLossAbandon: 0.06,
    hostilityGainConflict: 0.22,
    familiarityGainPerTick: 0.012,
    decay: 0.0009,
    groupTrustThreshold: 0.35
  },

  learning: {
    reinforce: 0.05,       // weight nudge on good outcomes
    punish: 0.06,          // weight nudge on bad outcomes
    traitDrift: 0.015,     // how far traits move per reinforced lesson
    weightMin: 0.35,
    weightMax: 2.2
  },

  evolution: {
    mutationRate: 0.18,
    mutationScale: 0.12,
    tournamentSize: 4
  },

  skills: {
    sequenceLength: 3,         // primitives chained into a candidate skill
    discoveryThreshold: 4,     // successful repeats before it stabilises
    diffusionChance: 0.04      // per-tick chance to copy a trusted neighbour's skill
  }
};

export const ACTIONS = [
  'IDLE',
  'SEEK_RESOURCE',
  'EAT',
  'FLEE',
  'APPROACH',
  'AVOID',
  'EXPLORE',
  'GROUP',
  'COMMUNICATE',
  'BUILD',
  'FORTIFY',
  'RETURN_HOME',
  'DEFEND',
  'GATHER_WOOD',
  'CRAFT',
  'HUNT',
  'FARM',
  'ATTACK'
];

// Primitive vocabulary an agent starts with. Inventions (e.g. weapons,
// hunting parties, farming) are emergent recombinations of these —
// never anything outside this set.
export const PRIMITIVES = ['MOVE', 'GATHER', 'BUILD', 'SIGNAL', 'CRAFT', 'HUNT'];
