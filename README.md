# 定种多功能搜索器（All-In-One Finder）

面向 Minecraft Java 版（1.18+）的**定种**桌面工具：在同一个窗口里浏览种子地图，并运行多种结构 / 地形搜索。  
界面支持中英文切换；打包形态为 Windows 便携版（portable exe）。

## 能做什么

### 种子地图

- 输入世界种子与游戏版本，浏览**主世界 / 下界 / 末地**群系地图
- 支持大型生物群系、采样 Y、坐标网格、缩放与平移
- 叠加常见结构与地物图标（村庄、神殿、要塞、堡垒、末地城、试炼密室等，可按类型勾选）
- 坐标跳转、从 `/tp` 或 `(x, z)` 文本解析坐标
- 可选绘制刷怪环（24 / 128）辅助规划挂机点
- 会话可导出 / 导入；便携版会把会话写在 exe 旁的 `session/` 目录

### 搜索器

| 搜索器 | 用途 |
| --- | --- |
| **低 Y 女巫小屋** | 在给定范围内搜索低高度的女巫小屋（触发体逐位对齐上游 lysh 内核），支持单种子 / 种子列表 |
| **河流** | 搜索刷怪环（24 < 距离 <= 128）内河流面积最大的点，可计入溶洞面积，版本固定 1.18~26.3+ |
| **低 Y 溶洞** | 在给定范围内寻找低高度滴水石溶洞区域 |
| **大坑低 Y 溶洞** | 面向更大搜索范围 /「大坑」类低 Y 溶洞目标 |
| **史莱姆搜索器** | 搜索刷怪环（24 < 距离 <= 128）内史莱姆生成面积最大的挂机点，可选按 y=-63 群系折算；超大范围自动分块搜索，单边最大 60000001 方块 |
| **二联海底神殿** | 在固定种子中搜索成对海底神殿，标注低效配对；单种子范围上限 262144、种子列表 131072 |
| **多联海底神殿** | 搜索 3/4 连海底神殿，可选单假人 / 双假人 / 单门三种面积口径，按对应面积排序；双假人地图画两圈并标中点、单门画 257×257 框；可选群系检查；默认世界边界 |
| **下界要塞十字路口** | 搜索灵魂沙峡谷中的二联/三联/四联十字路口；搜索范围等效面积上限 262144×262144 |
| **下界要塞大范围** | 搜索要塞整体跨度（长/短边、高度），支持四角边境模式；搜索范围等效面积上限 262144×262144 |
| **试炼刷怪笼** | 按密室统计窗口搜索折算刷怪笼最多的挂机点，支持圆形 / 方形 / 长方形窗口 |
| **全花种** | 搜索花种与面积综合最优的挂机点，含苍白花园 / 沼泽折算 |
| **紫水晶母岩** | 矩形四至搜索预计活跃母岩最多的挂机点；1.18–26.3；自动候选预算、单种子前 20 条精确复核、全图区域断点与 GPU 粗筛 |

支持单种子或种子列表、线程数、搜索范围（默认正方形或世界边界）、进度与暂停/停止；结果统一按各搜索器规则排序并截断前 1000 条后导出。

地图与结构定位底层依赖 [cubiomes](https://github.com/xpple/cubiomes)（`tools/cubiomes`）。

## 技术概览

| 层 | 技术 |
| --- | --- |
| 桌面壳 | 自研 Win32 + WebView2 宿主（系统 Evergreen 运行时，非 Electron） |
| 前端 | Vite + TypeScript（手写 DOM，无 React/Vue） |
| 原生引擎 | C/C++ DLL（cubiomes 地图与全部搜索器），稳定 C ABI + JSON |
| 进程模型 | 宿主 + `--engine` 子进程（匿名管道、长度前缀 JSON、单线程串行） |
| 打包 | NSIS portable（LZMA 单文件） |

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
- 默认不签名：未签名 exe 在别的机器上仍可能触发 SmartScreen。
- WebView2 需要 2021 年后的 Evergreen 运行时（`ICoreWebView2_3`）；缺失时启动会弹窗提示安装。

## 许可

本项目以 **GNU 通用公共许可证第 3 版（GPLv3）** 分发，SPDX 标识：`GPL-3.0-only`。  
Copyright (C) 2026 SunnySlopes

完整条款见仓库根目录的 [LICENSE](LICENSE)，或 <https://www.gnu.org/licenses/gpl-3.0.html>。要点：

- 你可以自由运行、研究、修改和再分发本软件，商业使用亦被允许；
- 再分发（包括修改后的版本）时，必须以 GPLv3 提供完整的对应源代码，保留版权与许可声明，并标明修改；
- 本软件不提供任何担保，详见许可证第 15、16 条。

> 本项目此前的版本以 MIT 许可发布，自本版本起改为 GPLv3；此前按 MIT 条款获得的旧版本副本不受影响。
> `tools/` 下的第三方子模块（如 [cubiomes](https://github.com/xpple/cubiomes)）保留各自的许可证，再分发时需同时满足其条款。

## 致谢
感谢所有人的贡献，没有你们的贡献，就没有这款搜索器
- 界面作者：SunnySlopes，设计参考自SlimeFinderGUI，作者：Bot_City
- 地图展示：https://github.com/xpple/cubiomes，作者：Cubitect、xpple
- 低Y女巫小屋：https://github.com/M33Galaxy/LowYSwampHut，作者：M33三角座星系、SunnySlopes
- 河流：https://github.com/SunnySlopes/RiverFinderGUI、
https://github.com/Melationin/RiverFinder，作者：若莫、SunnySlopes
- 低Y溶洞、大坑低Y溶洞：https://github.com/SunnySlopes/LowYDripstoneCaveFinderGUI，作者：SunnySlopes
- 史莱姆区块：https://github.com/CITYWIDESIGN/SlimeRadar、
https://github.com/CITYWIDESIGN/SlimeOptimizer，作者：Bot_City
- 二联海底神殿：https://github.com/SunnySlopes/DoubleMonumentForFixedSeed，作者：SunnySlopes
- 多联海底神殿：https://github.com/Whisperlyric/MultiMonumentFinder，作者：浅唱清辞、SunnySlopes
- 地狱堡垒十字路口、地狱堡垒大范围：https://github.com/SunnySlopes/FortressFinderGUI，作者：SunnySlopes
- 试炼刷怪笼：https://github.com/qk-yiyihehe/trial-spawner-native，作者：打野别说话
- 紫水晶母岩：https://github.com/qk-yiyihehe/geode-native，作者：打野别说话
- 全花农场：https://github.com/SunnySlopes/FlowerFinderGUI，作者：SunnySlopes
- 其中低Y溶洞搜索器和繁花搜索器感谢M33三角座星系的指导
