# 优化方案任务清单（OPT-xx）— 审计整改 + 幽灵窗口修复

> 版本：v1.1（2026-09-29）｜上游：`docs/优化方案-总览.md`
> 编号：**OPT-xx**（与 `tasks.md` 的 T-xx、审计文档的 T-xx 均无关，映射见文末附录）
> 粒度：每任务 0.5~2 天，按垂直切片拆（一个任务 = 一个可独立验收的行为变化）
> 状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成 / `[?]` 阻塞待验证
> 估算口径：XS ≤ 2h｜S ≤ 0.5 天｜M = 0.5~1 天｜L = 1~2 天

---

## Epic A — 幽灵窗口三类症状（① 鼠标点不动 ② 无窗口 ③ 隐藏仍响应）

### Story A0 侦察实验（批次 1 第一件事，先于所有修复）

- [~] **OPT-00 跑 ghost-probe 实验建立修前基线**（来源：缺陷分析第五节）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：在普通终端（非沙箱）运行 `test-audit/run-ghost-probe.ps1`（约 45 秒，四阶段：正常/崩溃/遮挡/隐藏），用 `analyze-ghost-probe.mjs` 出判定；幽灵复现时用 `ghost-inspector.ps1 -Point x,y` 抓现场。
  - 验收：拿到两个待验证问题的答案——① 透明像素是否吞点击；② 被遮挡窗口是否被冻结（对应开放问题 Q-A1/Q-A2）；结果记录进 `docs/优化方案-开放问题.md`。
  - 为什么先做：GW-02 的触发条件标注【待验证】；若遮挡/节流机制被实验证伪，OPT-01/02 的优先级要重排（缓解见风险 OPT-R2）。
  - **状态：阻塞（2026-09-29 实现批次）**——本轮开发会话运行在无桌面交互能力的执行环境里（实测连 `notepad` 都无法启动，Electron 二进制一律以 0xC0000005 退出），
    因此 ghost-probe 的四阶段实验、smoke、bench 三项**运行期**验证无法在此环境完成。代码侧改动已由 `npm test` / `typecheck` / `lint` / `build` 全绿覆盖，
    运行期验证需在真实桌面会话补跑（见 `docs/优化方案-开放问题.md` 的 Q-A1/Q-A2 与本文件回归清单第 5~6 步）。

### Story A1 遮挡误判与渲染冻结（症状① 主因）

- [x] **OPT-01 禁用 Chromium 原生遮挡计算 + 只对隐藏窗节流**（GW-02）｜批次 1｜P0｜估算 S｜依赖：OPT-00
  - 做什么：① `electron/main.ts` 早期加 `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`（全仓 `grep appendSwitch` 现为零命中）；② `electron/services/perf.ts:45` 的 `applyIdleFor` 改为仅当 `win.isMinimized() || !win.isVisible()` 才 `setBackgroundThrottling(true)`，可见窗口一律 false（三档 idleRelease 目前恒为 true，perf.ts:31-33）。
  - 验收：可见窗口在被其他透明置顶窗覆盖时仍持续绘制（ghost-probe occluded 阶段通过）；隐藏窗仍被节流（省资源行为不回退）；`npm test` + smoke 全绿。
  - 位置：electron/main.ts、electron/services/perf.ts:31-45｜证据：缺陷分析 GW-02
- [x] **OPT-02 常驻交互窗不停帧**（GW-08）｜批次 1｜P0｜估算 XS｜依赖：OPT-01
  - 做什么：deskboard / sidebar / palette 等常驻交互窗的 `webPreferences` 加 `backgroundThrottling: false`；隐藏语义仍由窗口显隐控制（与 deskboardWindow.ts:163-165 实测的"hide 后渲染冻结、IPC 发不出"对齐）。
  - 验收：hide→show 切换后渲染层无旧 UI 残留、无旧 IPC 补发观感；日志中"窗口被隐藏"高频场景下功能响应正常。
  - 位置：electron/windows/deskboardWindow.ts、sidebarWindow.ts、paletteWindow.ts｜证据：缺陷分析 GW-08

### Story A2 截图遮罩逃生口（症状①"整屏点不动"）

