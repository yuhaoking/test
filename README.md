# 小鹏工具箱

基于 Electron + Vue 3 + TypeScript 的 Windows 桌面工具集合：桌面宠物、右侧毛玻璃侧边栏、8 类内置模块、Python 插件系统。

## 功能

- **桌面宠物**：无边框透明置顶窗口，可拖拽、单击随机播放动作（点头/摆手/眨眼/跳动）、双击呼出/收起侧边栏，上传自定义图片与动作帧
- **侧边栏**：右侧弹出、边缘拖拽调宽（260–600px）、亮/暗主题、置顶区/普通区、编辑模式拖拽排序、右键菜单
- **内置模块**：快捷启动（自动扫描已安装应用、拼音/首字母搜索）、文件管理（最近记录/收藏/全盘搜索/隐私排除）、服务器快捷启动（实时日志）、网站快捷启动、待办事项（宠物提醒）、系统信息（主进程实时推送、每秒刷新）、音乐控制（Windows SMTC）
- **插件系统**：Python 3.10+ 独立子进程，JSON-RPC 2.0 over stdio，模块插件 + 宠物插件，插件管理界面，加载前确认（内置插件免确认）
- **开箱即用（v2.0）**：内置截图/录屏/转换/翻译插件首次启动自动启用并创建侧边栏卡片；插件进程**按需拉起 + 闲置 180 秒自动回收**（信号量限制 5 并发，规格 5.1）；依赖（requirements.txt）后台自动 pip 安装并持久化，无需用户手动操作
- **嵌入式 Python（可选）**：`npm run setup-python` 一次生成 `engines/python`（CPython 3.12 独立构建，**自带 tkinter / tcl-tk / pip / ssl**，下载约 44MB，已被 .gitignore 排除）；打包时随应用分发（electron-builder.yml 已配置），**最终用户无需安装 Python** 即可使用插件；无嵌入版本时自动使用系统 Python 3.10+
- **桌面收纳（v2.0 迭代 1）**：多收纳盒毛玻璃窗口（置顶/贴边/折叠/多显示器），拖入文件仅建立索引（默认不移动），自动分类规则（扩展名/类型/时间），"真移动"模式（二次确认+操作日志），侧边栏卡片双向同步；默认关闭
- **全局命令面板（v2.0 迭代 1）**：Ctrl+Space 一键呼出（可改），分组实时搜索应用/文件/网站/内部功能/插件命令/待办，拼音/首字母匹配，输入防抖（首屏 ≤200ms，Everything 命中时优先），Ctrl+Enter 文件夹中打开、Ctrl+数字快速选择；默认关闭
- **数据存储**：默认 JSON 文件后端（`data-v2.json`），接口语义与规格 SY-01 表结构一致；若本机具备 **Electron ABI** 的 better-sqlite3 二进制（见「常见问题 → 启用 SQLite 后端」），启动探针通过后自动切换到 SQLite（`xiaopeng-v2.db`，统一 `(key, value)` 表结构）；旧版 `data.json` 启动时自动迁移并备份
- **本地存储**：`%APPDATA%\xiaopeng-toolbox\`（`data.json` 旧版 / `data-v2.json` 或 `xiaopeng-v2.db` v2.0）

- **AI 桌宠 2.0（v2.1 / T-05 ~ T-08）**：DeepSeek 对话 + 人设/记忆 + Agent 工具（待办/插件命令/音乐控制/找文件/截图）；语音输入（听写）+ TTS 语音播报；AI 用量管家（余额/任务状态宠物播报）；MCP 工具服务（`scripts/mcp-stdio.js` 桥接外部 MCP 客户端）
- **AI 造插件（T-06）**：插件市场内置向导，一句话需求 → AI 生成插件 → 源码预览 → 一键安装 → 发布到自建市场源（zip + SHA256 + index.json）
- **划词翻译 / 取词 OCR（T-07）**：Ctrl+Alt+T 划词翻译（聚合翻译引擎）、Ctrl+Alt+O 框选取词 OCR，悬浮条支持复制/朗读，取词后自动恢复剪贴板
- **收纳盒深化（T-08）**：胶囊模式（同组胶囊栏，悬停/点击展开）、空格预览（QuickLook 或内置预览）、文件叠放（手动拖叠 + 自动归组，仅索引不动原文件）、下载/解压稳定后自动归类

## 环境要求

| 依赖                     | 版本              |
| ------------------------ | ----------------- |
| Node.js + npm            | 18+（推荐 20/22） |
| Python（运行插件时必需） | 3.10+             |

## 安装与启动

```bash
npm install          # 安装依赖（首次会下载 Electron）
npm run setup-python # 生成嵌入式 Python（engines/python，自带 tkinter/pip，打包分发用；可跳过）
npm run assets       # 生成宠物帧与图标资源（仓库已自带，可跳过）
npm run dev          # 开发模式：Vite HMR + Electron 自动重启
```

开发模式启动后：桌面右下角出现宠物，右键宠物打开设置，双击宠物呼出侧边栏。

## 测试与类型检查

```bash
npm run typecheck    # vue-tsc 全量类型检查
npm run lint         # ESLint 全量静态检查（electron/src/shared/scripts）
npm run format       # Prettier 统一格式化（提交前执行）
npm run build        # 构建主进程/预加载/渲染进程到 out/
npm run start        # 以构建产物运行 Electron
npm test             # scripts/test.mjs：资源/清单/拼音/插件协议 + db 表结构一致性 + 嵌入式运行时看门狗
npm run sbom         # 生成 sbom.json（CycloneDX 精简格式 + copyleft 许可审查，T-13）
npm run setup-python # 生成嵌入式 Python（engines/python，自带 tkinter/tcl-tk/pip，打包分发用）
python scripts/plugin-debug.py   # 独立测试示例插件协议
```

## 打包发布

```bash
npm run dist         # setup-python → build → prepare-dist → electron-builder → dist/ 下的 NSIS 安装包
```

流水线各步作用：

| 步骤 | 作用 |
|------|------|
| `setup-python` | 下载 CPython 3.12 独立构建（自带 tkinter/tcl-tk/pip），精简调试符号（约省 83MB），预装 13 个插件的 requirements |
| `build` | electron-vite 构建主进程/预加载/14 个渲染页面 |
| `prepare-dist` | 结束从本项目 `dist/` 启动的旧实例并清空输出目录（避免 `d3dcompiler_47.dll: Access is denied`） |
| `electron-builder` | 打包 NSIS 安装器（含 `resources/engines/python`，最终用户无需安装 Python） |

安装包为 NSIS 安装器（`dist/`），应用名"小鹏工具箱"，体积约 186MB。

**大陆网络打包提示：** electron-builder 默认从 GitHub 下载工具与 Electron。

Electron 运行时（约 130MB）的下载源**已经写进 `electron-builder.yml`**，默认走 npmmirror，开箱即可打包：

```yaml
electronDownload:
  mirror: https://registry.npmmirror.com/-/binary/electron/
