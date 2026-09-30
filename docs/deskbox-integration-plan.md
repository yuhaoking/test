# 小鹏工具箱 — 收纳盒整合 + 模块/插件模块化 优化方案（基于 deskbox 参考文件）

> 本方案基准：`deskbox参考文件.md`（DeskBox 1.4.8）+ 当前代码实测结论。
> 目标：把你提的两点需求落地为可执行、不破坏现有功能、充分利用现有基础设施的改造方案。

---

## 落地状态（2026-09 更新）

| 方案条目 | 状态 | 落地物 |
|----------|------|--------|
| 盒子"内容类型" `kind = files / apps / search`（§1.2–1.4） | ✅ 已落地 | `DesktopBox.kind` + `BoxApp.vue`（`AppsGrid.vue` 应用网格 / `SearchPanel.vue` 复用 `paletteSearch` 的盒内统搜） |
| 插件"合一模块"：一卡容纳全部插件（§2.2） | ✅ 已落地 | `plugin-mod-aggregate` 聚合卡（`PluginModule.vue` 渲染多条插件 UI，随 `plugins:changed` 更新） |
| 模块置顶模型：默认沉底 + 可置顶到第一层（§2.3） | ✅ 已落地 | 聚合卡 `order = Number.MAX_SAFE_INTEGER`、`fixed:false`；`pinned/normal` 分区 + 右键置顶；拖拽落点已修正（向下拖不再失效） |
| T-08 二期深化：胶囊/盒子组、文件叠放、QuickLook 预览、下载稳定后自动归类 | ✅ 已落地 | 见 `tasks.md` T-08 与 `electron/services/desktopBoxes.ts`、`filePreview.ts`、`src/PreviewApp.vue` |
| 盒子内 widget 卡片（§1.5，原计划二期） | ⏳ 未做 | 同等角色已由「桌面工作台」右侧功能卡（音乐/天气/待办/系统信息/最近文件）承担 |

> 说明：本方案的"只建索引、不移动原文件"原则已作为全局约定执行（叠放/胶囊/自动归类均为索引与窗口状态，不改动原文件）。

---

## 〇、先说结论：哪些已经存在，别重复造

| 能力 | 当前状态 | 代码位置 |
|------|---------|---------|
| 桌面收纳盒（可拖拽文件、索引不移动原文件） | ✅ 已实现 | `desktopBoxes.ts` / `boxWindow.ts` / `BoxApp.vue` |
| 三大自动分类盒（软件/文件/图片） | ✅ 已实现 | `SMART_TYPES` / `smartBoxFor` / `applyRules` |
| 智能监听桌面临时文件自动归类 | ✅ 已实现 | `restartSmartWatch` / `classifySmart` |
| 盒子置顶/折叠/隐藏/多显示器/限屏 | ✅ 已实现 | `DesktopBox.onTop/collapsed/visible/displayId` */
| 扫描已安装软件（注册表+开始菜单，带图标缓存） | ✅ 已实现 | `appScanner.ts` `scanInstalledApps()` |
| 全局命令面板（应用/文件/网站/插件/待办搜索） | ✅ 已实现 | `paletteSearch.ts` + `PaletteApp.vue` |
| 侧边栏模块置顶（top 区）/ 固定 / 排序 | ✅ 已实现 | `modules.ts`(pinned/normal) + `SidebarView.vue` |
| 插件系统（Python 子进程，模块/宠物两类） | ✅ 已实现 | `pluginManager.ts` |

**所以：你不需要“做成 DeskBox”，只需要把现有零件**：① 让收纳盒能承载“快捷启动/文件管理/全局搜索”这类**内容类型**；② 把插件从“一插件一卡片”改成“一个插件模块承载全部插件”。

---

## 一、需求 1：把侧边栏启动/文件管理功能整合进收纳盒 + 扫描全部软件进盒

### 1.1 问题本质
当前 `DesktopBox` 只能装 **文件索引**（`DesktopBoxItem = {path,name,isDir}`），盒子里只能显示文件/文件夹。而快捷启动、文件管理是独立的侧边栏卡片，跟盒子是两套东西。

### 1.2 建议改造：给盒子加“内容类型”（box.kind）

在 `DesktopBox` 增加一个 `kind` 字段，决定盒子窗口渲染什么：