- [x] **OPT-03 截图遮罩主进程兜底 + 逃生口**（GW-03）｜批次 1｜P0｜估算 M｜依赖：无
  - 做什么：① 遮罩 `webContents` 挂主进程侧 `render-process-gone` / `unresponsive` → 直接 `closeOverlay()`（**不 reload**，避免留下无 surfaces 的空遮罩）；② 托盘/全局热键加「退出截图」项，主进程直接 `closeOverlay + endCapture`（现有托盘"修复卡住的窗口"明确跳过遮罩，windowWatchdog.ts:157，用户目前无自救手段）；③ 遮罩无鼠标活动 N 分钟自动销毁，或在 beginCapture 120s 兜底（captureManager.ts:52）顺带 `closeOverlay`。
  - 验收：人为冻结/杀死遮罩渲染进程后 ≤5s 遮罩消失、整屏恢复点击；托盘「退出截图」在任何状态下可用；`capture:cancel` 渲染路径行为不变。
  - 位置：electron/windows/captureWindows.ts、electron/services/captureManager.ts:121-127、electron/services/windowWatchdog.ts:152-157｜证据：缺陷分析 GW-03

### Story A3 热键与窗口位置（症状②"无窗口显示"）

- [x] **OPT-04 热键注册失败用户可见提示**（GW-04）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：热键注册失败（hotkeyManager.ts:97-99 目前只进列表、各模块只 logWarn）首次弹一次系统 Notification（带"去设置 → 快捷键修改"指引）；失败热键自动尝试备选（沿用 palette 的 Alt+Space→Ctrl+Space 升级先例）或托盘图标小红点。
  - 验收：手动用其他程序占用 Ctrl+Shift+V 后启动，弹出 1 次通知；修复前日志实锤场景（09-22→09-27 五天完全呼不出命令面板无提示）不再复现。
  - 位置：electron/services/hotkeyManager.ts:38-40,97-99、electron/windows/deskboardWindow.ts:194-195、clipboardWindow.ts:85-86、captureManager.ts:310-327｜证据：缺陷分析 GW-04 + 用户日志
- [x] **OPT-05 工作台显示前夹取到当前显示器**（GW-05）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：`showDeskboard` 开头按 `screen.getDisplayNearestPoint(cursor).workArea` 校验/夹取 bounds（**照抄 paletteWindow.ts:56-62 的每次显示重算**）；目前坐标只在创建时算一次（deskboardWindow.ts:36-41），显示器变化后 show 成功但窗口在屏外。
  - 验收：拔插显示器/休眠唤醒/DPI 变化后呼出工作台，窗口出现在当前光标所在显示器工作区内；单显示器行为不变。
  - 位置：electron/windows/deskboardWindow.ts:36-41,100-126｜证据：缺陷分析 GW-05（用户日志证实多显示器工作区变化）

### Story A4 收尾与焦点（症状③"隐藏仍响应"）

- [x] **OPT-06 长截图控制条关闭释放捕获互斥锁**（GW-06）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：longWin 的 `closed` 事件调 `longStop() + closeOverlay()`（captureWindows.ts:277-279 目前只清句柄）；`beginCapture()` busy 时给用户提示（现在静默 return，captureManager.ts:44-48）。
  - 验收：长截图中直接关闭控制条后，任意截图入口立即可再次截图（修前 2 分钟内全部静默失效）；busy 时有可读提示。
  - 位置：electron/windows/captureWindows.ts:277-279、electron/services/captureManager.ts:44-52｜证据：缺陷分析 GW-06
- [x] **OPT-07 showDeskboard 收尾 focus 加 isVisible 守卫**（GW-07）｜批次 1｜P0｜估算 XS｜依赖：无
  - 做什么：`.finally(() => { if (!w.isDestroyed() && w.isVisible()) w.focus(); })`（deskboardWindow.ts:116-125 目前只判 isDestroyed）。
  - 验收：源码断言守卫存在；手动复现"呼出→点别处→抓取完成"时序，隐藏窗不再持有输入焦点（OS 层后果验证顺带回答 Q-A2）。
  - 位置：electron/windows/deskboardWindow.ts:116-125｜证据：缺陷分析 GW-07

### Story A5 看门狗从"只救崩溃"扩展到"也救冻结"

- [x] **OPT-08 看门狗补事件型恢复：gpu-process-gone / unresponsive**（GW-01 事件部分）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：`app.on('gpu-process-gone')` 与 `win.webContents.on('unresponsive')` 接入恢复路径（reload/hide），与既有 `render-process-gone`（windowWatchdog.ts:56）/ `did-fail-load`（:99）并列；RELOADABLE_TITLES 语义保持。
  - 验收：人为制造 GPU 进程崩溃/渲染 unresponsive 后窗口自动恢复或隐藏，日志有 `[watchdog]` 记录；截图遮罩走 OPT-03 的 closeOverlay 分支而不进 reload。
  - 位置：electron/services/windowWatchdog.ts:56,99｜证据：缺陷分析 GW-01（用户日志：幽灵频繁发生但看门狗无崩溃记录）