```

为什么必须写在配置里、而不是靠环境变量：electron-builder 有**自己**的缓存目录（`electron-builder/Cache`），
与 `npm install` 用的 `@electron/get` 缓存（`%LOCALAPPDATA%/electron/Cache`）**不共享**，
所以会出现"npm 明明装好了 Electron、打包时却又去 GitHub 下一遍"的现象。
在 GitHub 受限的网络下表现为 21KB/s 爬行后超时：

```
Downloading electron-v39.8.10-win32-x64.zip: 27% ⨯ Timeout awaiting 'request' for 600000ms
（或直接 connect ETIMEDOUT 20.205.243.166:443）
```

注意 `ELECTRON_MIRROR` 环境变量对**打包**这一步无效 —— 它只影响 npm 安装 electron 的 postinstall；
打包走的是配置里的 `electronDownload`（官方源可达时把该段删掉即可）。

打包工具（winCodeSign / nsis / 7zip 等）的镜像仍走环境变量：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
npm run dist
```

若打包报 `Cannot create symbolic link`（winCodeSign 解压），请以管理员身份运行或开启 Windows 开发者模式；无签名需求时可跳过资源签名步骤：`npx electron-builder --win nsis --config.win.signAndEditExecutable=false`。

## 使用说明

| 操作            | 方式                                                               |
| --------------- | ------------------------------------------------------------------ |
| 呼出/收起侧边栏 | 双击宠物、全局快捷键（默认 Ctrl+Alt+X）                            |
| 移动宠物        | 按住拖拽                                                           |
| 宠物互动        | 单击随机动作；右键菜单（聊天 / 设置 / 修复窗口等）                 |
| 呼出工作台      | `Ctrl+Shift+D` 或托盘「显示主窗口（工作台）」；**用完自动收起**（非常驻） |
| 打开设置        | 宠物右键 → 打开设置；或侧边栏 设置按钮                             |
| 命令面板        | `Ctrl+Space`（默认，可改）：搜应用/文件/网站/插件命令/待办/剪贴板/片段 |
| 划词翻译        | 选中文本 → `Ctrl+Alt+T` → 悬浮翻译条（复制译文 / 朗读）            |
| 取词 OCR        | `Ctrl+Alt+O` → 框选屏幕文字 → 悬浮文本条                           |
| AI 对话 / 语音  | 右键宠物 → 与小鹏聊天；聊天窗支持 🎙 听写与 🔊 朗读（设置 → 桌面宠物） |
| AI 造插件       | 设置 → 插件市场 → ✨ AI 造插件：一句话生成插件 → 预览 → 安装 / 发布 |
| 添加模块        | 侧边栏底部 → 添加模块                                              |
| 排序/删除       | 侧边栏底部 → 编辑；卡片右键菜单                                    |
| 插件商店        | 设置 → 插件管理（15 个插件，可加载/卸载/信任/移除）                |
| 安装自定义插件  | 插件管理 → 安装插件…（选择含 manifest.json 的目录）                |
| 保存路径        | 设置 → 通用 → 保存路径（截图/录屏/转换等所有插件输出统一在此设置） |
| 幽灵窗口急救    | 托盘菜单 →「修复卡住的窗口（幽灵窗口）」；频繁出现时开启「禁用硬件加速」 |

