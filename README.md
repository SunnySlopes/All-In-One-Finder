# 定种多功能搜索器（All-In-One Finder）

**简体中文** | [English](README.en.md)

面向 Minecraft Java 版1.18+的**定种**桌面工具：在同一个窗口里浏览种子地图，并运行多种结构 / 地形搜索，打包形态为 Windows exe文件。

## 功能

### 种子地图

- 输入世界种子与游戏版本，浏览**主世界 / 下界 / 末地**群系地图
- 支持大型生物群系、采样 Y、坐标网格、缩放与平移
- 叠加常见结构与地物图标（可按类型勾选）
- 可选「展示地形」：**只在 1:1**（1 格 = 1 像素）绘制真实地表高度，叠加高程阴影，底图仍是群系颜色；1:4 及更远只显示群系地图。地形、洞穴开口与岩浆海是同一个开关，不再有独立的洞穴选项，也没有等高线/边界线叠加
- 地形按完整密度场绘制；通到地表的岩浆开口以橙色半透明填充，水开口与干开口不再标注
- 采样 Y 低于 256 时（含负值），高过采样高度的地形按采样高度削平（地图高度与悬停 `Y=` 都显示采样高度）；削平列保留原群系颜色，采样高度在岩浆面以下时悬停不再标注岩浆
- 地表低于岩浆面（y ≤ -55）的格子统一按岩浆绘制（原版世界底部岩浆海），因此底层洞穴与空洞会显示为橙色；悬停 `Y=` 为 cubiomes 返回的最顶层固体方块（找不到固体时为 -64，标“理论值”），`lava=-54` 表示该列是岩浆海
- 坐标跳转、 `/tp` 或 `(x, z)` 文本解析坐标
- 可选绘制刷怪环（24 / 128）辅助规划挂机点
- 会话可导出 / 导入

### 搜索器

| 搜索器               | 用途                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **低 Y 女巫小屋**    | 在给定范围内搜索低Y女巫小屋，支持单种子 / 种子列表                                                               |
| **河流**             | 搜索刷怪环（24 < 距离 <= 128）内河流面积最大的点，可选计入溶洞面积                                               |
| **低 Y 溶洞**        | 搜索刷怪环（24 < 距离 <= 128）内低Y存在溶洞的区域，可设置采样Y范围，可手动启用实验性 GPU 粗筛                    |
| **大坑低 Y 溶洞**    | 在部分种子中以远快于正常搜索的速度寻找「大坑」类低Y溶洞，可设置采样Y范围                                         |
| **史莱姆搜索器**     | 搜索刷怪环（24 < 距离 <= 128）内史莱姆生成面积最大的挂机点，可选按 y=-63 群系折算                                |
| **二联海底神殿**     | 搜索二联海底神殿（要求二联神殿100%面积在刷怪环内）                                                               |
| **多联海底神殿**     | 搜索三/四连海底神殿，可选单假人 / 双假人 / 单门三种面积口径，展示对应有效面积                                    |
| **下界要塞十字路口** | 搜索**灵魂沙峡谷**中的二联/三联/四联十字路口（要求周围64格半径内无其他群系）                                     |
| **下界要塞大范围**   | 搜索整体跨度（长/短边、高度）大于要求的要塞，支持边境四角模式                                                    |
| **试炼刷怪笼**       | 搜索密室统计窗口内折算刷怪笼最多的挂机点，窗口支持圆形 / 方形                                                    |
| **紫水晶母岩**       | 搜索玩家随机刻范围内母岩、晶洞数最多的挂机点，支持自动调用GPU进行粗筛                                            |
| **全花种**           | 搜索主世界全花种农场选址，要求窗口范围内包含繁花森林 / 苍白花园 / 沼泽，可选包含桦木、樱花树林，支持查看地狱群系 |

支持单种子或种子列表、线程数、搜索范围（默认正方形或世界边界）、进度与暂停/停止；结果统一按各搜索器规则排序并截断前 1000 条后导出。

低 Y 溶洞页可设置采样 Y 范围（默认 -63..-51，跨度上限 48 层）；计分以挂机点 Y=-40 为球心，逐层统计 24~128 球壳内的洞穴/河流格（球壳内全部计入，不再按区块裁剪），再按层数取平均。该页默认河流折算系数 0.70、面积占比 70%。大坑低 Y 溶洞页也有同一组 Y 范围填框，并按相同的球壳规则计算（不计河流面积）。

