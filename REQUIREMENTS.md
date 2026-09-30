# 小鹏工具箱 - 项目需求文档与技术方案

> **实现状态（2026-09 更新）**：本文档是最初的需求与技术选型草案，其中绝大部分已落地，但**部分选型在实现中被更务实的方案替代**。阅读时请以现状为准：
>
> | 草案条目 | 现状 |
> |----------|------|
> | 数据存储：本地 JSON 文件 | ✅ 默认 JSON 后端；**同时**实现了规格化的"表 + 键 + JSON 值"数据层，本机具备 Electron ABI 的 better-sqlite3 时可自动切换 SQLite（详见 `electron/store/db.ts`） |
> | 文件搜索：Node fs + 可选 Everything | ✅ 已实现（Everything 优先、Node 递归兜底、带时间预算与结果上限） |
> | 插件：Python 3.10+ / JSON-RPC over stdio | ✅ 已实现，并扩展出**插件市场**、`commands` 命令面板集成、`pet_notify`/`pin.capture` 事件、**AI 造插件**向导；随包分发自带 tkinter 的嵌入式 Python |
> | 音乐控制：SMTC | ✅ 已实现（播放/暂停/上下曲/进度/歌词；部分播放器不支持 seek，见 `docs/acceptance-checklist.md` 已知边界） |
> | 系统信息：systeminformation | ✅ 已实现 |
> | UI：原生 CSS 极简毛玻璃 | ✅ 已实现（暗/亮主题 + 强调色） |
>
> 后续迭代（v2.0 P0 → v2.1 → 维护迭代）的任务与验收见 `tasks.md`、`docs/acceptance-checklist.md`，逐轮缺陷修复与取证见 `测试报告.md`。

## 一、技术栈选型

| 层面 | 选型 | 说明 |
|------|------|------|
| 桌面框架 | Electron + Vue 3 + TypeScript | 生态成熟，适合快速开发，能实现透明毛玻璃、无边框窗口、桌面宠物 |
| 构建工具 | Vite + electron-builder | 开发热更新快，打包方便 |
| 状态管理 | Pinia | Vue 3 官方推荐，简单易用 |
| UI 组件库 | 无强制，建议原生 CSS + 少量组件 | 保持极简风格，便于自定义毛玻璃、圆角卡片 |
| 后端/主进程 | Electron Main Process (Node.js) | 负责窗口管理、系统信息、文件搜索、插件管理 |
| 插件语言 | Python 3.10+ | 插件独立运行，通过 JSON-RPC over stdio 与主程序通信 |
| 系统信息 | systeminformation npm 包 | 获取 CPU、内存、磁盘、显卡、温度等 |
| 文件搜索 | Node.js fs + 可选 Everything SDK | 基础递归搜索，全盘搜索可后续接 Everything 提升速度 |
| 应用扫描 | Windows 注册表 + 开始菜单快捷方式 | 使用 winreg 或 PowerShell 命令 |
| 音乐控制 | Windows SMTC (系统媒体控制) | 第一版控制当前系统媒体播放器，后续扩展各平台 |
| 数据存储 | 本地 JSON 文件 | 使用 electron-store 或自定义 JSON 存储 |

**选型理由：**

- Electron 能轻松实现透明窗口、无边框窗口、桌面宠物动画。
- Vue 3 + TypeScript 适合开发复杂的侧边栏 UI。
- Python 插件与主程序通过子进程通信，安全隔离，且 Python 生态适合写各种小工具。
- systeminformation 一个包解决大部分硬件信息获取。

---

## 二、项目骨架（文件夹结构）