## 内置插件清单

| 分类 | 插件 |
| ---- | ---- |
| 截图 | 全屏截图、区域截图、延时截图、窗口截图（均支持保存/复制到剪贴板） |
| 录屏 | 全屏录制(MP4)、区域录制(MP4)、录屏转GIF |
| 转换 | 万能格式转换（参考 FlyingMouse Format：图片互转、多图合并PDF、PDF 提取/拆分/合并、文档转PDF、音视频互转、文本编码互转、图片 OCR，自动检测系统 FFmpeg/LibreOffice/Pandoc/Poppler/Tesseract 引擎） |
| 翻译 | 中英互译、多语言翻译、批量翻译文件、**聚合翻译**（Bing/阿里/有道聚合，支持长文与文件） |
| 工具 | **AI 用量管家（DeepSeek）**：余额监控 + 任务状态，经宠物气泡/语音播报，含「AI 用量播报」命令 |
| 示例 | 示例插件(模块)、示例宠物插件 |

共 **15 个**（13 个内置功能插件 + 2 个示例）。说明：截图类使用系统 GDI 纯 Python 实现（零依赖）；录屏/转换/翻译插件会自动 pip 安装 mss、imageio、Pillow、pypdf、translators 等依赖（需联网，首次加载时自动执行，**已懒加载以免初始化超时**）；录制均不含声音。所有输出文件默认保存在 设置 → 通用 → 保存路径 指定的目录（未设置时使用系统默认图片/视频目录或源文件目录）。

## 项目结构

```
├── electron/                 # 主进程
│   ├── main.ts               # 入口：窗口、快捷键、定时器、性能/看门狗接线
│   ├── preload.ts            # contextBridge 暴露 window.api
│   ├── windows/              # 宠物/侧边栏/设置/工作台/收纳盒/命令面板/剪贴板面板/
│   │                         # 聊天窗/截图遮罩/标注器/贴图/预览窗/划词翻译条
│   ├── services/             # 28 个服务：应用扫描、文件搜索与预览、系统信息、音乐控制、
│   │                         # 插件管理、插件市场、AI 造插件、宠物、语音(TTS/STT)、
│   │                         # 划词翻译、OCR、截图管理、收纳盒、剪贴板、片段库、
│   │                         # 命令面板检索、LLM 对话、Agent 工具、MCP 服务、
│   │                         # 性能治理、窗口看门狗、托盘、备份、天气
│   ├── ipc/                  # 各域 IPC 注册（含 voice/translate/forge/perf/market…）
│   ├── store/                # 数据层：JSON 后端 / 可选 SQLite（db.ts + dataStore.ts）
│   └── utils/                # 日志脱敏、加密(AES-256-GCM)、安全外链、SendKeys 等
├── src/                      # Vue 3 渲染进程（14 个页面：侧边栏/宠物/设置/工作台/收纳盒/
│   │                         # 命令面板/剪贴板/聊天/看板/截图/标注/长截图/贴图/翻译条/预览）
│   ├── components/           # 模块卡片与功能组件
│   ├── views/                # 侧边栏/设置/插件管理/插件市场/AI 造插件等视图
│   ├── stores/               # Pinia：modules / settings / pet
│   └── styles/               # 主题变量与基础样式
├── plugins/                  # 15 个 Python 插件（13 功能 + 2 示例）+ _shared 公共库
├── resources/                # 宠物帧、默认形象、内置插件市场索引与示例包
├── scripts/                  # setup-python / prepare-dist / generate-sbom / test / mcp-stdio …
├── docs/                     # 插件开发、AI 提示词、验收清单、集成方案等文档
└── 测试报告.md               # 缺陷审计与逐轮修复取证（含幽灵窗口根因分析）
```

## 版本与迭代记录

