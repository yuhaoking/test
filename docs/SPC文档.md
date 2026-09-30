# SPC 文档（软件规格说明书）— 主流化功能补齐 T-14

| 项 | 值 |
|----|----|
| 版本 | v1.0 |
| 日期 | 2026-09-27 |
| 状态 | 待用户 review 确认 |
| 关联 | `docs/项目需求文档.md`（PRD，编号一致）、`小鹏工具箱_v2.0_软件规格说明书.md`（基线规格，SY-01 表结构等约定沿用） |

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-09-27 | 首版：M1~M4 + UPD-01 规格 |

---

## 1. 总体约定（沿用基线规格）

- 存储：SQLite `xiaopeng-v2.db`，统一 `(key, value)` 表结构（基线规格 SY-01/9.6）；JSON 后端 `data-v2.json` 语义一致。
- IPC：主进程 `electron/ipc/*` 注册，preload 白名单暴露；渲染层仅经 `window.api.*` 调用。
- 插件协议：PM-03 `commands` 不变更；本规格所有新能力均为**内置**，不依赖 Python 插件进程。
- 性能基线：命令面板首屏 ≤ 200ms（CP-03）、空闲内存 ≤ 250MB（T-10）不得回退。

## 2. M1 工作台智能化（WK-01 ~ WK-06）

### 2.1 上下文抓取流程

```
呼出工作台(deskboard) → contextCapture 服务：
  1. 记录当前剪贴板内容+序列号（clipboardManager 快照）
  2. 暂停剪贴板监听（既有 pause/resume 钩子，同 translateBar）
  3. 模拟 Ctrl+C → 轮询剪贴板变化（≤ 300ms 超时，20ms 间隔）
  4. 判定类型：
     - 文本：含 \n 或无路径特征 → text
     - 文本是存在的文件路径（可多行） → file（支持资源管理器多选，\r\n 分隔）
     - 文本匹配 ^https?:// → url
     - 剪贴板为图片（序列号变化但无文本）→ image
     - 无变化 → none（回退前台窗口信息）
  5. 恢复原剪贴板 + 恢复监听 → 通知渲染层 render context actions
```

- 失败兜底：任一步异常 → 恢复剪贴板并按 `none` 渲染（WK-05）。
- 设置项 `deskboardContextCapture`（bool，默认 `true`）；关闭后跳过整个流程。

### 2.2 动作模型

```ts
// shared/types.ts 新增
interface ContextAction {
  id: string;               // 'text.translate' | 'file.reveal' | 'custom:<aliasId>' ...
  group: 'text' | 'file' | 'url' | 'image' | 'pinned';
  label: string;
  icon: string;
  hotIndex?: number;        // Ctrl+数字 快捷序号
  usage?: number;           // 来自 palette_usage，排序用
}
```

| group | 内置动作（落地物） |
|-------|--------------------|
| text | 划词翻译（复用 `translateBar` 服务）、搜索（复用 palette web search）、复制、大小写转换（upper/lower/title）、去空格/去换行、朗读（复用 `voice.ts` TTS） |
| file | 在资源管理器中显示（shell.showItemInFolder）、复制路径、预览（复用 `filePreview.ts`）、归档到收纳盒（复用 desktop_box 索引 API；**默认不启用**，用户手动启用/固定后显示；收纳盒关闭时强制隐藏，WK-06） |
| url | 网页快开（默认浏览器）、复制 |
| image | 贴图（复用 pin 窗口）、OCR 取字（复用 `ocr.ts`） |
| pinned | 用户固定动作（持久化 `deskboard_pins`） |

### 2.3 持久化

| 键（表 `settings`/专表） | 内容 |
|------|------|
| `deskboardContextCapture` | bool，默认 true |
| `deskboard_pins` | `string[]`（ContextAction.id 列表） |
| `palette_usage`（既有） | 动作使用频率，WK-03 排序复用 |

### 2.4 IPC

| 通道 | 方向 | 载荷 |
|------|------|------|
| `deskboard:capture-context` | render → main | 无 → `{ type, text?, paths?, imageData? }` |
| `deskboard:run-action` | render → main | `ContextAction.id` + 上下文载荷 |
| `deskboard:pin-action` / `unpin-action` | render → main | action id |

## 3. M2 开发者工具百宝箱（DEV-01 ~ DEV-12）

### 3.1 模块布局

```
shared/devtools/            # 纯函数，零依赖，渲染/主进程共用
  json.ts     jsonFormat(json: string): { ok: true; out: string } | { ok: false; pos: number; message: string }
  time.ts     parseTime(input: string): { epochMs: number; iso: string; local: string; relative: string }
  codec.ts    base64Encode/Decode, urlEncode/Decode（自动识别方向）
  hash.ts     md5/sha1/sha256（Node crypto 主进程；渲染经 IPC）
  uuid.ts     uuidV4()
  radix.ts    radixConvert(input: string, from: 2|8|10|16): Record<2|8|10|16, string>
  unit.ts     convert(value: number, unit: string, family: 'length'|'data'|'time')
  cron.ts     cronNext(expr: string, n = 5): Date[]  + cronDescribe(expr): string
  qrcode.ts   qrEncode(text: string): boolean[][]；qrDecode(image): string（纯 JS 实现，Q7）
  diff.ts     diffLines(a: string, b: string): DiffLine[]
  regex.ts    regexTest(pattern: string, flags: string, input: string): Match[]
```

- 全部函数**无 IO、无全局状态**，每个导出函数在 `npm test` 有断言用例。
- 时间/UUID/哈希在命令面板即时结果走 `paletteSearch` 的即时结果置顶机制（同计算器 T-07）。