```
xiaopeng-toolbox/
├── package.json
├── electron/
│   ├── main.ts                  # Electron 主进程入口
│   ├── preload.ts               # 预加载脚本，暴露 IPC API
│   ├── windows/
│   │   ├── petWindow.ts         # 桌面宠物窗口
│   │   ├── sidebarWindow.ts     # 侧边栏窗口
│   │   └── settingsWindow.ts    # 设置窗口（可选）
│   ├── services/
│   │   ├── appScanner.ts        # 扫描已安装应用
│   │   ├── fileSearch.ts        # 文件搜索
│   │   ├── systemInfo.ts        # 硬件信息获取
│   │   ├── musicControl.ts      # 音乐控制
│   │   ├── pluginManager.ts     # Python 插件管理
│   │   └── petManager.ts        # 宠物动画与交互管理
│   ├── ipc/
│   │   ├── sidebarIpc.ts        # 侧边栏相关 IPC
│   │   ├── petIpc.ts            # 宠物相关 IPC
│   │   ├── moduleIpc.ts         # 模块配置相关 IPC
│   │   └── pluginIpc.ts         # 插件通信 IPC
│   └── store/
│       └── dataStore.ts         # 本地 JSON 数据读写
├── src/                         # Vue 3 渲染进程
│   ├── components/
│   │   ├── Sidebar.vue
│   │   ├── ModuleCard.vue
│   │   ├── QuickLaunch.vue
│   │   ├── FileManager.vue
│   │   ├── ServerLauncher.vue
│   │   ├── WebsiteLauncher.vue
│   │   ├── TodoList.vue
│   │   ├── SystemInfo.vue
│   │   ├── MusicPlayer.vue
│   │   └── PluginModule.vue
│   ├── views/
│   │   ├── SidebarView.vue
│   │   ├── SettingsView.vue
│   │   └── PluginStoreView.vue
│   ├── stores/
│   │   ├── modules.ts
│   │   ├── settings.ts
│   │   └── pet.ts
│   ├── styles/
│   │   ├── main.css
│   │   └── theme.css
│   ├── App.vue
│   └── main.ts
├── plugins/                     # Python 插件存放目录
│   └── example-plugin/
│       ├── manifest.json
│       ├── main.py
│       └── icon.png
├── resources/
│   ├── pet-frames/              # 宠物动作帧图片
│   │   ├── idle/
│   │   ├── nod/
│   │   ├── wave/
│   │   └── blink/
│   ├── icons/                   # 应用图标、模块图标
│   └── default-pet.png
├── docs/
│   └── plugin-development.md    # 插件开发教程
├── build/                       # 打包配置
└── README.md
```

---

## 三、核心功能需求

### 1. 桌面宠物（Pet Window）

#### 窗口要求

- 无边框、透明、始终置顶（可设置取消）。
- 可拖拽移动。
- 支持透明背景，显示 PNG/GIF/APNG 动画。
- 窗口大小根据宠物图片自动调整。

#### 交互

- **单击**：随机播放一个动作（至少 4 种：点头、摆手、眨眼、跳动）。
- **双击**：呼出/收起侧边栏。
- 单击与双击判断时间：200ms 内第二次点击算双击。
- 侧边栏展开时，宠物自动缩小到屏幕角落或隐藏，关闭后恢复。

#### 动作实现

- 用户可在设置中上传宠物图片或动作帧。
- 每个动作对应一组连续图片（帧动画）或 GIF/APNG 文件。
- 若只有一张静态图，单击时随机切换不同表情图片。

#### 宠物插件接口

- 后续支持开发者用 Python 编写宠物插件，按规范打包为 .exe 或 Python 插件。
- 插件可接收主程序指令：`play_action`、`show_notification`、`toggle_sidebar`。
- 插件可向主程序发送事件：`clicked`、`double_clicked`、`dragged`。

---

### 2. 侧边栏（Sidebar）

#### 窗口要求

- 从屏幕右侧弹出，宽度可拖拽调整（默认 360px，可调范围 260px ~ 600px）。
- 无边框、透明毛玻璃背景、圆角卡片、极简风格。
- 支持亮色/暗色主题。
- 多显示器自动适配。

#### 模块布局