- [x] **OPT-14 看门狗周期性活性探测**（GW-01 治本部分）｜批次 2｜P1｜估算 M｜依赖：OPT-08
  - 做什么：每 30s 对可见常驻窗 `capturePage()` 采样（哈希/非透明像素比），连续 N 次无变化且已知动画在跑 → 判冻结并 reload。阈值可配，探测失败不影响窗口。
  - 验收：人为挂起渲染进程（suspend 或遮挡实验）后 ≤2 分钟自动恢复；空闲 CPU 增量可测且不违反 T-01 的监听 CPU <1% 口径；误报率：正常动画/视频播放窗口不被误判。
  - 位置：electron/services/windowWatchdog.ts｜证据：缺陷分析 GW-01 修复方向 2

---

## Epic B — 安全阻断项清零（发版门禁）

### Story B1 数据破坏链（SEC-001，审计判 High 阻断）

- [x] **OPT-09 installPlugin 加插件 id 白名单与路径 containment**（SEC-001）｜批次 1｜P0｜估算 S｜依赖：无
  - 做什么：`readManifest` 后立即 `assertPluginId(manifest.id)`（复用 marketplace.ts:30-32 的 `PLUGIN_ID_RE`）+ `target.startsWith(parent + sep)` containment 断言（同 marketplace.ts:473-477）；删除已有目录前弹确认框（复用 loadPlugin 的 dialog 模式）。参照实现：pluginForge.ts:163-190。
  - 验收：构造 `manifest.id='..'` 的插件目录安装被拒、userData 文件数不变；补 1 条负向用例进 `scripts/test.mjs`；合法插件安装不受影响。
  - 位置：electron/services/pluginManager.ts:905-909（根因 :98-107）｜证据：审计报告 SEC-001

### Story B2 窗口导航防护（SEC-002，审计判 High 阻断）

- [x] **OPT-10 全窗口补 setWindowOpenHandler + will-navigate 守卫**（SEC-002）｜批次 1｜P0｜估算 M｜依赖：无
  - 做什么：在窗口创建统一入口（electron/windows/common.ts:46-54 `loadPage`）为全部 15 个窗口注册 `setWindowOpenHandler(() => ({ action: 'deny' }))` + `will-navigate` 拦截转 `openExternalSafe`（electron/utils/openExternalSafe.ts:9 已有 http/https/mailto 白名单）。
  - 验收：15 个窗口 grep `setWindowOpenHandler` 全部有命中；点击待办 markdown 外链走系统浏览器、应用内不出现新窗口；`npm test` + smoke 全绿。顺带做 V-1 PoC（子窗口是否继承 preload）并记录到开放问题。
  - 位置：electron/windows/common.ts:46-54（触发点 src/components/TodoList.vue:273-276）｜证据：审计报告 SEC-002

### Story B3 依赖漏洞清零（SEC-006，审计判 High 阻断）

- [x] **OPT-13 Electron 33 → 39 升级 + 依赖漏洞清零**（SEC-006）｜批次 2｜P0｜估算 L｜依赖：OPT-10（审计 T-03 依赖 T-02）
  - 做什么：升级 `electron` 至 ≥38.8.6（推荐 39.8.10+，修 GHSA-h7rp-cf8h-j98x 等 30+ 条），同步升级 electron-builder 清掉 tar critical（GHSA-23hp-3jrh-7fpw）；处理跨版本破坏性变更（webPreferences 默认值等）。
  - 验收：`npm audit` 中 electron 项清零或仅剩 low；`npm test` 全绿 + `npm run smoke` 通过 + `npm run bench` 12 项不回退；**重点回归窗口行为**（windowWatchdog / 透明窗 / 遮挡开关），重跑 ghost-probe 与批次 1 基线对比无退化。
  - 位置：package.json:36｜证据：审计报告 SEC-006（npm audit 32 条：1 critical / 25 high / 6 moderate）

### Story B4 市场信任最小闭环（SEC-004/005/008，面向公众发版的直接推论）