```ts
type BoxKind = 'files'      // 现有：文件索引网格（默认，兼容旧数据）
             | 'apps'       // 新增：应用启动网格（快捷启动进盒）
             | 'search';    // 新增：统一搜索面板（参考图中央 "Search files..."）

export interface DesktopBox {
  // ...现有字段
  kind?: BoxKind;            // 缺省 = 'files'
  query?: string;            // search 盒子的搜索词（可选）
}
```

- 旧数据无 `kind` → 默认 `'files'`，零迁移成本。
- `BoxApp.vue` 按 `box.kind` 分支渲染 `FilesGrid` / `AppsGrid` / `SearchPanel` 三个子组件。
- `desktopBoxes.ts` 已实现的能力（索引/分类/监听/置顶/多屏）**全部复用**，只新增“可识别的盒子语义”。

### 1.3 “扫描所有软件 → 生成/填充一个软件盒”

复用现有 `scanInstalledApps()`（含图标缓存、10 分钟 TTL）：

- 在 `DesktopBoxCard.vue`（侧边栏收纳管理卡）或盒子窗口菜单新增 **“添加全部应用到盒子”** 动作。
- 主进程新增 `boxes:add-apps`（或复用 `boxes:update`）：
  1. `scanInstalledApps(true)` 强制扫描；
  2. 取回 `AppItem[]`；
  3. 把一个 kind=apps 的盒子 `targetDir` 设为“快捷方式库”，或直接在盒子 `items` 里写入 `{path: app.path, name, isDir:false, addedAt}`（路径即 exe/lnk，点开即启动 —— 现有 `openPath` 用 `shell.openPath`，对 exe 会直接执行）。

> 建议默认沿用“索引不移动”哲学：应用盒子只记录路径，不复制文件，点开即启动。符合你现有 DR-02 原则。

### 1.4 建议新增“统一搜索盒”（对应参考图中央面板）

现有 `PaletteApp.vue` 已经是“应用/文件/网站/功能/插件/待办”统搜。把它的搜索内核抽出来，做成**盒子的一种内容**：

- `SearchPanel.vue` 复用 `paletteSearch.ts` 的 `search(query)`，在盒子窗口内渲染结果列表（而不是弹窗）。
- 作用：收纳盒不再只是“摆文件”，而是变成一个常驻桌面的**效率入口**（贴近 DeskBox 的中央搜索 + 右侧功能卡片布局）。

### 1.5 可选：让盒子支持“widget 卡片”（更贴近参考图右侧）

参考图右侧是一列功能卡片（音乐/天气/工具/剪贴板）。这是 DeskBox 的特色。**建议二期再做**，避免一期范围失控：
- 新增 `kind: 'widget'` 或让一个“盒子组/胶囊栏”并排多个盒子，每个盒子放一个功能（音乐、天气、待办）。
- 一期先做 `files / apps / search` 三种，已覆盖你的核心诉求。

---

## 二、需求 2：模块&插件抽成一个个模块 + 插件“合一模块” + 置顶模型

### 2.1 模块拆分：目前已经是一模块一卡，确认无丢失
侧边栏已有 `quick_launch / file_manager / server_launcher / website_launcher / todo_list / system_info / music_player` 各自独立卡片（`ModuleCard.vue` 的 `compMap`）。**这些功能本来就是分离的，不会丢失**。你的诉求点主要落在“插件”和“置顶”。

### 2.2 插件“合一模块”（核心改动）

**现状：** `pluginManager.ts` 的 `createPluginModule()` 每加载一个插件就生成一张独立模块卡（`type:'plugin'`），N 个插件 = N 张卡，且每张卡只显示该插件的 UI（`PluginModule.vue` 用 `config.pluginId`）。

**目标：** 只有一个“插件”模块卡，内部容纳全部已启用插件。

**改法（推荐）：**
1. 侧边栏由用户手动添加一张 `type:'plugin'` 的模块卡（像其它模块一样进 `AddModuleModal`，但做成**系统固定**的一张）。
2. 删掉 `createPluginModule()` 的“每插件一卡”逻辑；插件启用后只更新这张聚合卡内部。
3. `PluginModule.vue` 改为**插件列表 + 每条插件内嵌 UI**：
   - 顶部：已启用插件 Tab / 下拉切换（或微信式“每个插件一小节”）。
   - 每条插件渲染其 `PluginUiDescriptor`（text/metrics/inputs/buttons），复用现有渲染逻辑。
   - 直接复用现有 `api.plugins.ui/action/list`，只需把“单个 pluginId”循环成“插件数组”。