- 侧边栏分两个区域：**置顶区**（顶部）和**普通区**（下方）。
- 置顶区模块始终显示在普通区上方。
- 模块可拖拽排序（编辑模式下）。
- 模块可右键菜单：置顶/取消置顶、上移一层/下移一层、删除模块。

#### 编辑模式

- 侧边栏底部有"编辑"按钮。
- 点击后模块显示拖动把手和删除按钮。
- 固定模块在编辑模式下不可拖动，但仍可调整置顶状态。
- 点击"完成"退出编辑模式。

#### 模块添加

- 点击"添加模块"按钮，弹出类型选择窗口。
- 选择类型后进入配置界面，填写名称、图标、对应内容，保存后生成卡片模块。
- 同一类型模块可添加多个。

---

### 3. 内置功能模块

#### 3.1 快捷启动（Quick Launch）

**功能：** 快速打开电脑内的应用软件。

**添加方式：**

- 自动扫描电脑已安装软件，供用户勾选添加。
- 手动选择 .exe 文件或快捷方式。

**支持搜索框：**

- 输入名称模糊搜索。
- 支持拼音/首字母搜索（如输入 wx 找到微信）。
- 应用、文件、网址分开存放：本模块只放应用。

**数据结构：**

```json
{
  "id": "uuid",
  "type": "quick_launch",
  "name": "工作软件",
  "fixed": false,
  "pinned": false,
  "order": 0,
  "config": {
    "items": [
      {
        "id": "uuid",
        "name": "微信",
        "path": "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
        "icon": "path/to/icon.png",
        "searchKeys": ["weixin", "wx", "微信"]
      }
    ]
  }
}
```

---

#### 3.2 文件管理（File Manager）

**功能：** 显示最近常用的文件和文件夹。

**数据来源：**

- 系统最近文档记录（受 Windows 权限影响）。
- 工具箱内打开过的文件记录。
- 用户手动收藏/固定的文件或文件夹。
- 可切换显示不同来源。

**支持搜索框：**

- 默认搜索工具箱记录和收藏内容。
- 搜索框下方有选择框，可勾选"全盘搜索"。

**隐私保护：**

- 可设置排除某些文件夹。
- 提供"一键清除"按钮清除最近记录。

**数据结构：**

```json
{
  "recentFiles": [
    { "path": "D:\\文档\\项目计划.docx", "lastOpened": 1692000000000 }
  ],
  "favoriteFiles": [
    { "path": "D:\\常用\\报销模板.xlsx", "addedAt": 1692000000000 }
  ],
  "excludedFolders": ["C:\\Users\\Admin\\AppData\\Roaming\\Tencent"]
}
```

---

#### 3.3 服务器快捷启动（Server Launcher）

**功能：** 快速启动服务器、脚本、命令。

**支持添加：**

- 本地启动文件：.bat、.py、.exe、npm 命令等。
- 远程服务器连接命令或快捷方式。
- 运行后显示日志窗口，查看输出。
- 可添加多个启动项，每个可单独命名。

**数据结构：**

```json
{
  "id": "uuid",
  "type": "server_launcher",
  "name": "开发服务器",
  "config": {
    "items": [
      {
        "id": "uuid",
        "name": "启动前端",
        "command": "npm run dev",
        "cwd": "D:\\projects\\my-app",
        "type": "command"
      }
    ]
  }
}
```

> `type` 可选值：`command` | `bat` | `python` | `exe` | `remote`

---

#### 3.4 网站快捷启动（Website Launcher）

**功能：** 快速打开常用网站。

**添加方式：** 输入网站名称和网址，可选图标。点击后用系统默认浏览器打开。

**数据结构：**

```json
{
  "id": "uuid",
  "type": "website_launcher",
  "name": "常用网站",
  "config": {
    "items": [
      {
        "id": "uuid",
        "name": "GitHub",
        "url": "https://github.com",
        "icon": "path/to/icon.png"
      }
    ]
  }
}
```

