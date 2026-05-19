// Central tuning. Every emergent behaviour is sensitive to these numbers;
// they are deliberately collected here rather than scattered as magic values.
export const CONFIG = {
  world: {
    size: 120,            // half-extent of the square play field
    terrainSegments: 64,
    terrainAmplitude: 6
  },

  nature: {
    bushCount: 140,           // wild berry bushes — scaled for a bigger pop
    bushEnergy: 34,
    bushRegrowTicks: 560,
    forests: 10,              // tree clusters
    treesPerForest: 9,
    treeWood: 4,              // wood units per tree before it is depleted
    treeRegrowTicks: 2600,
    woodPerChop: 1,
    herds: 8,
    animalsPerHerd: 5,
    animalEnergy: 78,         // food yielded by a kill (a feast — worth hunting)
    animalHealth: 34,
    animalSpeed: 5.6,
    animalFleeRadius: 16,
    animalWanderRadius: 30,
    carcassExpireTicks: 700,
    // Herbivore species mixed into herds. boar gores bare-handed hunters.
    species: {
      deer:   { speed: 5.8, health: 32, food: 80,  scale: 1.0,  color: 0x9a6b3f, weight: 0.62 },
      rabbit: { speed: 7.4, health: 12, food: 44,  scale: 0.45, color: 0xb9a989, weight: 0.22 },
      boar:   { speed: 4.6, health: 60, food: 104, scale: 0.85, color: 0x5b4636, weight: 0.16,
                gore: 9 }
    },
    cropGrowTicks: 950,       // ticks from seed to harvest
    cropEnergy: 52,           // harvest yield — farming beats foraging
    cropPlantCost: 6          // energy spent planting a seed
  },

  population: {
    initial: 44,
    min: 24,               // evolution refills toward this floor
    max: 80
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
    energyDrainPerSecond: 0.78,
    runEnergyMultiplier: 2.0,
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
    craftMinEnergy: 40,
    unarmedDamage: 5,         // bare-handed: animals usually escape
    shareRadius: 7            // kin/tribe nearby share a kill (cooperation)
  },

  // Craftable tools & weapons. melee = bonus damage in a strike; ranged
  // tools fire a projectile; woodBonus speeds up chopping; throw lets a
  // melee weapon also be hurled. era gates more advanced kit.
  tools: {
    club:  { wood: 2, dur: 8,  melee: 8,  woodBonus: 0, era: 1 },
    spear: { wood: 3, dur: 7,  melee: 14, woodBonus: 0, era: 1, throw: { dmg: 20, speed: 34, range: 22 } },
    axe:   { wood: 4, dur: 10, melee: 11, woodBonus: 2, era: 1 },
    bow:   { wood: 5, dur: 9,  melee: 3,  woodBonus: 0, era: 2,
             ranged: { dmg: 16, speed: 46, range: 30 } }
  },

  projectile: {
    gravity: 9,               // arc on thrown spears / arrows
    hitRadius: 1.4,
    maxLifeTicks: 90,
    autoAimCone: 0.32         // gentle aim-assist toward a target in this cone
  },

  home: {
    restRadius: 9,            // recover faster / feel safer within this of home
    restRegenPerSecond: 4.2,  // energy regained per second while resting at home
    safetyBonus: 0.55,        // danger is scaled down by this near home
    homePull: 1.0             // base weight of the "go home" drive
  },

  family: {
    bondTrust: 0.44,          // mutual trust needed to pair-bond
    bondFamiliarity: 0.3,
    reproEnergy: 54,          // both partners need at least this much
    reproCost: 15,            // energy each parent spends on a child
    reproCooldownTicks: 560,
    minAge: 10,               // seconds before an agent can reproduce
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
    wallRing: 13,             // walls are raised on this radius around home
    maxHousesPerVillage: 6,
    peoplePerHouse: 3,        // a village only needs more houses as it grows
    repairPerTick: 4,         // builders mend a damaged friendly structure
    // Hard per-village caps so settlements finish and stop bleeding energy
    // into endless construction (which was starving reproduction).
    maxPerVillage: { storehouse: 2, tower: 3, center: 1, wall: 14 },
    villageRadius: 26,        // what counts as "this village" for caps
    // Per-type spec. cost = energy to raise, hp = how much siege it takes.
    types: {
      house:      { cost: 20, minEnergy: 62, hp: 60,  solid: false },
      wall:       { cost: 9,  minEnergy: 34, hp: 90,  solid: true  },
      gate:       { cost: 12, minEnergy: 40, hp: 100, solid: false },
      storehouse: { cost: 18, minEnergy: 58, hp: 80,  solid: false },
      tower:      { cost: 22, minEnergy: 64, hp: 120, solid: true, era: 2 },
      center:     { cost: 26, minEnergy: 70, hp: 160, solid: false },
      ram:        { cost: 14, minEnergy: 48, hp: 70,  solid: false }
    }
  },

  war: {
    feudToSiege: 1.0,         // clan hatred at which siege engines appear
    ramDamagePerTick: 1.6,    // a ram batters the nearest enemy structure
    ramReach: 6,              // how close the ram works
    siegeMinEnergy: 48,
    captureEraReward: 4,      // era-progress the conqueror tribe gains
    captureEnergyReward: 28,  // morale/spoils for nearby victors
    convertChance: 0.6        // odds a leaderless survivor joins the conqueror
  },

  stockpile: {
    depositChunk: 9,          // energy converted into shared food per deposit
    depositKeep: 84,          // only bank genuine surplus (near-full agents)
    withdrawTo: 66,           // hungry agents draw stockpile up to this energy
    withdrawAt: 60,           // ...once energy drops below this
    storeRadius: 7,           // reach to deposit/withdraw at a storehouse
    feedRadius: 26,           // a stocked granary nourishes its whole village
    feedRegenBonus: 3.0,      // extra home regen/s drawn from village food
    feedCostPerEnergy: 0.7,   // store food spent per bonus energy granted
    raidGain: 10              // food a raider strips from an enemy store per hit
  },

  era: {
    // A tribe advances Era when its members' shared progress crosses these
    // thresholds (inventions + structures). No tech tree — pure emergence.
    thresholds: [0, 6, 16],   // Era 1 / 2 / 3 progress points
    wallHpPerEra: 0.35,       // +35% structure HP per era above 1
    weaponBonusPerEra: 4      // sharper tools in later eras
  },

  feud: {
    perKill: 1.7,             // hatred a clan gains when one of theirs is slain
    decayPerTick: 0.00022,    // grudges cool slowly over time
    hostility: 0.5,           // how strongly feud translates into aggression
    avengeRadius: 30,         // a fresh killing enrages nearby kin/tribe
    warThreshold: 1.0         // at/above this a clan marches on the enemy
  },

  trade: {
    minSurplus: 18,           // food a village stockpile must hold to export
    caravanFood: 12,          // food moved per successful caravan
    bondPerTrade: 0.6,        // goodwill each trade builds between two clans
    bondDecayPerTick: 0.00035, // goodwill fades if trade stops
    bondMax: 4,               // cap; rivalry is cancelled well before this
    rivalRelief: 0.14,        // rivalry removed per point of trade goodwill
    range: 170,               // how far a caravan will travel to a partner
    cooldownTicks: 500,       // per-agent trade cadence
    truceChancePerTick: 0.0012, // weary feuding clans sue for peace
    truceTicks: 5000          // how long a truce suppresses the grudge
  },

  predator: {
    packs: 2,
    perPack: 3,
    speed: 6.2,
    senseRadius: 17,
    attackRadius: 2.4,
    damage: 7,                // a danger that rewards grouping, not a wipe
    health: 24,
    cooldownTicks: 38         // ticks between a wolf's strikes
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
  'SHOOT',
  'FARM',
  'STOCKPILE',
  'RAID',
  'SIEGE',
  'TRADE',
  'ATTACK'
];

// Primitive vocabulary an agent starts with. Inventions (e.g. weapons,
// hunting parties, farming) are emergent recombinations of these —
// never anything outside this set.
export const PRIMITIVES = ['MOVE', 'GATHER', 'BUILD', 'SIGNAL', 'CRAFT', 'HUNT'];
