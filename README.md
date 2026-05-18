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
- **Construction** — agents build persistent low-poly structures (energy cost,
  build animation) only when utility says it improves safety. Structures then
  block sight and reshape navigation.
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
| `src/world.js` | Procedural terrain, lighting, scarce resources, structures, LoS |
| `src/humanoid.js` | Low-poly rig + procedural blended animation |
| `src/perception.js` | Local radius + cone + occlusion sensing |
| `src/memory.js` | Short-term decay + long-term reinforced memory |
| `src/personality.js` | Traits, inheritance, experiential drift |
| `src/social.js` | Per-individual relationship ledger + signals |
| `src/decision.js` | Utility action scoring (the "mind") |
| `src/skills.js` | Emergent invention + cultural diffusion |
| `src/entity.js` | Agent integrating all systems per tick |
| `src/evolution.js` | Generational tournament replacement |
| `src/simulation.js` | Fixed-tick loop, renderer, camera, UI |

All complexity is emergent: no entity can modify engine or runtime logic.