---

#### 3.5 备忘录 / To-Do List

**功能：** 记录待办事项，显示在侧边栏。

- 添加、勾选完成、删除待办事项。
- 可设置提醒时间。
- 到时间后：可选择让桌面宠物提醒，或只在清单中标记。

**数据结构：**

```json
{
  "id": "uuid",
  "type": "todo_list",
  "name": "待办事项",
  "config": {
    "items": [
      {
        "id": "uuid",
        "text": "完成项目需求文档",
        "done": false,
        "reminderAt": 1692000000000,
        "remindType": "pet"
      }
    ]
  }
}
```

> `remindType` 可选值：`pet` | `list`

---

#### 3.6 系统硬件信息（System Info）

**功能：** 显示电脑硬件状态，每 2 秒刷新。

**显示内容：** CPU 占用率、内存占用率、硬盘占用率、显卡占用率、各硬件温度。

> 温度获取可能受硬件限制，部分机器无法显示，需做兜底。

**实现：**

- 主进程使用 systeminformation 获取数据，通过 IPC 推送到渲染进程。
- 前端显示进度条或数值。

---

#### 3.7 音乐启动器（Music Player）

**功能：** 控制音乐播放：暂停/播放、上一首/下一首、进度条拖动。

- 显示专辑图片、歌曲标题、艺术家。
- 点击专辑图片打开当前音乐软件主界面（第一版默认 QQ 音乐）。
- 没有播放歌曲时，显示上一次播放歌曲信息。
- 后续支持自动检测当前音乐平台（QQ 音乐、网易云、Spotify、酷狗）。

**实现：**

- 主进程通过 Windows SMTC 获取当前媒体信息和控制。
- 点击专辑图片时，根据当前播放器进程名（如 QQMusic.exe）打开对应主窗口。

---

## 四、插件系统

### 插件类型

- **模块插件**：在侧边栏显示一个独立卡片模块。
- **宠物插件**：替换或增强桌面宠物。

### 插件语言

Python 3.10+

### 插件结构

```
my-plugin/
├── manifest.json
├── main.py
└── icon.png
```

### manifest.json 示例

```json
{
  "id": "com.example.myplugin",
  "name": "示例插件",
  "version": "1.0.0",
  "author": "作者名",
  "description": "插件描述",
  "type": "module",
  "entry": "main.py",
  "icon": "icon.png",
  "permissions": ["file_access"]
}
```

### 通信协议：JSON-RPC 2.0 over stdio

主程序启动插件子进程，通过标准输入输出通信。

**请求示例：**

```json
{"jsonrpc": "2.0", "id": 1, "method": "plugin.init", "params": {"config": {}}}
```

**响应示例：**

```json
{"jsonrpc": "2.0", "id": 1, "result": {"status": "ok"}, "error": null}
```

