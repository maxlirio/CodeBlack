# CodeBlack

A browser-based 3D simulation where simple low-poly humanoid agents live in a
persistent physical world and become a civilization through nothing but local
rules. There is **no central AI controller, no omniscient system, and no neural
networks** — every behaviour emerges from local perception, utility-based
decisions, memory, social ties, survival pressure, evolution, emergent
invention, and cultural diffusion.

![Three.js](https://img.shields.io/badge/Three.js-r169-black) ![No backend](https://img.shields.io/badge/backend-none-success)

## What emerges

- **Embodied agents** — low-poly humanoids with readable silhouettes and a
  facing visor. Animation (idle / walk / run / turn / interact / build /
  attack) is fully procedural limb rotation, blended smoothly and driven
  *only* by the current utility decision.
- **Living nature, not "resources"** — low-poly conifers (stacked cones),
  berry bushes, roaming animal herds (wedge-bodied quadrupeds that graze and
  bolt when agents close in), and farmable crops that visibly grow from
  sprout to golden grain. Everything is built from triangle primitives so it
  reads as what it is.
- **Emergent tech path** — agents start with no tools. Foraging berries is
  subsistence; the real food is animals, but bare hands almost always fail.
  Agents must *learn* to chop **wood** from trees, **craft a flint spear**
  (which then appears in-hand and wears out), and **hunt** — a kill becomes a
  carcass shared with nearby kin/tribe. Settled, well-fed agents **farm**
  crops near home for surplus. None of this is scripted: it falls out of the
  utility scores, reinforcement, and the invention system recombining the
  `MOVE / GATHER / BUILD / SIGNAL / CRAFT / HUNT` primitives.
- **Strict local perception** — limited radius + facing cone + structures
  occlude line of sight. No agent knows the global world state.
- **Utility decisions** — each tick every candidate action is scored from
  energy needs, danger, social context, personality, memory, learned weights
  and discovered skills. Highest score executes and sets the animation.
- **Layered memory** — decaying short-term events + reinforced long-term
  statistics.
- **Mutable personality** — aggression, curiosity, caution, sociability,
  loyalty, risk tolerance. They drift with experience and are inherited.
- **Social system** — per-individual trust / hostility / familiarity updated
  by cooperation, conflict, shared danger and abandonment. Local signals
  (`WARN` / `HELP` / `RALLY`) reshape neighbours' scoring.
- **Emergent groups** — never hardcoded; clustering near trusted agents lowers
  perceived danger, so flocking, alliances and betrayal appear under threat.
- **Homes & families** — building a house creates a *home*; agents return to it
  to rest (faster energy regen) and feel safer there. Two mature, well-fed,
  mutually trusting agents at a home pair-bond and produce children that
  inherit blended traits + skills and stay kin-linked to parents and siblings.
- **Villages & tribes** — agents move into nearby friendly houses instead of
  sprawling, so families cluster into villages. Tribes are *derived*, never
  declared: a union-find pass over the kinship/trust graph plus shared villages
  yields connected components, each given an Age-of-Empires-style banner colour.
- **Fortifications** — when a rival tribe presses a settlement, loyal/cautious
  agents `DEFEND` the perimeter and `FORTIFY` — raising solid wall segments on
  a ring around home that actually block movement and line of sight, growing
  into palisades around contested villages.
- **Low-poly Age-of-Empires loop** — settlements grow real building types:
  **houses** (homes), **storehouses** (a shared, raidable food/wood
  **stockpile** that a stocked granary turns into population growth),
  **watchtowers** (extend tribe vision — unlocked in Era 2), **town
  centres**, and **walls**. Structures have HP, take siege damage, are
  repaired during peace, and can be razed. Hungry aggressive tribes **raid**
  rival stores. Tribes advance through **Eras I→III** as accumulated skills +
  construction cross thresholds (no tech tree — pure emergence), which scales
  structure HP and weapon power. **Wolf packs** roam as a predator pressure,
  hunting prey and lone/weak agents — which is *why* grouping, walls and
  towers pay off. Each agent also shows an emergent **role** (Hunter,
  Woodcutter, Builder, Warrior, Farmer, Keeper…) read from what it has
  learned to do best — never assigned.
- **Construction** — houses and walls are persistent low-poly structures with a
  build animation and energy cost, built only when utility says they improve
  survival/safety. They then reshape navigation and visibility.
- **Learning** — outcomes reinforce/punish per-action weights and nudge traits.
- **Generational evolution** — the fittest survivors parent mutated offspring
  that inherit traits *and* skills (tournament selection).
- **Emergent invention** — agents only ever run four primitives (`MOVE`,
  `GATHER`, `BUILD`, `SIGNAL`). Repeatedly survival-rewarded primitive
  sequences stabilise into named, reusable **skills** that spread by imitation
  and inheritance — a tech tree no one wrote.

## Run locally

```bash
npm install
npm run dev      # open the printed localhost URL
```

Build a static bundle:

```bash
npm run build
npm run preview
```

`?seed=12345` in the URL gives a reproducible world. Click any humanoid to
inspect its mind (traits, current action, skills, relationships). Buttons:
pause/resume, speed (1x/2x/4x), reset world.

## Deploy to GitHub Pages

1. Create a GitHub repo named **`CodeBlack`** and push this project to `main`.
2. In **Settings → Pages**, set **Source = GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) builds and publishes
   `dist/` on every push to `main`.

The site goes live at `https://<your-user>.github.io/CodeBlack/`. The Vite
`base` is preset to `/CodeBlack/`; for a custom domain or root path build with
`BASE_PATH=/ npm run build`.

## Architecture

| File | Responsibility |
|---|---|
| `src/config.js` | All tuning constants + action/primitive vocabulary |
| `src/world.js` | Procedural terrain, lighting, nature lifecycle, structures, LoS |
| `src/nature.js` | Low-poly triangle trees/bushes/crops/animals/weapons + animal AI |
| `src/humanoid.js` | Low-poly rig + procedural blended animation |
| `src/perception.js` | Local radius + cone + occlusion sensing |
| `src/memory.js` | Short-term decay + long-term reinforced memory |
| `src/personality.js` | Traits, inheritance, experiential drift |
| `src/social.js` | Per-individual relationship ledger + signals |
| `src/tribes.js` | Stable union-find tribes + emergent Era progression |
| `src/decision.js` | Utility action scoring (the "mind") |
| `src/skills.js` | Emergent invention + cultural diffusion |
| `src/entity.js` | Agent integrating all systems per tick |
| `src/evolution.js` | Generational tournament replacement |
| `src/simulation.js` | Fixed-tick loop, renderer, camera, UI |

All complexity is emergent: no entity can modify engine or runtime logic.