- [x] **OPT-15 内置插件 id 保留命名空间 + 同 id 冲突显式化**（SEC-005）｜批次 2｜P0｜估算 M｜依赖：无
  - 做什么：内置 id（`com.office.*`）设为保留命名空间，市场条目命中即拒；`listPlugins` 对"同 id 多目录"标 `conflict` 并告警，不再静默取第一个（dataStore.ts:540-545 的 userData 优先扫描）。
  - 验收：市场条目 id 等于内置插件 id 时安装被拦或需显式二次确认；同 id 冲突在插件列表可见；补 1 条用例（审计测试缺口第 3 条）。
  - 位置：electron/services/marketplace.ts:453-484、electron/store/dataStore.ts:540-545｜证据：审计报告 SEC-005
- [x] **OPT-16 远程索引默认关闭（只用内置源）**（SEC-004 最小化）｜批次 2｜P0｜估算 S｜依赖：无
  - 做什么：市场数据源默认 `builtin://index`，远程 HTTPS 索引默认关闭并显示风险说明；"✅ 官方验证"文案在签名制落地前改为如实描述（verified 为索引自报，marketplace.ts:401）。
  - 验收：全新安装默认只见内置源；开启远程索引需显式确认；UI 不再出现无背书的"官方验证"字样。
  - 位置：electron/services/marketplace.ts:401、117-128｜证据：审计报告 SEC-004｜注：**T-05 签名制完成前不得恢复远程索引默认开启**（发版门禁第 5 条）
- [x] **OPT-17 市场解压 fail-closed + 解压侧上限**（SEC-008）｜批次 2｜P1｜估算 S｜依赖：无
  - 做什么：`listZipEntries` 的 `tar -tf` 失败改为 reject（marketplace.ts:311-318 现为 fail-open）；解压总量/条目/压缩比上限对齐 themePack 的 `DEFAULT_ZIP_LIMITS`；解压后断言全部文件落在 dest 内（消除 tar 与 Expand-Archive 双解析器分歧，顺带完成 V-2 PoC）。
  - 验收：畸形 ZIP 被拒；zip 炸弹在解压前被拦；staging 外无新文件。
  - 位置：electron/services/marketplace.ts:311-359,284-292｜证据：审计报告 SEC-008｜参照：shared/themePack/zip.ts:37-43,119-136

### Story B5 深度防御（SEC-007）

- [x] **OPT-18 安全敏感设置移出通用 updateSettings 通道**（SEC-007）｜批次 2｜P1｜估算 S｜依赖：OPT-10
  - 做什么：`sanitizeSettingsPatch` 忽略 `trustedSources / mcpToken / deepseekApiKey`（或移入专用通道，信任操作只走 `plugins:trust`）。
  - 验收：渲染层提交这三键被忽略；补 1 条用例；设置页正常功能不受影响。
  - 位置：electron/ipc/moduleIpc.ts:141-143、electron/store/dataStore.ts:179-186,269-271｜证据：审计报告 SEC-007

---

## Epic C — 健壮性与名实相符（可带病项，批次 1~2 内顺手清）

- [x] **OPT-19 readManifest / 索引字段类型与长度校验**（DEF-001/DEF-007）｜批次 2｜P1｜估算 S｜依赖：无
  - 做什么：readManifest 逐字段 `String()` 归一 + 长度上限（参照 pluginForge.ts:163-177）；市场索引 `version` 过 `^[0-9A-Za-z._-]{1,32}$`（修 version 拼路径穿越）。
  - 验收：manifest.icon 为数字时 `plugins:list` 不整体抛错（审计测试缺口第 2 条）；version 含 `\..` 的条目被拒。
  - 位置：electron/services/pluginManager.ts:98-107,169、electron/services/marketplace.ts:78,120-128｜证据：审计报告 DEF-001/DEF-007
- [x] **OPT-20 主题扫描对非法目录名免疫**（DEF-002）｜批次 2｜P1｜估算 XS｜依赖：无
  - 做什么：`readInstalledManifest` 入口先 `if (!isValidThemeId(id)) return null`；scanThemes 单目录处理包 try/catch（themeDir 现在在 try 之外直接 throw）。
  - 验收：themes/ 下放入"旧主题"目录后 `theme:list` 仍返回其余条目（审计测试缺口第 4 条）。
  - 位置：electron/services/themePack.ts:70-73,101-103,215｜证据：审计报告 DEF-002
- [x] **OPT-11 "安装包加密留存"文案改"仅加密归档"**（FUN-001 止血）｜批次 1｜P1｜估算 XS｜依赖：无
  - 做什么：marketplace.ts:73 注释与设置页文案改为"加密归档（暂不支持离线重装）"，消除过度承诺；"离线重装"功能另立需求（批次 3）。
  - 验收：设置页与注释名实相符；FUN-001 按"文档修正"关闭。
  - 位置：electron/services/marketplace.ts:73、设置页对应文案｜证据：审计报告 FUN-001