- **v2.0（P0）**：剪贴板历史 + 片段库、插件市场 v1、托盘常驻、热键管理、截图贴图/标注/长截图
- **v2.1（P1）**：AI 桌宠 2.0（对话/记忆/人设/语音/MCP/Agent 工具）、AI 造插件向导、划词翻译与取词 OCR、收纳盒深化（胶囊/QuickLook/叠放/自动整理）、性能模式与资源占用可视化、SBOM
- **v2.1.x（维护迭代）**：两轮全仓缺陷审计修复（详见 `测试报告.md` 第十一~十三节）、**幽灵窗口根治**（渲染进程崩溃自动恢复 + 显示前自检 + 托盘急救 + 禁用硬件加速开关）、工作台改为非常驻且执行后自动收起、打包链路修复（嵌入式 Python 换用自带 tkinter 的独立构建、输出目录占用自动清理）

## 插件开发

见 [docs/plugin-development.md](docs/plugin-development.md)。示例插件位于 `plugins/`，可在设置 → 插件管理 中直接加载体验；一句话生成插件见 设置 → 插件市场 → ✨ AI 造插件。

## 常见问题

- **音乐控制无响应**：需要系统中有正在播放的媒体（QQ 音乐、网易云、Spotify 等支持 SMTC 的播放器），且未在系统设置中关闭媒体控制。
- **温度显示为"—"**：部分硬件/驱动不暴露温度传感器，属正常兜底。
- **插件加载失败**：确认系统已安装 Python 3.10+ 且在 PATH 中（或已执行 `npm run setup-python` 使用随包分发的嵌入式 Python）；在插件管理查看状态提示。
- **区域截图/区域录制插件报"缺少 tkinter"**：嵌入式 Python 需包含 tkinter，执行 `npm run setup-python` 重新生成即可（脚本会检测并替换为自带 tkinter 的 3.12 独立构建；如需换版本可设置环境变量 `XPOS_PY_URL` 指向同结构的 `*-install_only.tar.gz`）。
- **桌面工作台（非常驻 · 呼之即来用完即走）**：默认**不随启动显示**，按 `Ctrl+Shift+D`（或托盘 →「显示主窗口（工作台）」）随时呼出；执行功能后（打开设置 / 切换侧边栏 / 收纳整理 / 启动应用 / 执行搜索结果）或工作台失去焦点时**自动收起**，不会长期挡住后面的窗口。想恢复"常驻启动即显示"：设置 → 桌面工作台 → 打开「启动时自动显示」并关闭「执行后自动收起」。
- **窗口"看不见却挡住鼠标"（幽灵窗口）**：个别显卡驱动下，透明置顶悬浮窗（宠物/侧边栏/工作台/收纳盒）的**渲染进程会崩溃**；Electron 的透明窗口崩溃后窗口依然可见并继续接收鼠标事件，只是不再绘制内容，于是变成一块隐形挡板。当前版本已内置看门狗：
  1. 崩溃后**自动重载**该窗口（日志：`[watchdog] 渲染进程异常退出 …正在恢复窗口：xxx`）；
  2. 同一窗口 5 分钟内崩溃 ≥3 次则**自动隐藏**并弹通知，宁可没有窗口也不留隐形挡板；
  4. **显示前自检**：切换/呼出侧边栏、工作台、宠物前会检查 `webContents.isCrashed()`，已崩溃则先恢复再显示——从工作台切换侧边栏这类操作不会再"呼出一块空白挡板"；
  5. 仍遇到时：托盘菜单 →「修复卡住的窗口（幽灵窗口）」一键重载常驻 UI；
  6. 若频繁发生：设置 → 通用 → 性能与资源 → 勾选**禁用硬件加速**后重启应用（规避驱动相关崩溃）。
- **全盘搜索慢**：仅勾选时会遍历所有磁盘并跳过系统目录与排除文件夹，建议配合排除文件夹使用。
- **打包报 `Access is denied`（如 `dist\win-unpacked\d3dcompiler_47.dll`）**：上一次打包出的程序还在运行，文件被占用。`npm run dist` 现在会先执行 `scripts/prepare-dist.mjs`：**自动结束从本项目 `dist/` 启动的实例**（只影响打包产物，不动 `npm run dev` 实例与其它程序），并带重试清空输出目录；若仍失败，检查杀毒软件/资源管理器预览是否占用该目录后重跑即可。
- **启用 SQLite 后端**：better-sqlite3 不是 N-API 模块，需要与 Electron ABI 匹配的二进制。默认 `npmRebuild: false` 且无预编译二进制时，启动探针会判定不可用并自动回退 JSON 后端（功能完全一致）。要真正启用：
  ```bash
  npm i -D @electron/rebuild
  npx electron-rebuild -f -w better-sqlite3   # 产出 Electron ABI 二进制
  # 并把 electron-builder.yml 的 npmRebuild 改为 true 后重新打包
  ```
  启动日志出现 `[db] 使用 SQLite 后端` 即表示已启用（表结构见 `electron/store/db.ts`）。