### 2.3 置顶模型：插件模块“默认最后 + 可置顶到第一”

**现状：** `modules.ts` 已有 `pinned`(置顶区)/`normal`(普通区)，且 `pinned` 会排到最前。`fixed` 表示“不可拖动/不可删除”。插件的模块目前 `fixed:false, pinned:false`，能通过右键 `setPinned` 置顶 —— 置顶本身已可用。

**你要的“固定放最后但可置顶”需要补一个语义：**
- 给模块增加可选字段 `defaultLast?: boolean`（或复用 `order` 的约定：新插件模块 `order = 非常大的数字`，默认沉底）。
- 规则：**默认排队在末尾（普通区最后），但用户一点“置顶”就进 top 区排到第一**。
- 具体实现（最小改动）：
  1. 插件聚合模块创建时 `fixed:false, pinned:false, order:Number.MAX_SAFE_INTEGER`（沉底）。
  2. 右键菜单已有“置顶/取消置顶”`setPinned`，置顶后自动进 top 区（`pinned` getter 按 order 排序），即“置顶到第一层”。
  3. `SidebarView.vue` 的 `move()` 已限定“同 pinned 状态内移动”，所以插件模块在普通区内最后，置顶后进入置顶区 —— 行为正是你要的。
- 唯一注意：**确保插件聚合模块不是 `fixed`**（否则会被 `:draggable="editing && !m.fixed"` 禁拖 + 右键菜单仍可点置顶？需确认）。建议插件模块 `fixed:false`，保留“置顶”能力。

### 2.4 让“插件聚合模块”成为唯一入口
- `AddModuleModal` 的 `TYPES` 里**不新增**“插件”手动项（避免用户加多张），而是由系统在首次加载插件时自动注入一张聚合卡；或提供“插件管理”开关。
- 插件卸载/移除时，不删卡片，只更新卡片内的插件列表（`PluginModule.vue` 监听 `plugins:onChanged`）。

---

## 三、建议落地顺序（分期，控制风险）

### 阶段 A（本期，低风险，直接可用）
1. **盒子内容类型化**：`DesktopBox.kind` + `BoxApp.vue` 按 kind 分支渲染。
2. **应用盒（apps）**：`boxes:add-apps` 扫描全部软件进盒 + `AppsGrid` 渲染（图标/名称/点击启动）。
3. **搜索盒（search）**：复用 `paletteSearch.search()`，`SearchPanel` 内嵌盒子。
4. **插件合一**：改成一张聚合插件卡，内部罗列全部插件。

### 阶段 B（增强）
5. **侧边栏收纳管理卡升级**：新建盒子时可选 kind；提供“一键扫描所有软件”。
6. **每盒独立搜索 / 图标密度 / 网格布局**（参考图“分类/图标/名称”）。

### 阶段 C（可选，更贴近 DeskBox）
7. **widget 卡片**：盒子组或胶囊栏并排音乐/天气/待办/剪贴板功能盒。
8. **Everything 文件搜索接入**（`paletteSearch` 已有 `everythingSearch`，可下沉到盒子搜索）。
9. **剪贴板历史盒**（DeskBox 的 Clip Capture）。

---

## 四、风险与约束

- **迁移兼容**：`kind` 缺省为 `files`，旧盒子数据不坏；`plugins` 聚合适配需处理旧版已存在的“一插件一卡”（可启动时检测并合并/隐藏，ID 迁移到聚合卡）。
- **性能**：应用盒一次扫描量大（数百应用），复用 TTL 缓存；盒子窗口图标按需加载（现有 `getIcons` 已做）。
- **功能不丢失**：所有现有模块/插件能力在重构中都保留；插件从“多卡”变“一卡多插件”，仅容器形态变化，插件协议（JSON-RPC/ui/action）不动。

---

## 五、需要你拍板的 3 个问题

1. **插件聚合卡的形态**：是“顶部下拉切换每个插件”，还是“一个插件一栏纵向排列”？（推荐后者，直观、改动小）
2. **盒子内的“搜索盒”是否本期就要**，还是先只做 应用盒 + 文件盒？（搜索盒复用命令面板，成本低，建议一并做）
3. **是否接受把“全部软件扫描进盒”作为盒子上的一个一键按钮**，而不是每次手动添加？

> 确认后我可以直接按 阶段A 动手改造，逐步在开发模式下验证。
