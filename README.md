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

### 已启用的搜索器

| 搜索器 | 用途 |
| --- | --- |
| **低 Y 女巫小屋** | 在给定范围内搜索低高度的女巫小屋（触发体逐位对齐上游 lysh 内核），支持单种子 / 种子列表 |
| **河流** | 搜索刷怪环（24 < 距离 <= 128）内河流面积最大的点，可计入溶洞面积，版本固定 1.18~26.3+ |
| **低 Y 溶洞** | 在给定范围内寻找低高度滴水石溶洞区域 |
| **大坑低 Y 溶洞** | 面向更大搜索范围 /「大坑」类低 Y 溶洞目标 |
| **史莱姆搜索器** | 搜索刷怪环（24 < 距离 <= 128）内史莱姆生成面积最大的挂机点，可选按 y=-63 群系折算；超大范围自动分块搜索，单边最大 60000001 方块 |
| **二联海底神殿** | 在固定种子中搜索成对海底神殿，标注低效配对；单种子范围上限 262144、种子列表 131072 |
| **多联海底神殿** | 搜索 3/4 连海底神殿，按共享挂机面积排序，可选群系检查；默认世界边界、最小可用面积 8000 |
| **下界要塞十字路口** | 搜索灵魂沙峡谷中的二联/三联/四联十字路口 |
| **下界要塞大范围** | 搜索要塞整体跨度（长/短边、高度），支持主世界边界与四角边境模式 |

支持单种子或种子列表、线程数、搜索范围（默认正方形或世界边界）、进度与暂停/停止；结果统一按各搜索器规则排序并截断前 1000 条后导出。

### 已接入基底、界面尚未开放的搜索器

下列能力已通过 git 子模块引入算法/工具源码，应用内 Tab 暂未启用，后续会陆续接上：

| 搜索器 | 基底子模块 |
| --- | --- |
| 全花种 | `tools/flower` |

> 试炼刷怪笼（`tools/trialspawner`）与紫水晶母岩（`tools/geode`）的基底子模块已移除，
> 待两个项目重构后再重新引入；`tools/` 下仅保留占位 README。

地图与结构定位底层依赖 [cubiomes](https://github.com/xpple/cubiomes)（`tools/cubiomes`）。

## 技术概览

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron |
| 前端 | Vite + TypeScript（手写 DOM，无 React/Vue） |
| 原生引擎 | C/C++ Node Addon（cubiomes 地图与部分搜索） |
| 打包 | electron-builder（Windows portable） |

## 开发与打包

环境要求大致包括：Node.js（建议 ≥ 22）、CMake、Ninja、MSYS2 UCRT64 的 GCC。

```bash
git submodule update --init --recursive
npm install
# Electron 42+ 不会在 install 时自动下二进制；若缺失可执行：
npm run electron:install

npm run dev       # 开发：Vite + Electron
npm run package   # 编译原生模块 + 前端 + 打便携包
```

产物默认在 `release/All-In-One Finder <version>.exe`。

打包脚本会：

- 给 portable 启动器注入 `--no-sandbox`：部分 Windows 环境（受限沙箱 / 安全软件）会让 Chromium 沙箱在启动阶段崩溃，表现为双击 exe 没有窗口；
- **默认不签名**。未签名 exe 在别的机器上仍可能触发 SmartScreen，但不会修改本机信任库，也不会产生自签名证书。

如需正式签名，直接使用 electron-builder 官方的代码签名环境变量：

```powershell
$env:CSC_LINK = 'C:\path\to\your.pfx'
$env:CSC_KEY_PASSWORD = 'your-password'
npm run package
```

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
- 试炼刷怪笼：https://github.com/ZCXEDTA/TrialSpawnerFinder、
https://github.com/qk-yiyihehe/TrialSpawnerFinder、
https://github.com/SunnySlopes/TrialSpawnerFinder，作者：EDTA、半筝、打野别说话、SunnySlopes
- 紫水晶母岩：https://github.com/SunnySlopes/GeodeFinderGUI、
https://github.com/soulsoiledit/geode-finder，作者：soulsoiledit、SunnySlopes
- 全花农场：https://github.com/SunnySlopes/FlowerFinderGUI，作者：SunnySlopes
- 其中低Y溶洞搜索器和繁花搜索器感谢M33三角座星系的指导
