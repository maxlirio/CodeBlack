// Central tuning. Every emergent behaviour is sensitive to these numbers;
// they are deliberately collected here rather than scattered as magic values.
export const CONFIG = {
  world: {
    size: 120,            // half-extent of the square play field
    terrainSegments: 192, // dense subdivisions for clean ridges/terraces
    terrainAmplitude: 10, // baseline rolling-hill amplitude
    // Readable but varied terrain: layered noise + folded ridges + a few
    // localized cliff bumps. Steep slopes (|dy| > slopeMaxStep per step)
    // are uncrossable unless a placed ladder is within ladderReach.
    terrain: {
      ridgeStrength: 4.5,    // folded-noise contribution (sharp ridges)
      terraceStrength: 3.5,  // discrete-step contribution (terraces)
      cliffCount: [3, 6],    // per-world local cliff bumps
      cliffHeight: [6, 14],  // height range of those bumps
      cliffR: [8, 16],       // footprint radius of those bumps
      slopeMaxStep: 2.0,     // larger jump → blocked unless near a ladder
      ladderReach: 3.5,      // a ladder enables climbing within this radius
      lakeMaxHeight: 0.6,    // lakes only in low valleys (below this y)
    },
  },

  nature: {
    bushCount: 150,           // wild berry bushes — scaled for a bigger pop
    bushEnergy: 38,
    bushRegrowTicks: 520,
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
    energyDrainPerSecond: 0.7,
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
  // tools fire a projectile; `mine` lets you quarry ore. (The old
  // climb-tool ladder is gone — ladders are now placeable structures
  // that let anyone scale a steep slope they otherwise couldn't.)
  tools: {
    pickaxe: { wood: 3, dur: 10, melee: 10, era: 1, mine: true },
    sword:   { wood: 4, dur: 12, melee: 22, era: 1 },
    bow:     { wood: 5, dur: 9,  melee: 3,  era: 2,
               ranged: { dmg: 12, speed: 46, range: 32 } }
  },

  pen: {
    radius: 5,                // half-extent of the village's fenced paddock
    herdRange: 30,            // how far a farmer ranges to drive in stock
    breedTicks: 1100,         // penned livestock multiply on this cadence
    maxPenned: 8              // per paddock, before they stop breeding
  },

  mining: {
    ore: 34,                  // boulders / mountain ore nodes (more reachable)
    yield: 1,                 // stone per swing
    nodeStone: 8,             // stone before a node is spent
    regrowTicks: 1800,
    reach: 2.4
  },

  landmarks: {
    mountains: 0,             // legacy peaks — replaced by the world cliff
    lakes: 3,                 // water basins (valley-only — see world.cliff)
    boulders: 44,             // scattered rocks, ~half ore-bearing
    flowerPatches: 30,
    deadTrees: 14,
    mushroomRings: 10
  },

  projectile: {
    gravity: 9,               // arc before a target is locked
    hitRadius: 1.6,
    maxLifeTicks: 110,
    autoAimCone: 0.32,
    // Projectiles seek the nearest valid target — bows/spears reliably
    // connect (low skill), but their damage is modest in trade.
    homingRange: 42,
    homingRate: 7             // how hard the shot curves onto its target
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
    // Per-type spec: cost = energy, wood/stone = materials consumed, hp =
    // how much siege it endures. Everyday building only needs (gatherable)
    // wood; stone is reserved for fortifications & siege so it stays a
    // meaningful goal without starving ordinary construction.
    types: {
      ladder:     { cost: 5,  wood: 2, stone: 0, minEnergy: 18, hp: 40,  solid: false },
      house:      { cost: 18, wood: 2, stone: 0, minEnergy: 58, hp: 60,  solid: false },
      wall:       { cost: 6,  wood: 1, stone: 0, minEnergy: 24, hp: 80,  solid: true  },
      gate:       { cost: 9,  wood: 2, stone: 0, minEnergy: 32, hp: 100, solid: false },
      fence:      { cost: 5,  wood: 1, stone: 0, minEnergy: 24, hp: 30,  solid: true  },
      storehouse: { cost: 16, wood: 2, stone: 0, minEnergy: 54, hp: 80,  solid: false },
      tower:      { cost: 20, wood: 2, stone: 1, minEnergy: 60, hp: 120, solid: true, era: 2 },
      center:     { cost: 24, wood: 3, stone: 1, minEnergy: 66, hp: 160, solid: false },
      ram:        { cost: 14, wood: 2, stone: 0, minEnergy: 46, hp: 70,  solid: false },
      ballista:   { cost: 16, wood: 2, stone: 1, minEnergy: 50, hp: 55,  solid: false, era: 2 },
      catapult:   { cost: 20, wood: 3, stone: 2, minEnergy: 56, hp: 60,  solid: false, era: 3 }
    }
  },

  war: {
    feudToSiege: 0.7,         // clan hatred at which siege engines appear
    siegeMinEnergy: 46,
    ram:      { speed: 2.6, reach: 5,  dmg: 5.0 },               // rolls up & smashes
    ballista: { range: 60, cooldown: 26, dmg: 9,  speed: 60 },   // anti-everything bolts
    catapult: { range: 78, cooldown: 70, dmg: 26, splash: 7, speed: 30 }, // wrecks buildings
    musterMin: 3,             // warriors gathered before a war band advances
    musterRadius: 18,         // how tight the band forms up
    retreatEnergy: 30,        // a bloodied warrior falls back
    captureEraReward: 4,      // era-progress the conqueror tribe gains
    captureEnergyReward: 28,  // morale/spoils for nearby victors
    convertChance: 0.6,       // odds a leaderless survivor joins the conqueror
    crewRadius: 5             // a siege engine needs a tribe member this close
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

  tower: {
    arrowCap: 40,             // a fully-stocked tower holds this many arrows
    restockRadius: 26,        // a friendly storehouse this close keeps it fed
    restockTicks: 24,         // one fresh arrow per N ticks per supplying store
    abandonAtArrows: 0        // a dry watchtower under threat is left empty
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
    warThreshold: 0.7         // at/above this a clan marches on the enemy
  },

  logistics: {
    roadRecomputeTicks: 120,  // how often the road network is re-derived
    roadMaxLen: 130,          // longest link the network will pave
    roadWidth: 2.6,           // half-width that counts as "on the road"
    roadSpeedMul: 1.45,       // travel bonus on a road
    horses: 10,               // wild horses roaming the map
    horseSpeed: 8.4,          // faster than anything else
    horseHealth: 26,
    horseFood: 30,
    tameRadius: 2.6,          // reach to attempt taming
    tameChance: 0.06,         // per-attempt odds (curiosity/calm helps)
    mountSpeedMul: 1.7,       // a rider on a tamed horse
    wagonTradeBonus: 2.2      // a horse-drawn caravan hauls far more
  },

  trade: {
    minSurplus: 18,           // food a village stockpile must hold to export
    caravanFood: 12,          // food moved per successful caravan
    bondPerTrade: 0.6,        // goodwill each trade builds between two clans
    bondDecayPerTick: 0.00035, // goodwill fades if trade stops
    bondMax: 4,               // cap; rivalry is cancelled well before this
    rivalRelief: 0.14,        // rivalry removed per point of trade goodwill
    range: 115,               // how far a caravan will travel to a partner
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
  'MINE',
  'STOCKPILE',
  'RAID',
  'SIEGE',
  'TRADE',
  'TAME',
  'HERD',
  'ATTACK'
];

// Primitive vocabulary an agent starts with. Inventions (e.g. weapons,
// hunting parties, farming) are emergent recombinations of these —
// never anything outside this set.
export const PRIMITIVES = ['MOVE', 'GATHER', 'BUILD', 'SIGNAL', 'CRAFT', 'HUNT'];