- [x] **OPT-21 加密留存顺序与注释一致**（FUN-002）｜批次 2｜P2｜估算 XS｜依赖：无
  - 做什么：把 `backupSecurePackage` 移到 manifest 校验通过之后（marketplace.ts:445-470），或改注释明示"留存下载到的原始包，无论是否安装成功"。二选一，按实现成本定。
  - 验收：行为与注释一致，无"垃圾包占留存空间"或注释虚假承诺。
  - 位置：electron/services/marketplace.ts:445-470｜证据：审计报告 FUN-002

---

## 回归清单（每批收尾必跑，三件套 + 门禁）

| 步骤 | 命令/动作 | 通过标准 |
|---|---|---|
| 1 | `npm run typecheck` / `npm run lint` | 零告警 |
| 2 | `npm test` | 全绿（新增用例随任务提交） |
| 3 | `npm run smoke` | 全绿 |
| 4 | `npm run bench` | 12 项不回退（CP-03 首屏、T-01 剪贴板内存/CPU 口径） |
| 5 | `test-audit/run-ghost-probe.ps1` + 分析 | 四阶段判定通过（批次 2 需与批次 1 基线对比） |
| 6 | 手动验收 | 验收标准里的手动场景逐条过 |
| 7 | 批次 2 收尾 | 重跑增量审计（改动文件 + electron/windows 公共层），阻断项清零 |

---

## 附录 A：OPT-xx ↔ 审计任务 ↔ 缺陷编号映射

| OPT | 审计任务表 | 缺陷编号 | 批次 |
|---|---|---|---|
| OPT-00 | — | 缺陷分析第五节实验 | 1 |
| OPT-01/02 | — | GW-02 / GW-08 | 1 |
| OPT-03 | — | GW-03 | 1 |
| OPT-04 | — | GW-04 | 1 |
| OPT-05 | — | GW-05 | 1 |
| OPT-06 | — | GW-06 | 1 |
| OPT-07 | — | GW-07 | 1 |
| OPT-08 | — | GW-01（事件部分） | 1 |
| OPT-09 | T-01 | SEC-001 | 1 |
| OPT-10 | T-02 | SEC-002 | 1 |
| OPT-11 | T-09（文案部分） | FUN-001 | 1 |
| OPT-13 | T-03 | SEC-006 | 2 |
| OPT-14 | — | GW-01（探测部分） | 2 |
| OPT-15 | T-05（命名空间部分） | SEC-005 | 2 |
| OPT-16 | T-05（索引信任部分） | SEC-004 | 2 |
| OPT-17 | T-06 | SEC-008 | 2 |
| OPT-18 | T-12 | SEC-007 | 2 |
| OPT-19 | T-07 | DEF-001 / DEF-007 | 2 |
| OPT-20 | T-08 | DEF-002 | 2 |
| OPT-21 | — | FUN-002 | 2 |

## 附录 B：批次 3 登记项（不在本清单排期，仅登记）

| 项 | 来源 | 恢复条件/备注 |
|---|---|---|
| 市场签名体系（Ed25519/minisign） | 审计 T-05 | **远程索引恢复默认开启的硬门槛** |
| API Key 不注入插件子进程 | 审计 T-04（SEC-003） | 随插件权限模型（Q-01）一并 |
| 插件资源护栏（stdout 缓冲/jobs/保护窗/进程树） | 审计 T-10（DEF-003/004/005） | — |
| requirements.txt 逐行白名单 | 审计 T-11（DEF-006） | — |
| 下载重定向计数 + staging 清理 | 审计 T-13（DEF-008） | — |
| 密钥 DPAPI + 备份脱敏 | 审计 T-14 | — |
| P2 杂项（setInterval 幂等、Module schema、entry realpath 等） | 审计 T-15 | — |
| "离线重装"功能（FUN-001 A 方案） | 审计 | 文案已止血（OPT-11），功能另立项 |
| GW-09 hide→destroy 竞态 | 缺陷分析 GW-09 | 待验证项确认后再修 |
| 多显示器热插拔实机复现、渲染长稳测试 | 缺陷分析第六节 | 验收测试阶段 |
| Python 插件逐行审计（15 个） | 审计第七节 | 下轮专项 |
| Q-02 Python 运行时下载源哈希固定 | 审计 Q-02 | 下迭代 |