### 3.2 命令面板即时结果（DEV-12）

| 输入形态 | 触发 | 结果 |
|----------|------|------|
| `ts 1727...` / 纯 10/13 位数字 | 时间戳识别 | 本地时间+ISO+相对时间 |
| `json {...}` 或粘贴以 `{`/`[` 开头 | JSON 格式化 | 格式化结果（错误时显示位置） |
| `uuid` | 生成 | v4 一次 4 个候选 |
| `md5 文本` / `sha256 文本` | 哈希 | 三值并列 |
| `b64 文本` / `url 文本` | 编解码 | 双向结果 |
| `radix 255` | 进制 | 2/8/10/16 对照 |

- 性能：即时结果计算 ≤ 100ms（DEV-12 验收），沿用输入防抖（SY-06，150ms）。
- 独立小面板（正则/diff/二维码）：`src/views/DevtoolsView.vue` 单页 + Tab 切换，入口=命令面板 `devtools` 指令 + 工作台 pinned。

## 4. M3 划词动作条 + 格式化粘贴（WK-07 / CH-07 ~ CH-10）

### 4.1 划词动作条（扩展 `translateBar.ts`）

```ts
interface SelectionBarAction { id: string; label: string; enabled: boolean; order: number; builtin: boolean; }
// 设置：settings.selectionBarActions: SelectionBarAction[]
// 内置：translate / webSearch / copy / upper / lower / title / trim / speak / ocr(图片)
// 自定义：引用 AL 别名命令或插件 command id
```

- 交互：取词（模拟 Ctrl+C + 剪贴板保护，既有）→ 悬浮条显示启用动作 → 点击/数字键执行 → 复制结果动作完成后自动恢复剪贴板（既有）。
- 设置入口：设置 → 系统集成 → 划词动作条（增删、排序、开关）。

### 4.2 格式化粘贴（扩展 `ClipboardApp.vue` + `clipboardIpc.ts`）

| 动作 | 触发 | 行为 |
|------|------|------|
| 纯文本粘贴 | 粘贴面板条目 `Ctrl+Shift+T` / 右键菜单 | 写回剪贴板纯文本再模拟 Ctrl+V |
| JSON 格式化粘贴 | 剪贴板文本为合法 JSON 时显示 | `jsonFormat` 后写回粘贴 |
| 图片 OCR 粘贴 | 剪贴板为图片时显示 | `ocr.ts` 识别 → 文本写回粘贴 |

- 复用 CH-01 既有"写回剪贴板 → 模拟粘贴 → 恢复"链路，不新增钩子。

## 5. M4 别名与智能匹配（AL-01 ~ AL-03 / CP-07）

### 5.1 别名

```ts
interface Alias { id: string; alias: string; targetId: string; targetType: 'function'|'pluginCommand'|'website'|'snippet'; }
// 表：aliases（key=id, value=JSON）；alias 字段唯一索引（应用层校验冲突，AL-01）
```

- 命中规则：精确匹配优先于一切模糊匹配（AL-03）；同名冲突在保存时拒绝并提示。
- 管理页：`SystemIntegrationView.vue` 新增"指令别名"区块；支持 JSON 导入/导出。

### 5.2 粘贴智能匹配（CP-07）

- `paletteSearch` 新增 `inferClipboardIntent(text)`：返回 `{ kind: 'path'|'url'|'json'|'timestamp'|'color'|'unknown', actions: ContextAction[] }`。
- 面板打开时若剪贴板可识别，顶部渲染"推荐动作"分组（可用 `settings.paletteSmartSuggest: bool` 默认 true 关闭）。
- 与 WK-02 动作模型共用 `ContextAction`，避免两套动作定义。

## 6. UPD-01 检查更新

- 主进程 `electron/services/updateChecker.ts`：启动后延迟 30s 请求 `https://api.github.com/repos/<owner>/<repo>/releases/latest`（仓库地址 `package.json` homepage 推导，可设置覆盖 `updateFeedUrl`）。
- 比较 semver（`package.json` version）；有新版 → 托盘气泡 + 设置页横幅，点击 `shell.openExternal` 跳转 Release 页。
- 频率 ≤ 1 次/天（`lastUpdateCheck` 时间戳）；`updateCheckEnabled` 默认 true；任何失败静默写日志（`electron/utils/log.ts`）。

## 7. 非功能规格与回归防线

| 项 | 规格 |
|----|------|
| 性能 | DEV-12 ≤ 100ms；WK-01 ≤ 300ms；palette 首屏 ≤ 200ms、idle RSS ≤ 250MB 不回退（`npm test` 现有断言保留） |
| 安全 | 上下文内容仅内存态；不写日志明文（诊断包脱敏沿用）；updateChecker 仅 HTTPS |
| 测试 | `scripts/test.mjs` 新增：devtools 纯函数用例 ≥ 30 条、别名冲突用例、clipboard intent 识别用例、db 表结构断言（aliases/deskboard_pins） |
| 兼容 | 零新增第三方运行时依赖；不引入全局钩子；插件协议不变 |

## 8. 验收标准汇总

与 PRD §3 各表「验收标准」列一一对应；M1/M2 为发布门槛，M3/M4 允顺延。整体验收走 `docs/acceptance-checklist.md` 同款清单模式追加 T-14 节。

## 9. 开放问题

同 PRD §7（Q7/Q8 仍开放；**Q6 已决策**：归档动作默认不启用，2026-09-27）；新增决策以用户确认为准并同步修订两份文档。
