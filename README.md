# Hana Matsuri — Festival After Dusk

CS549 Artificial Intelligence for Visual Computing — group project.
Shweatha Bathina Mallikarjuna (sb2808, lead) · Chiranjeevi Bhuvaneshwari Pamarthy (cp1270) · Jayanth Jayaram Jayakumar Naidu (jj1112) · Prithvi Govindareddy (pg708)

A browser-based 3D Japanese festival built with Three.js (WebGL). The player walks a lantern-lit festival
street from afternoon to night, plays festival games, and ends with a particle fireworks finale.

**Live build:** https://hana-matsuri.vercel.app

## MVP (Assignment 3): Goldfish Scooping (Kingyo-sukui)

`src/games/goldfish.js`

- **Animated fish:** a rigged goldfish glTF model, cloned per fish with `SkeletonUtils`; each fish has its own
  `AnimationMixer` that blends `Swim_Slow` / `Swim_fast` by speed and plays `jump` when caught.
- **Fish behaviour:** boids (separation, alignment, cohesion) + tub-wall avoidance + fleeing from the
  submerged poi; fish change depth over time and dive when frightened.
- **Water:** real-time height-field simulation (discrete 2D wave equation on a grid, fixed 60 Hz step,
  damping, reflecting borders). The poi, splashes, caught fish and shallow fish disturb the surface.
- **Collision:** a fish is scooped when its body circle overlaps the paper disc *and* it swims above the
  paper's depth at the moment of lifting. Paper strength drops with water drag (poi speed) and fish weight.
- **Game loop:** walk to stall → press E → control poi → water reacts → catch fish → yen reward, prize,
  objective marked complete, firework pattern unlocked.

### Minigame controls

| Key | Action |
|---|---|
| Mouse move | Aim the poi |
| Hold / release mouse | Dip / lift the poi |
| V | Show collision circles (green = catchable, red = too deep) |
| P | Stress test: add 20 animated fish (up to 600) |
| O | Cycle water grid resolution (64 → 384 cells wide) |
| R | Reset stress test |
| Esc | Leave the minigame |

The HUD shows live FPS, fish count, water grid size and water simulation time.

## Festival controls

WASD move · Shift run · mouse (click to lock) or arrow keys look · E interact · T afternoon → dusk → night ·
F fireworks · N NPC behaviour-tree / navigation debug view · G graphics quality · H help.

## Build and run

Requires Node.js 18+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build
```

Deploy: upload the contents of `dist/` to any static host (we use Vercel).

## Project structure

```
index.html              HUD, menus, styles
src/main.js             renderer, post-processing, game modes, input, minimap, main loop
src/world.js            environment, sky, day/night lighting, shrine, lanterns, trees
src/player.js           first-person controller
src/collision.js        2D collision world (boxes + circles), sphere-vs-box tests
src/nav.js              grid navigation, A*, path smoothing
src/npc.js              procedural characters, behaviour trees, stall-owner state machines
src/fireworks.js        CPU-integrated particle fireworks (gravity, drag, trails, splitting stars)
src/games/goldfish.js   MVP: goldfish scooping, boids, height-field water
src/games/shateki.js    shooting gallery (cork ballistics, toppling prizes)
src/games/taiko.js      taiko rhythm game
src/games/kimodameshi.js haunted forest path
src/audio.js            synthesised WebAudio sound effects
public/models/          compressed glTF assets
```

## Credits

- Festival street: "Summer festival of Japan 'Yataimura'" by seirogan (Sketchfab), CC-BY-4.0.
  Compressed with gltf-transform for the web.
- Goldfish: "Goldfish_Variety 3" by Picasty (Sketchfab), CC-BY-4.0.
- Cherry trees: "Sakura Tree 01 - Low Poly Model" by Jogoss (Sketchfab), CC-BY-4.0.
- Forest trees: "a forest (3) with a road at night for game" by dasy444 (Sketchfab), CC-BY-4.0.
- Libraries: three.js, Vite.
