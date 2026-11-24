# All-In-One Finder

**English** | [简体中文](README.md)

A **set-seed** desktop tool for Minecraft Java Edition 1.18+: browse seed maps and run a variety of structure / terrain searches in a single window, shipped as a Windows executable.

## Features

### Seed Map

- Enter a world seed and game version to browse **Overworld / Nether / End** biome maps
- Supports Large Biomes, sample Y, coordinate grid, zoom, and pan
- Overlays common structures and features (toggle by type)
- Optional "Show terrain": **1:1 only** (one block per pixel) draws the real overworld surface with hill shading over the biome colours; 1:4 and coarser stay on the biome map. Relief, cave openings and the lava sea are one single toggle (there is no separate caves option, and no contour/boundary lines are drawn)
- The relief comes from the full density field; lava openings that reach the surface get a translucent orange fill, while water and dry openings are not annotated
- With a sample Y below 256 (negative values included), terrain above that height is flattened to the sample height (both the painted relief and the hovered `Y=` read the sample height); flattened columns keep their biome colour and the lava note is skipped while the sample height is below the lava level
- Anything whose top solid block is below the lava level (y <= -55) is painted as lava (the vanilla lava sea), so deep voids show up orange; hovering reads `Y=` (cubiomes' topmost solid block, `-64` with a "theoretical" marker when no solid was found) and `lava=-54` for lava-sea columns
- Jump to coordinates; parse coordinates from `/tp` or `(x, z)` text
- Optionally draw spawn rings (24 / 128) to help plan AFK spots
- Export / import sessions

### Searchers

| Searcher                           | Purpose                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Low-Y Swamp Hut**                | Finds low-Y swamp huts within the given bounds; supports single seed / seed list                                                                                                                |
| **River**                          | Finds the point with the largest river area inside the spawn ring (24 < distance <= 128); optionally counts dripstone cave area                                                                 |
| **Low-Y Dripstone Cave**           | Finds areas with low-Y dripstone caves inside the spawn ring (24 < distance <= 128); the sample Y window can be set, and an experimental GPU coarse scan can be enabled manually                |
| **Large-Pit Low-Y Dripstone Cave** | Finds "large-pit" low-Y dripstone caves for some seeds much faster than the normal search; the sample Y window can be set                                                                       |
| **Slime Chunks**                   | Finds the AFK point with the largest slime spawning area inside the spawn ring (24 < distance <= 128); optionally converts biomes at y=-63                                                      |
| **Double Ocean Monument**          | Finds double ocean monuments (requires 100% of both monuments' area inside the spawn ring)                                                                                                      |
| **Multi Ocean Monument**           | Finds triple/quadruple ocean monuments; supports single dummy / dual dummy / single gate area bases and shows the matching effective area                                                       |
| **Fortress Crossroads**            | Finds double/triple/quadruple crossroads in **soul sand valleys** (requires no other biome within a 64-block radius)                                                                            |
| **Fortress Large Range**           | Finds fortresses whose overall span (long/short edge, height) exceeds the requirements; supports four border-corner modes                                                                       |
| **Trial Spawner**                  | Finds the AFK point with the most converted spawners inside the statistics window; the window can be circular or square                                                                         |
| **Budding Amethyst**               | Finds the AFK point with the most budding amethyst and geodes within the player's random-tick range; can optionally use the GPU for coarse screening                                            |
| **All Flower Farm**                | Finds a site for an all-flower farm in the Overworld; the window must contain flower forest / pale garden / swamp, may optionally include birch and cherry grove, and can show the Nether biome |

Supports single seeds or seed lists, thread count, search bounds (square by default or world border), progress, and pause/stop; results are sorted by each searcher's own rules, truncated to the top 1000 entries, and can then be exported.

The Low-Y Dripstone Cave page lets you set the precise sample Y window (default -63..-51, hard span cap 48 layers). Scoring uses the AFK point at Y=-40 as the shell centre: each layer counts every cave/river cell inside the 24..128 shell (no chunk-level culling), then the layers are averaged. Its default river weight is 0.70 and default area ratio 70%; the large-pit page has the same Y window fields and follows the same shell rule (river area is not counted).

Map and structure locating rely on [cubiomes](https://github.com/xpple/cubiomes) (`tools/cubiomes`).

### Loot Layers (`tools/loots`)

The map page has a **Show loot** switch below **Show terrain**. When enabled, it evaluates target loot for the structures currently visible and marks hits on the map; when disabled, no loot requests or markers are made.

- **Coordinate layers**: ancient city, woodland mansion, nether fortress, bastion remnant, end city, stronghold, ocean ruin, trail ruins, abandoned mineshaft, trial chamber (Creator pots).
  - Chests/blocks with target content become clickable rings; the ring colour comes from the trim kind. Chests/blocks without target content are not marked.
  - Clicking a ring opens the structure card with coordinates and hit details.
  - Ocean-ruin and trail-ruins hits are **blocks** (suspicious sand/gravel), not chests; the card labels them as blocks.
  - Silence chests use a dedicated icon instead of a ring.
  - Bastion piglin banner pattern (`piglin_banner_pattern`) chests use a pink ring; when the same chest also has a trim, the trim colour wins.
  - **Ancient cities, trail ruins, and trial pots have no 12-line cap**: ancient cities list every matching chest, trail ruins list every block that has a template (blocks without a template are omitted; each row identifies the template), and trial chambers list every Creator pot and every flow/guster/scrape patterned pot.
  - **Music discs**: Pigstep, Otherside, Relic, Bounce, Creator (music box), and disc fragment 5 share one disc colour. Bounce/Creator use dedicated icons and override other categories (silence still wins). Fragment chests list their count per chest; there is no "9 fragments craft a disc" summary. Abandoned-mineshaft chest minecarts are exact in the verified samples, so Bounce is no longer suffixed "(approximate)" and the dashed ring is gone; a few chunk-order-sensitive mineshafts are listed under Known limitations.
  - **Trial chambers**: pots that actually roll Creator (music box) plus flow/guster/scrape patterned pots are marked; sherds are mapped from the template name, and positions match the 26.3 server (see Known limitations for the Creator loot-seed caveat).
  - **Pottery sherds**: 21 tracked exactly (7 trail ruins, 3 trial-chamber patterned pots, 3 warm ocean, 4 cold ocean, 4 desert pyramid) share one sherd colour; desert-well (2) is not exact yet and shows a `?` badge when loot+sherd is on. Trail/ocean/trial mark per block/pot; desert pyramids use a structure-corner badge and list suspicious-sand xz in the info card.
- **Loot category filters**: with Show loot enabled, four checkboxes (Misc / Templates / Music discs / Pottery sherds) appear, all on by default. They only filter drawing and the info card, never the native evaluation. Unchecked categories draw no rings/badges and are omitted from the card; selecting Music discs also shows the "dungeons are not supported" note.
- **Known limitations (loot coordinates/contents)**: these layers are implemented but do not reach per-chest/per-block parity with the live server. The UI does not mark them as approximate; this list is the reference:
  - **Abandoned mineshafts (Bounce source)**: the result depends on chunk generation order (monster rooms, lava lakes, and other features write across chunks). Replaying in oracle order still leaves a few mineshafts that differ by 1–2 chests, so Bounce can be missed or shown wrongly.
  - **Trial pots (Creator source)**: pot positions/templates are exact; 26 of 47 loot seeds match the oracle, so Creator detection can be affected. Patterned-pots sherds (flow/guster/scrape) come from template names and are unaffected.
  - **Ocean ruins (warm/cold sherds)**: suspicious-block coordinates are not exact yet (warm sample 23 vs oracle 29; cold 10–13 vs 5–9, large ruins 87 vs 57). Sherd contents come from exact loot tables, but positions are not guaranteed.
  - **Trail ruins (Relic + 7 sherds)**: 6 of 8 in-game samples match; 2 differ by one block or position.
  - **Version verification**: the worldgen Java oracle only runs on 26.3. Multi-version loot-table verification (including discs and sherds) comes from the `generate_golden.py` golden oracle: it reads every 1.18.2–26.3 jar, generates expectations with an independent Python implementation, and `loots-goldentest` compares per-seed results for every supported version (including the disc/sherd bit masks).
- **Hint-only layers**: ocean monument, desert pyramid, jungle temple, pillager outpost, shipwreck.
  - No chest/block coordinates are shown; the corresponding icon is overlaid in the corner of the original structure icon.
  - An outpost with an allay cage gets the allay overlay, and a sentry template adds the sentry overlay; both can appear together. The card shows `Contains: allay cage xN` and/or `sentry armor trim`; the cage count comes from the exact jigsaw placement.
  - Desert pyramids / jungle temples / shipwrecks add dune / wild / coast trim overlays.
  - An ocean monument with sponge rooms adds the sponge overlay at the top-right.
  - Only `allay_loot`, `trim_dune`, `trim_coast`, `trim_sentry`, and `trim_wild` are overlay sources; silence and sponge keep their existing dedicated icons. The base icon position and size are unchanged.
- Overworld, Nether, and End structure toggles are shown together; changing dimension only changes the map content, not the icon categories.
- Ancient cities, woodland mansions, and bastion remnants no longer draw an outer frame.

Technical details:

- The code lives in the `tools/loots` submodule and is linked as `libloots`. Structure positions come from `tools/cubiomes`; loots' built-in worldgen provides exact terrain, ancient-city layout, and stronghold End-portal rooms.
- Loot tables, templates, jigsaw data, and chest-layout headers are committed, so a fresh clone builds without a Minecraft jar.
- The 26.3 Java query is only an oracle and is not shipped.
- Stronghold End-portal room coordinates come from loots' `stronghold.h` API; the map no longer depends on geode's stronghold simulator. Stronghold library eye-trim chests use per-version library tables for 1.20.1-26.3; the 1.18-26.3 portal/eye-frame path is shared.
- `tools/loots/tests/` and `tools/loots/tools/` are development/test helpers excluded by the loots submodule `.gitignore`; they are not part of the app package.

Current accuracy notes:

- 26.3 ancient city, woodland mansion, end city, and stronghold were checked item by item; ancient-city and mansion layouts/chest coordinates were compared across 1.19.2-26.3. 1.19.2 mansions have no armor-trim templates, so neither templates nor chests are shown.
- Bastion remnants, trail ruins, and pillager-outpost allay cages use loots' single shared exact JigsawPlacement port for **1.20.1 through 26.3**; pillager-outpost allay cages also cover **1.19.2** (same outpost templates/pools/config, generation profile -3). The 1.20.1+ jars carry identical bastion/trail-ruins/outpost jigsaw data; only the terrain height profile changes by version group. Bastion piece expansion, chest X/Y/Z, loot seeds, treasure chests, and piglin banner patterns are version-independent; the test set covers 15 bastion starts (13 treasure variants).
- Trail ruins use the version-aware `WORLD_SURFACE_WG` height plus the RuleProcessor/CappedProcessor/AppendLoot chain; the real-jar fixtures for 1.20.1/1.21.10/1.21.11 match every suspicious block, table, seed, and trim result on 1.20.1-26.2. Outposts use the same data with the version-aware height and `outpost_rot` survival; their piece graphs, chests, seeds, and allay cage counts match the jar fixtures.
- With the correct start coordinate, cubiomes' nether-fortress X/Z piece graph matches 26.3. loots now applies the `moveInsideHeights` Y correction and recomputes chests from Java's corner-piece local coordinates. Chest positions, Y and loot seeds for `16080,24544` and `15360,26640` match the 26.3 oracle. Source checks across 1.20.1/1.21.5/1.21.11 show unchanged placement data for outpost and bastion; fortress uses the same 1.20+ path.
- Ocean-ruin sniffer eggs/suspicious sand use loots' shared 1.20.1-26.3 templates, chest tables, and processor data; warm suspicious-sand coordinates match the 26.3 oracle, and 1.20+ uses the matching version terrain profile. Terrain updates and overlapping structures may still affect the final world state.
- Trial-chamber pots use loots' own layout + post-process RNG replay. For seed 0 at structure `-800,-1008`, all 47 pot positions, templates, and loot seeds match the 26.3 server exactly.
- **Abandoned mineshafts**: geode's 1:1 generator is ported into loots (`src/mineshaft/mineshaft_gen.*`); pieces, orientation, section, real `dy`, and the 26.3 piece graph match the server. Chest replay follows 26.3 `MineShaftCorridor.postProcess` block state and RNG step by step (`src/mineshaft/block_view.h`), including the structure-set normal/badlands variant selection and each variant's post-process RNG index. For seed 0, seven fixtures (badlands, a real mesa, liquid skips, spider corridors, rails) with 33 chests match the 26.3 oracle in position and loot seed. Each 1.18.2–1.21.10 jar was decompiled and compared with 1.21.11: the mineshaft piece/post-process code is logically identical, so **1.18.2–26.3 are no longer marked approximate**; the fallback is only used below 1.18.2. Step 1–3 features (monster rooms, lava lakes, geodes) can write blocks into a chunk from a previously decorated neighbour, so vanilla's own result depends on chunk generation order; a few mineshafts overlapping a monster room may still differ by 1–2 chests. See `docs/loot-layers-integration-status.md` §6.

Module build instructions, CLI, directory layout, and data generation are documented in [tools/loots/README.zh-CN.md](tools/loots/README.zh-CN.md).

## Technical Overview

| Layer         | Technology                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Desktop shell | Custom Win32 + WebView2 host (system Evergreen runtime)                                         |
| Frontend      | Vite + TypeScript (hand-written DOM, no React/Vue)                                              |
| Native engine | C/C++ DLL (cubiomes map and all searchers), stable C ABI + JSON                                 |
| Process model | Host + `--engine` child process (anonymous pipes, length-prefixed JSON, single-threaded serial) |
| Packaging     | NSIS portable (single-file LZMA)                                                                |

## Development and Packaging

Requirements: Node.js (>= 22 recommended), GCC / CMake / Ninja from MSYS2 UCRT64, and the WebView2 Evergreen Runtime (usually bundled with Edge on Windows 10/11).

Besides Vite and TypeScript, `npm install` also installs the frontend checking tools (ESLint 9 + typescript-eslint 8 + Prettier 3). They are only used while developing/checking the frontend and **do not take part** in the `npm run engine` / `npm run host` / `npm run package` native builds, nor do they affect the size of the shipped exe.

```powershell
git submodule update --init
npm install

npm run build       # frontend -> dist/
npm run engine      # C/C++ engine -> native/build-engine/allinone.dll
npm run host        # host -> native/host/build/aio-host.exe (with icon and version resources)
npm run package     # assemble stage + NSIS -> release/All-In-One Finder <version>.exe
```

Development and regression:

```powershell
npm run dev         # Vite 5173 + host --dev (renderer hot reload)
npm run regression  # about 30 native cases (incl. the terrain/cave layer protocol), via aio-engine --serve
npm run verify      # release gate: size / version resources / stage manifest / system DLL dependencies / smoke test
```

Checks and formatting:

```powershell
npm run typecheck       # tsc --noEmit (full strict-mode type check)
npm run lint            # ESLint (type-aware rules: unused code, floating promises, ...)
npm run lint:fix        # same, with automatic fixes where possible
npm run check           # typecheck + lint; run this before committing
npm run format          # Prettier write over src/, scripts/ and the root configs
npm run format:check    # Prettier check only, no writes (for CI)
npm run regression:compare  # diff two regression payloads (baseline vs current) for exact equality
```

Regression artifacts are written to `test-results/` (git-ignored) instead of the repository root. `scripts/scratch/` holds throwaway investigation scripts; it is not version-controlled and is free to reuse.

Notes:

- The portable build is extracted to `%TEMP%` before running; sessions are saved to `%LOCALAPPDATA%\All-In-One Finder\session` first. If that location is not writable, it falls back to `%APPDATA%\All-In-One Finder`, `Documents\All-In-One Finder`, or `%TEMP%\All-In-One Finder`; the WebView2 profile and the trial/geode checkpoints live under the same writable base directory. Set the `AIO_SESSION_BASE` environment variable to force a base directory. A legacy `session/map.json` next to the exe is migrated automatically on first launch.
- `npm run engine` requires the submodules and only supports MSYS2 UCRT64 (the engine relies on GCC's floating-point behavior and AVX2 optimization).
- The GPU coarse scan is an optional runtime feature: OpenCL is loaded dynamically from `OpenCL.dll`, so building and packaging need neither an NVIDIA GPU, CUDA, nor an OpenCL SDK. With no usable device the engine falls back to CPU automatically. The cave page's switch is off for a new session and is saved in the session once enabled; the engine's stderr (including the OpenCL device line) goes to `engine.log` in the session directory instead of sharing the JSON pipe.
- Do not use `--recursive` for the search submodules: their nested `cubiomes/` checkouts must stay uninitialized so the engine compiles only the shared `tools/cubiomes`; otherwise a duplicate or mismatched cubiomes header set is used.
- The river kernel (DrownedCombinedFinder) keeps the historical path `tools/river`; its contents are now this engine rather than the old RiverFinder JNI. Upstream names the repository `river-native`, but this repository's directory, `.gitmodules` and `native/CMakeLists.txt` all use `tools/river`.
- The repository root only holds sources and configuration: native build output lives under `native/build*` (ignored), frontend output in `dist/`, packaged output in `release/`.
- WebView2 requires an Evergreen Runtime from 2021 or later (`ICoreWebView2_3`); if it is missing, a dialog prompts you to install it.

## TODO

1. Add No Slime Chunks searcher

## License

This project is distributed under the **GNU General Public License v3 (GPLv3)**, SPDX identifier: `GPL-3.0-only`.  
Copyright (C) 2026 SunnySlopes

The full terms are in [LICENSE](LICENSE) in the repository root, or at <https://www.gnu.org/licenses/gpl-3.0.html>. Key points:

- You may run, study, modify, and redistribute this software freely, including commercial use;
- When redistributing (including modified versions), you must provide the complete corresponding source code under GPLv3, retain the copyright and license notices, and state the changes;
- This software comes with no warranty; see sections 15 and 16 of the license.

## Acknowledgements

Thanks to everyone who contributed; without your contributions this finder would not exist.

- UI author: SunnySlopes, with design inspired by SlimeFinderGUI, author: Bot_City
- Map display: <https://github.com/xpple/cubiomes>, authors: Cubitect, xpple
- Low-Y Swamp Hut: <https://github.com/M33Galaxy/LowYSwampHutFinderBase>, authors: M33_Galaxy, SunnySlopes
- River: <https://github.com/SunnySlopes/DrownedCombinedFinder>, author: qk-yiyihehe
  (river kernel derived from <https://github.com/Melationin/RiverFinder>, author: Ruo_Mo)
- Low-Y Dripstone Cave and Large-Pit Low-Y Dripstone Cave: <https://github.com/SunnySlopes/LowYDripstoneCaveFinderBase>, author: SunnySlopes
- Slime Chunks: <https://github.com/CITYWIDESIGN/SlimeRadar>,
  <https://github.com/CITYWIDESIGN/SlimeOptimizer>, author: Bot_City
- Double Ocean Monument: <https://github.com/SunnySlopes/doubleMonumentFinderBase>, author: SunnySlopes
- Multi Ocean Monument: <https://github.com/SunnySlopes/DoubleMonumentForFixedSeed>, authors: Whisperlyric, SunnySlopes
- Fortress Crossroads and Fortress Large Range: <https://github.com/SunnySlopes/FortressFinderBase>, author: SunnySlopes
- Trial Spawner: <https://github.com/SunnySlopes/trial-spawner-native>, author: qk-yiyihehe
- Budding Amethyst: <https://github.com/SunnySlopes/geode-native>, author: qk-yiyihehe
- All Flower Farm: <https://github.com/SunnySlopes/FlowerFinderBase>, author: SunnySlopes
- Loot layers: <https://github.com/SunnySlopes/LootsFinder>, author: SunnySlopes
- The Low-Y Dripstone Cave Searcher and the All Flower Farm Searcher also thank M33_Galaxy for guidance
