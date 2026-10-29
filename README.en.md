# All-In-One Finder

**English** | [简体中文](README.md)

A **set-seed** desktop tool for Minecraft Java Edition 1.18+: browse seed maps and run a variety of structure / terrain searches in a single window, shipped as a Windows executable.

## Features

### Seed Map

- Enter a world seed and game version to browse **Overworld / Nether / End** biome maps
- Supports Large Biomes, sample Y, coordinate grid, zoom, and pan
- Overlays common structures and features (toggle by type)
- Jump to coordinates; parse coordinates from `/tp` or `(x, z)` text
- Optionally draw spawn rings (24 / 128) to help plan AFK spots
- Export / import sessions

### Searchers

| Searcher | Purpose |
|----------|---------|
| **Low-Y Swamp Hut** | Finds low-Y swamp huts within the given bounds; supports single seed / seed list |
| **River** | Finds the point with the largest river area inside the spawn ring (24 < distance <= 128); optionally counts dripstone cave area |
| **Low-Y Dripstone Cave** | Finds areas with low-Y dripstone caves inside the spawn ring (24 < distance <= 128) |
| **Large-Pit Low-Y Dripstone Cave** | Finds "large-pit" low-Y dripstone caves for some seeds much faster than the normal search |
| **Slime Chunks** | Finds the AFK point with the largest slime spawning area inside the spawn ring (24 < distance <= 128); optionally converts biomes at y=-63 |
| **Double Ocean Monument** | Finds double ocean monuments (requires 100% of both monuments' area inside the spawn ring) |
| **Multi Ocean Monument** | Finds triple/quadruple ocean monuments; supports single dummy / dual dummy / single gate area bases and shows the matching effective area |
| **Fortress Crossroads** | Finds double/triple/quadruple crossroads in **soul sand valleys** (requires no other biome within a 64-block radius) |
| **Fortress Large Range** | Finds fortresses whose overall span (long/short edge, height) exceeds the requirements; supports four border-corner modes |
| **Trial Spawner** | Finds the AFK point with the most converted spawners inside the statistics window; the window can be circular or square |
| **Budding Amethyst** | Finds the AFK point with the most budding amethyst and geodes within the player's random-tick range; can optionally use the GPU for coarse screening |
| **All Flower Farm** | Finds a site for an all-flower farm in the Overworld; the window must contain flower forest / pale garden / swamp, may optionally include birch and cherry grove, and can show the Nether biome |

Supports single seeds or seed lists, thread count, search bounds (square by default or world border), progress, and pause/stop; results are sorted by each searcher's own rules, truncated to the top 1000 entries, and can then be exported.

Map and structure locating rely on [cubiomes](https://github.com/xpple/cubiomes) (`tools/cubiomes`).

## Technical Overview

| Layer | Technology |
|-------|------------|
| Desktop shell | Custom Win32 + WebView2 host (system Evergreen runtime) |
| Frontend | Vite + TypeScript (hand-written DOM, no React/Vue) |
| Native engine | C/C++ DLL (cubiomes map and all searchers), stable C ABI + JSON |
| Process model | Host + `--engine` child process (anonymous pipes, length-prefixed JSON, single-threaded serial) |
| Packaging | NSIS portable (single-file LZMA) |

## Development and Packaging

Requirements: Node.js (>= 22 recommended), GCC / CMake / Ninja from MSYS2 UCRT64, and the WebView2 Evergreen Runtime (usually bundled with Edge on Windows 10/11).

```powershell
git submodule update --init --recursive
npm install

npm run build       # frontend -> dist/
npm run engine      # C engine -> native/build-engine/allinone.dll
npm run host        # host -> native/host/build/aio-host.exe (with icon and version resources)
npm run package     # assemble stage + NSIS -> release/All-In-One Finder <version>.exe
```

Development and regression:

```powershell
npm run dev         # Vite 5173 + host --dev (renderer hot reload)
npm run regression  # 28 native cases, run through the same engine via aio-engine --serve
npm run verify      # release gate: size / version resources / stage manifest / system DLL dependencies / smoke test
```

Notes:

- The portable build is extracted to `%TEMP%` before running; sessions are saved to `%LOCALAPPDATA%\All-In-One Finder\session` first. If that location is not writable, it falls back to `%APPDATA%\All-In-One Finder`, `Documents\All-In-One Finder`, or `%TEMP%\All-In-One Finder`; the WebView2 profile and the trial/geode checkpoints live under the same writable base directory. Set the `AIO_SESSION_BASE` environment variable to force a base directory. A legacy `session/map.json` next to the exe is migrated automatically on first launch.
- `npm run engine` requires the submodules and only supports MSYS2 UCRT64 (the engine relies on GCC's floating-point behavior and AVX2 optimization).
- WebView2 requires an Evergreen Runtime from 2021 or later (`ICoreWebView2_3`); if it is missing, a dialog prompts you to install it.

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
- Low-Y Swamp Hut: <https://github.com/M33Galaxy/LowYSwampHut>, authors: M33_Galaxy, SunnySlopes
- River: <https://github.com/SunnySlopes/RiverFinderGUI>,
  <https://github.com/Melationin/RiverFinder>, authors: Ruo_Mo, SunnySlopes
- Low-Y Dripstone Cave and Large-Pit Low-Y Dripstone Cave: <https://github.com/SunnySlopes/LowYDripstoneCaveFinderGUI>, author: SunnySlopes
- Slime Chunks: <https://github.com/CITYWIDESIGN/SlimeRadar>,
  <https://github.com/CITYWIDESIGN/SlimeOptimizer>, author: Bot_City
- Double Ocean Monument: <https://github.com/SunnySlopes/DoubleMonumentForFixedSeed>, author: SunnySlopes
- Multi Ocean Monument: <https://github.com/Whisperlyric/MultiMonumentFinder>, authors: Whisperlyric, SunnySlopes
- Fortress Crossroads and Fortress Large Range: <https://github.com/SunnySlopes/FortressFinderGUI>, author: SunnySlopes
- Trial Spawner: <https://github.com/qk-yiyihehe/trial-spawner-native>, author: qk-yiyihehe
- Budding Amethyst: <https://github.com/qk-yiyihehe/geode-native>, author: qk-yiyihehe
- All Flower Farm: <https://github.com/SunnySlopes/FlowerFinderGUI>, author: SunnySlopes
- The Low-Y Dripstone Cave Searcher and the All Flower Farm Searcher also thank M33_Galaxy for guidance
