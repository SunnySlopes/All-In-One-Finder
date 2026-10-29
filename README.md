# 定种多功能搜索器（All-In-One Finder）

**简体中文** | [English](README.en.md)

面向 Minecraft Java 版1.18+的**定种**桌面工具：在同一个窗口里浏览种子地图，并运行多种结构 / 地形搜索，打包形态为 Windows exe文件。

## 功能

### 种子地图

- 输入世界种子与游戏版本，浏览**主世界 / 下界 / 末地**群系地图
- 支持大型生物群系、采样 Y、坐标网格、缩放与平移
- 叠加常见结构与地物图标（可按类型勾选）
- 坐标跳转、 `/tp` 或 `(x, z)` 文本解析坐标
- 可选绘制刷怪环（24 / 128）辅助规划挂机点
- 会话可导出 / 导入

### 搜索器

| 搜索器         | 用途                                                          |
|-------------|-------------------------------------------------------------|
| **低 Y 女巫小屋** | 在给定范围内搜索低Y女巫小屋，支持单种子 / 种子列表                                 |
| **河流**      | 搜索刷怪环（24 < 距离 <= 128）内河流面积最大的点，可选计入溶洞面积                     |
| **低 Y 溶洞**  | 搜索刷怪环（24 < 距离 <= 128）内低Y存在溶洞的区域                             |
| **大坑低 Y 溶洞** | 在部分种子中以远快于正常搜索的速度寻找「大坑」类低Y溶洞                                |
| **史莱姆搜索器**  | 搜索刷怪环（24 < 距离 <= 128）内史莱姆生成面积最大的挂机点，可选按 y=-63 群系折算          |
| **二联海底神殿**  | 搜索二联海底神殿（要求二联神殿100%面积在刷怪环内）                                 |
| **多联海底神殿**  | 搜索三/四连海底神殿，可选单假人 / 双假人 / 单门三种面积口径，展示对应有效面积                  |
| **下界要塞十字路口** | 搜索**灵魂沙峡谷**中的二联/三联/四联十字路口（要求周围64格半径内无其他群系）                  |
| **下界要塞大范围** | 搜索整体跨度（长/短边、高度）大于要求的要塞，支持边境四角模式                             |
| **试炼刷怪笼**   | 搜索密室统计窗口内折算刷怪笼最多的挂机点，窗口支持圆形 / 方形                            |
| **紫水晶母岩**   | 搜索玩家随机刻范围内母岩、晶洞数最多的挂机点，支持自动调用GPU进行粗筛                        |
| **全花种**     | 搜索主世界全花种农场选址，要求窗口范围内包含繁花森林 / 苍白花园 / 沼泽，可选包含桦木、樱花树林，支持查看地狱群系 |

支持单种子或种子列表、线程数、搜索范围（默认正方形或世界边界）、进度与暂停/停止；结果统一按各搜索器规则排序并截断前 1000 条后导出。

地图与结构定位底层依赖 [cubiomes](https://github.com/xpple/cubiomes)（`tools/cubiomes`）。

## 技术概览

| 层    | 技术                                          |
|------|---------------------------------------------|
| 桌面壳  | 自研 Win32 + WebView2 宿主（系统 Evergreen 运行时）    |
| 前端   | Vite + TypeScript（手写 DOM，无 React/Vue）       |
| 原生引擎 | C/C++ DLL（cubiomes 地图与全部搜索器），稳定 C ABI + JSON |
| 进程模型 | 宿主 + `--engine` 子进程（匿名管道、长度前缀 JSON、单线程串行）   |
| 打包   | NSIS portable（LZMA 单文件）                     |

## 开发与打包

环境要求：Node.js（建议 ≥ 22）、MSYS2 UCRT64 的 GCC / CMake / Ninja、WebView2 Evergreen 运行时（Windows 10/11 一般随 Edge 自带）。

```powershell
git submodule update --init --recursive
npm install

npm run build       # 前端 → dist/
npm run engine      # C 引擎 → native/build-engine/allinone.dll
npm run host        # 宿主 → native/host/build/aio-host.exe（含图标与版本资源）
npm run package     # 组装 stage + NSIS → release/All-In-One Finder <version>.exe
```

开发与回归：

```powershell
npm run dev         # Vite 5173 + 宿主 --dev（渲染层热更新）
npm run regression  # 28 个原生用例，经 aio-engine --serve 跑同一套引擎
npm run verify      # 发布门禁：体积 / 版本资源 / stage 清单 / 系统 DLL 依赖 / 冒烟
```

说明：

- 便携版解压到 `%TEMP%` 运行；会话优先保存到 `%LOCALAPPDATA%\All-In-One Finder\session`。若该位置不可写，会自动回退到 `%APPDATA%\All-In-One Finder`、`Documents\All-In-One Finder` 或 `%TEMP%\All-In-One Finder`；WebView2 配置与试炼/紫水晶检查点也放在同一个可写基目录下。可用环境变量 `AIO_SESSION_BASE` 强制指定基目录。旧版放在 exe 旁的 `session/map.json` 会在首次启动时自动迁移。
- `npm run engine` 需要子模块就位，并且只支持 MSYS2 UCRT64（引擎依赖 GCC 的浮点口径与 AVX2 优化）。
- WebView2 需要 2021 年后的 Evergreen 运行时（`ICoreWebView2_3`）；缺失时启动会弹窗提示安装。

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
- 低Y女巫小屋：https://github.com/M33Galaxy/LowYSwampHut ，作者：M33三角座星系、SunnySlopes
- 河流：https://github.com/SunnySlopes/RiverFinderGUI 、
https://github.com/Melationin/RiverFinder ，作者：若莫、SunnySlopes
- 低Y溶洞、大坑低Y溶洞：https://github.com/SunnySlopes/LowYDripstoneCaveFinderGUI ，作者：SunnySlopes
- 史莱姆区块：https://github.com/CITYWIDESIGN/SlimeRadar 、
https://github.com/CITYWIDESIGN/SlimeOptimizer ，作者：Bot_City
- 二联海底神殿：https://github.com/SunnySlopes/DoubleMonumentForFixedSeed ，作者：SunnySlopes
- 多联海底神殿：https://github.com/Whisperlyric/MultiMonumentFinder ，作者：浅唱清辞、SunnySlopes
- 地狱堡垒十字路口、地狱堡垒大范围：https://github.com/SunnySlopes/FortressFinderGUI ，作者：SunnySlopes
- 试炼刷怪笼：https://github.com/qk-yiyihehe/trial-spawner-native ，作者：打野别说话
- 紫水晶母岩：https://github.com/qk-yiyihehe/geode-native ，作者：打野别说话
- 全花农场：https://github.com/SunnySlopes/FlowerFinderGUI ，作者：SunnySlopes
- 其中低Y溶洞搜索器和繁花搜索器感谢M33三角座星系的指导