**插件主动事件：**

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "click"}}
```

### 模块插件需实现的方法

| 方法 | 说明 |
|------|------|
| `plugin.init` | 初始化，返回插件信息 |
| `plugin.get_ui` | 返回 UI 描述（用于渲染模块卡片） |
| `plugin.handle_action` | 处理用户点击按钮等动作 |

### 宠物插件需实现的方法

| 方法 | 说明 |
|------|------|
| `plugin.init` | 初始化 |
| `pet.play_action` | 播放指定动作 |
| `pet.get_actions` | 返回可用动作列表 |

**主动事件：** `pet.clicked`、`pet.double_clicked`

### 安全

- 加载插件前提示用户确认。
- 设置中可添加"信任的插件来源"。

---

## 五、数据存储

**存储方式：** 本地 JSON 文件，存放于 `%APPDATA%/xiaopeng-toolbox/` 目录。

### 主数据结构

```json
{
  "settings": {
    "theme": "dark",
    "petImage": "path/to/pet.png",
    "petActions": {
      "nod": ["frame1.png", "frame2.png", "frame3.png"],
      "wave": ["wave1.png", "wave2.png"],
      "blink": ["blink1.png"],
      "jump": ["jump1.png", "jump2.png", "jump3.png"]
    },
    "autostart": true,
    "hotkey": "Ctrl+Alt+X",
    "petOnTop": true,
    "sidebarWidth": 360,
    "excludedFolders": [],
    "musicPlatform": "qq"
  },
  "modules": [
    {
      "id": "uuid",
      "type": "quick_launch",
      "name": "工作软件",
      "fixed": false,
      "pinned": false,
      "order": 0,
      "config": {}
    }
  ],
  "recentFiles": [],
  "favoriteFiles": [],
  "plugins": []
}
```

---

## 六、IPC 接口（主进程 <-> 渲染进程）

| 通道 | 方向 | 说明 |
|------|------|------|
| `sidebar:toggle` | Renderer → Main | 切换侧边栏显示/隐藏 |
| `sidebar:set-width` | Renderer → Main | 调整侧边栏宽度 |
| `module:add` | Renderer → Main | 添加模块 |
| `module:update` | Renderer → Main | 更新模块配置 |
| `module:delete` | Renderer → Main | 删除模块 |
| `module:reorder` | Renderer → Main | 模块排序 |
| `app:scan` | Renderer → Main | 扫描已安装应用 |
| `file:search` | Renderer → Main | 搜索文件 |
| `file:open` | Renderer → Main | 打开文件/文件夹 |
| `server:launch` | Renderer → Main | 运行服务器命令 |
| `system-info:get` | Renderer → Main | 获取硬件信息（轮询） |
| `music:control` | Renderer → Main | 音乐控制（播放/暂停/切歌） |
| `plugin:load` | Renderer → Main | 加载插件 |
| `plugin:unload` | Renderer → Main | 卸载插件 |
| `pet:action` | Main → Renderer | 通知宠物播放动作 |
| `pet:clicked` | Renderer → Main | 宠物被单击 |
| `pet:double-clicked` | Renderer → Main | 宠物被双击 |

---

## 七、开发阶段与验收标准

### 阶段 1：基础框架 MVP

- [ ] 侧边栏窗口：右侧弹出、宽度拖拽、编辑模式、置顶区/普通区。
- [ ] 桌面宠物：自定义图片、单击互动、双击呼出/收起、可拖动、置顶。
- [ ] 三个核心模块：快捷启动、文件管理、网站快捷启动。
- [ ] 设置界面：宠物设置、主题、开机自启动、全局快捷键。
- [ ] 本地数据存储。

**验收：** 能正常打开侧边栏，添加模块，打开应用和网站，宠物能单击互动和双击呼出侧边栏。

---

### 阶段 2：功能扩展

- [ ] 增加模块：服务器快捷启动、备忘录、系统硬件信息、音乐启动器。
- [ ] 文件管理：系统最近文档、工具箱记录、手动收藏、全盘搜索、隐私排除。
- [ ] 快捷启动：拼音/首字母搜索、自动扫描软件列表。

**验收：** 所有模块能正常使用，硬件信息 2 秒刷新，音乐能控制播放器。

---

### 阶段 3：插件系统

- [ ] 开放 Python 插件接口。
- [ ] 提供插件开发模板和教程。
- [ ] 支持自定义插件模块。
- [ ] 支持宠物插件。
- [ ] 插件管理界面：安装、卸载、启用、禁用。

**验收：** 能加载一个示例插件，插件能显示在侧边栏并响应点击，宠物插件能替换宠物并联动。

---

### 阶段 4：优化与发布

- [ ] 性能优化：内存占用、毛玻璃效果优化。
- [ ] 兼容性测试：Windows 10/11、多显示器。
- [ ] 界面细节打磨。
- [ ] 编写使用文档。
- [ ] 打包发布 .exe。