地图与结构定位底层依赖 [cubiomes](https://github.com/xpple/cubiomes)（`tools/cubiomes`）。

### 战利品图层（`tools/loots`）

地图页新增「展示战利品」开关，位于「展示地形」下面。勾选后，对当前已显示的结构求值目标战利品，并把命中位置标记在地图上；未勾选时不请求、不绘制任何战利品标记。

- **逐坐标型**：远古城市、林地府邸、下界要塞、堡垒遗迹、末地城、要塞、海底遗迹、古迹废墟、废弃矿井、试炼密室（Creator 陶罐）。
  - 有目标内容的箱子/方块画成可点击的圆环，圆环颜色来自纹饰类型；无目标内容的箱子/方块不标记。
  - 点击圆环可打开结构信息卡查看坐标与命中内容。
  - 海底遗迹、古迹废墟等命中位置是**方块**（可疑沙/可疑砂砾），不是箱子；信息卡会显示为「方块」。
  - 幽静（Silence）箱子使用专用图标，不画圆环。
  - 堡垒遗迹的猪灵旗帜图案（`piglin_banner_pattern`）用粉色圆环标出对应箱子；与纹饰同箱时优先显示纹饰颜色。
  - 古迹废墟模板方块全部列出（不设 12 条上限），只输出有模板的方块，不输出没有模板的方块；每行标出该方块对应的模板。
  - **唱片**：Pigstep、Otherside、Relic、Bounce、Creator（八音盒）与 5 号碎片统一用唱片色；Bounce/Creator 使用独立图标，出现即覆盖其他类别（幽静除外）。5 号碎片逐箱显示数量，不汇总“9 个可合成”。废弃矿井的箱子矿车是近似结果：Bounce 名称带“（近似）”，圆环外加虚线，信息卡显示说明。
  - **试炼密室**：只标出真正开出 Creator（八音盒）的饰纹陶罐，坐标和 loot seed 与 26.3 服务端 oracle 一致。
- **战利品类别筛选**：勾选「展示战利品」后显示「杂项 / 模板 / 唱片」三个复选框（默认全开），只影响绘制和信息卡，不改变 native 求值。未选中的类别不画圆环/角标、不列信息卡；只选“唱片”时显示 Otherside 地牢不支持提示。
- **仅提示型**：海底神殿、沙漠神殿、丛林神殿、掠夺者前哨站、沉船。
  - 不显示箱子/方块坐标，只在原结构图标角落叠加对应图标。
  - 前哨站有悦灵时右上角叠加悦灵，有哨兵模板时右下角叠加哨兵；两者都有则同时叠加。信息卡显示「包含：悦灵笼 ×N、哨兵盔甲纹饰」，有哪个显示哪个，悦灵笼数量来自精确 jigsaw 放置。
  - 沙漠神殿/丛林神殿/沉船分别叠加沙丘/荒野/海岸模板。
  - 海底神殿有海绵房时，在神殿图标右上角叠加海绵。
  - 模板/悦灵叠加只保留 `allay_loot`、`trim_dune`、`trim_coast`、`trim_sentry`、`trim_wild` 五个源图标；幽静和海绵沿用已有专用图标；底图位置和尺寸不变。
- 主世界、下界、末地的结构勾选项现在同页展示；切换维度只切换地图内容，不切换图标类别。
- 远古城市、林地府邸、堡垒遗迹不再绘制外框。

技术实现：

- 代码位于 `tools/loots` 子模块，主程序通过 `libloots` 链接；结构位置由 `tools/cubiomes` 提供，战利品所需的精确地形、古城布局和末地门房间由 loots 内置 worldgen/stronghold 提供。
- 战利品表、模板、jigsaw 和箱子布局等生成数据头已提交，克隆后无需 Minecraft jar 即可构建。
- 26.3 Java 查询只作为对照 oracle，不进入发行包。
- 要塞末地门房间坐标由 loots 的 `stronghold.h` API 提供，地图不再依赖 geode 的要塞模拟器。要塞图书馆眼眸纹饰在 1.20.1–26.3 使用按版本提取的图书馆战利品表；1.18–26.3 的 portal/eye 框架路径共用。
- `tools/loots/tests/`、`tools/loots/tools/` 是开发数据/测试工具，已由 loots 子模块的 `.gitignore` 排除，不参与主程序打包。

当前精度说明：

- 26.3 的远古城市、林地府邸、末地城、要塞已逐项核对；古城和府邸的布局/箱子坐标在 1.19.2–26.3 已与 26.3 对照。1.19.2 的府邸没有盔甲纹饰模板，不显示模板和箱子。
- 堡垒遗迹、古迹废墟、掠夺者前哨站悦灵笼统一使用 loots 的共享精确 JigsawPlacement，覆盖 **1.20.1–26.3**；前哨站悦灵额外覆盖 **1.19.2**（模板/pool/配置相同，地形 profile -3）。1.20.1+ 这些版本的 jigsaw 数据完全一致，只有地形高度按版本组不同。堡垒遗迹的 piece 展开、箱子 X/Y/Z、lootSeed、宝藏箱子和猪灵旗帜图案与版本无关；测试覆盖 15 个堡垒起点（13 个 treasure 变体）。
- 古迹废墟使用版本化 `WORLD_SURFACE_WG` 高度和 RuleProcessor/CappedProcessor/AppendLoot 链；1.20.1/1.21.10/1.21.11 的真实 jar 对照样本在 1.20.1–26.2 上逐考古方块、表、seed 和纹饰结果一致。前哨站使用同一份数据和版本化高度、`outpost_rot` 存活判定，piece、箱子、seed 和悦灵笼数量与 jar 对照样本一致。
- 下界要塞在正确起始坐标下 cubiomes 的 X/Z piece 图与 26.3 一致；loots 已补上 `moveInsideHeights` 的 Y 修正，并按 Java 的转弯走廊局部坐标重算箱子。`16080,24544` 和 `15360,26640` 的箱子坐标、Y、lootSeed 与 26.3 oracle 一致。1.20+ 共用该 Y/箱子模拟路径；1.16/1.17 不应用 1.18+ 的 Y 整体偏移。已用 1.20.1/1.21.5/1.21.11 源码核对，前哨站与堡垒遗迹的 placement 数据在 1.20.1–26.3 未变化。
- 海底遗迹嗅探兽蛋/可疑沙使用 loots 共享的 1.20.1–26.3 模板、箱子表和处理器数据；暖水可疑沙坐标与 26.3 oracle 一致，1.20+ 使用对应版本地形。地形更新和结构重叠仍可能影响最终世界状态。
- 试炼密室陶罐使用 loots 的独立 layout + post-process RNG 复算；seed 0、结构 `-800,-1008` 的 47 个陶罐坐标/模板/loot seed 与 26.3 服务端完全一致。
- **废弃矿井**：已把 geode 的 1:1 矿井生成器搬进 loots（`src/mineshaft/mineshaft_gen.*`），piece 图/方向/section/真实 `dy` 与 26.3 服务端一致；箱子 RNG 按 `MineshaftCorridor.generate` 回放。seed 0、`-4080,848` 的 6 个箱子中 4 个的 X/Z/Y 和 loot seed 完全一致，仍有 2 缺 2 多，因此 Bounce/EGA 在矿井上继续标“近似”。

模块的构建方式、CLI、目录结构和数据生成说明见 [tools/loots/README.zh-CN.md](tools/loots/README.zh-CN.md)。

## 技术概览

| 层       | 技术                                                            |
| -------- | --------------------------------------------------------------- |
| 桌面壳   | 自研 Win32 + WebView2 宿主（系统 Evergreen 运行时）             |
| 前端     | Vite + TypeScript（手写 DOM，无 React/Vue）                     |
| 原生引擎 | C/C++ DLL（cubiomes 地图与全部搜索器），稳定 C ABI + JSON       |
| 进程模型 | 宿主 + `--engine` 子进程（匿名管道、长度前缀 JSON、单线程串行） |
| 打包     | NSIS portable（LZMA 单文件）                                    |

## 开发与打包

环境要求：Node.js（建议 ≥ 22）、MSYS2 UCRT64 的 GCC / CMake / Ninja、WebView2 Evergreen 运行时（Windows 10/11 一般随 Edge 自带）。

`npm install` 除 Vite 与 TypeScript 外还会安装前端代码检查工具（ESLint 9 + typescript-eslint 8 + Prettier 3）。这些只在前端开发/检查时使用，**不参与** `npm run engine` / `npm run host` / `npm run package` 的原生构建，也不影响最终 exe 的体积。

```powershell
git submodule update --init
npm install

npm run build       # 前端 → dist/
npm run engine      # C/C++ 引擎 → native/build-engine/allinone.dll
npm run host        # 宿主 → native/host/build/aio-host.exe（含图标与版本资源）
npm run package     # 组装 stage + NSIS → release/All-In-One Finder <version>.exe
```

开发与回归：

```powershell
npm run dev         # Vite 5173 + 宿主 --dev（渲染层热更新）
npm run regression  # 约 30 个原生用例（含地形/洞穴图层协议），经 aio-engine --serve 跑同一套引擎
npm run verify      # 发布门禁：体积 / 版本资源 / stage 清单 / 系统 DLL 依赖 / 冒烟
```

代码检查与格式化：

```powershell
npm run typecheck       # tsc --noEmit（strict 模式全量类型检查）
npm run lint            # ESLint（类型感知规则：未使用变量、悬空 Promise 等）
npm run lint:fix        # 同上，并自动修复可修复项
npm run check           # typecheck + lint，提交前建议跑这一条
npm run format          # Prettier 写入 src/、scripts/ 与根目录配置
npm run format:check    # Prettier 只校验不写入（CI 用）
npm run regression:compare  # 对比两份回归产物（基线 vs 本次）是否逐字节一致
```

回归产物默认写入 `test-results/`（已在 `.gitignore` 中忽略），不再落在仓库根目录。`scripts/scratch/` 存放临时排查脚本，同样不参与版本控制，可自由复用。

说明：

- 便携版解压到 `%TEMP%` 运行；会话优先保存到 `%LOCALAPPDATA%\All-In-One Finder\session`。若该位置不可写，会自动回退到 `%APPDATA%\All-In-One Finder`、`Documents\All-In-One Finder` 或 `%TEMP%\All-In-One Finder`；WebView2 配置与试炼/紫水晶检查点也放在同一个可写基目录下。可用环境变量 `AIO_SESSION_BASE` 强制指定基目录。旧版放在 exe 旁的 `session/map.json` 会在首次启动时自动迁移。
- `npm run engine` 需要子模块就位，并且只支持 MSYS2 UCRT64（引擎依赖 GCC 的浮点口径与 AVX2 优化）。
- GPU 粗筛是可选的运行时功能：OpenCL 通过 `OpenCL.dll` 动态加载，编译与打包不需要 NVIDIA 显卡、CUDA 或 OpenCL SDK；没有可用设备时自动回退 CPU。溶洞页的开关首次默认关闭，勾选后会写入会话；引擎的 stderr（含 OpenCL 设备信息）写入会话目录下的 `engine.log`，不再与 JSON 协议通道混用。
- 不要对搜索子模块执行 `--recursive`：它们自带的 `cubiomes/` 必须保持未初始化，引擎只编译共享的 `tools/cubiomes`，否则会出现重复或版本不一致的 cubiomes 头文件。
- 河流内核（DrownedCombinedFinder）沿用了历史路径 `tools/river`，内容已从旧的 RiverFinder JNI 换成本引擎；上游仓库里名为 `river-native`，但本仓库的目录名与 `.gitmodules`、`native/CMakeLists.txt` 均使用 `tools/river`。
- 仓库根目录只保留源码与配置：原生构建产物由 CMake/Ninja 统一放在 `native/build*`（已被忽略），前端产物在 `dist/`，打包产物在 `release/`。
- WebView2 需要 2021 年后的 Evergreen 运行时（`ICoreWebView2_3`）；缺失时启动会弹窗提示安装。

## TODO

1. 无史莱姆区块搜索器
2. 补全矿井 `MineshaftCorridor.generate` 的方块状态/RNG 回放，使 4/6 对拍提升到 6/6
3. 战利品子模块增加 23 种陶片展示

## 许可

本项目以 **GNU 通用公共许可证第 3 版（GPLv3）** 分发，SPDX 标识：`GPL-3.0-only`。  
Copyright (C) 2026 SunnySlopes

完整条款见仓库根目录的 [LICENSE](LICENSE)，或 <https://www.gnu.org/licenses/gpl-3.0.html>。要点：

- 你可以自由运行、研究、修改和再分发本软件，商业使用亦被允许；
- 再分发（包括修改后的版本）时，必须以 GPLv3 提供完整的对应源代码，保留版权与许可声明，并标明修改；
- 本软件不提供任何担保，详见许可证第 15、16 条。

## 致谢

感谢所有人的贡献，没有你们的贡献，就没有这款搜索器

- 界面作者：SunnySlopes，设计参考自SlimeFinderGUI，作者：Bot_City
- 地图展示：https://github.com/xpple/cubiomes ，作者：Cubitect、xpple
- 低Y女巫小屋：https://github.com/M33Galaxy/LowYSwampHutFinderBase ，作者：M33三角座星系、SunnySlopes
- 河流：https://github.com/SunnySlopes/DrownedCombinedFinder ，作者：打野别说话
  （河流内核衍生自 https://github.com/Melationin/RiverFinder ，作者：若莫）
- 低Y溶洞、大坑低Y溶洞：https://github.com/SunnySlopes/LowYDripstoneCaveFinderBase ，作者：SunnySlopes
- 史莱姆区块：https://github.com/CITYWIDESIGN/SlimeRadar 、
  https://github.com/CITYWIDESIGN/SlimeOptimizer ，作者：Bot_City
- 二联海底神殿：https://github.com/SunnySlopes/doubleMonumentFinderBase ，作者：SunnySlopes
- 多联海底神殿：https://github.com/SunnySlopes/DoubleMonumentForFixedSeed ，作者：浅唱清辞、SunnySlopes
- 地狱堡垒十字路口、地狱堡垒大范围：https://github.com/SunnySlopes/FortressFinderBase ，作者：SunnySlopes
- 试炼刷怪笼：https://github.com/SunnySlopes/trial-spawner-native ，作者：打野别说话
- 紫水晶母岩：https://github.com/SunnySlopes/geode-native ，作者：打野别说话
- 全花农场：https://github.com/SunnySlopes/FlowerFinderBase ，作者：SunnySlopes
- 其中低Y溶洞搜索器和繁花搜索器感谢M33三角座星系的指导
