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
| **低 Y 溶洞** | 在给定范围内寻找低高度滴水石溶洞区域 |
| **大坑低 Y 溶洞** | 面向更大搜索范围 /「大坑」类低 Y 溶洞目标 |

支持单种子或种子列表、线程数、搜索范围（默认正方形或世界边界）、进度与暂停/停止，以及结果排序与导出。

### 已接入基底、界面尚未开放的搜索器

下列能力已通过 git 子模块引入算法/工具源码，应用内 Tab 暂未启用，后续会陆续接上：

| 搜索器 | 基底子模块 |
| --- | --- |
| 低 Y 女巫小屋 | `tools/lowyswamphut` |
| 河流 | `tools/river` |
| 史莱姆区块聚集 + 挂机点优化 | `tools/slimeradar` + `tools/slimeoptimizer` |
| 二联 / 多联海底神殿 | `tools/doublemonument` / `tools/multimonument` |
| 地狱堡垒（十字路口 / 大范围） | `tools/fortress` |
| 试炼刷怪笼 | `tools/trialspawner` |
| 紫水晶母岩 | `tools/geode` |
| 全花种 | `tools/flower` |

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

## 许可与致谢

本仓库以项目根目录 `LICENSE` 为准。各搜索器子模块来自社区开源项目，具体许可与作者见对应 `tools/*` 仓库；应用内「关于」页会随接入进度补充 Credits。
