# 小鹏工具箱 — 产品优化任务清单（tasks.md）

> 来源：市场调研与竞品对标报告（2026-09）。
> 原则：**只拓展、不删功能**；任务沿用《小鹏工具箱 v2.0 软件规格说明书》的 DR/CP/CH/PM/SY 编号体系。
> 优先级：P0 = 补齐承诺 + 高频刚需（第 1 季度）；P1 = 差异化护城河（第 2–3 季度）；P2 = 长期竞争力（第 4 季度及以后）。
> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成

---

## 现状速览（基线）

- ✅ 已具备：桌面宠物、毛玻璃侧边栏（8 类模块）、桌面收纳盒（files/apps/search 三种盒、自动分类、不移动文件原则）、全局命令面板（Everything 优先）、桌面看板 + 天气、15 个 Python 插件（截图/录屏/转换/翻译/DeepSeek 监控）、嵌入式 Python 分发、SQLite 数据层。
- ✅ P0 已落地（2026-09 迭代）：剪贴板历史 + 片段库（CH 系列）、插件市场 v1（PM 系列）、托盘常驻（SY-03）、全局快捷键管理页（SY-02）、截图贴图/标注/长截图（T-04）。
- ✅ P1 已落地（2026-09 迭代 2）：T-05 语音输入/TTS + MCP 工具服务 + AI 用量管家、T-06 AI 造插件向导（生成→预览→安装→发布）、T-07 划词翻译/取词 OCR、T-08 胶囊模式/QuickLook/文件叠放/自动整理增强。
- ✅ P2 已部分落地（2026-09 迭代 3）：T-10 性能模式 + 资源占用可视化 + 多窗口闲置释放、T-11 插件安装包加密留存、T-13 SBOM 清单（`npm run sbom`）。剩余：T-12 生态与国际化、T-13 分发/商业化。
- ✅ 维护迭代（2026-09 迭代 4~9，详见 `测试报告.md` 第十一~十三节）：
  - **两轮全仓缺陷审计修复**：2 个 P0（SQLite 表结构、AI 造插件路径穿越）+ 15 个 P1 中的 13 项（任意文件读取、命令注入、MCP 无鉴权、市场路径穿越、插件槽位死锁、聚合翻译初始化超时、录屏损坏/时长失真、监听器泄漏、草稿覆盖配置、待办 XSS、拖拽后单击失效…）+ 20 余项 P2/P3。
  - **幽灵窗口根治**：真因＝透明置顶窗的**渲染进程崩溃后窗口仍可见、仍吃点击却不再绘制**；现已具备崩溃自动恢复、反复崩溃自动隐藏、显示前 `isCrashed` 自检、托盘「修复卡住的窗口」、可选的「禁用硬件加速」。
  - **工作台改为非常驻**：默认不随启动显示，执行功能或失去焦点即自动收起（`deskboardShowOnStartup` / `deskboardHideAfterAction`）。
  - **打包链路修复**：嵌入式 Python 换用自带 tkinter/tcl-tk/pip 的 CPython 独立构建（零注册、可重入，精简 83MB）；`dist` 前置 `prepare-dist` 自动结束旧实例并清理被占用的输出目录。
  - **数据安全**：JSON 数据文件带 BOM 不再导致整库静默丢弃（解析前剥离 BOM，损坏时先备份 `*.corrupt-<ts>.bak`）。
- ✅ 主流化补齐（2026-09-27 落地）：**T-14** 全部完成——M1 工作台上下文智能化（模拟 Ctrl+C 取词 + 动作面板 + 固定/频率排序）、M2 开发者工具百宝箱（13 个零依赖纯函数模块 + 命令面板即时结果 + 独立小面板）、M3 可配置划词动作条 + 格式化粘贴三件套、M4 指令别名与粘贴智能匹配、UPD-01 检查更新（详见下方 T-14 各条落地说明）。
- 🎯 独有定位：「桌宠（情感入口）+ 桌面收纳 + 命令面板 + Python 插件平台 + AI 造插件」组合体，市场上无第二家。

---

## P0 — 补承诺、堵口碑（第 1 季度）

### T-01 剪贴板历史 + 片段库（CH-01 ~ CH-06）

- [x] 剪贴板监听：托盘常驻，记录文本/图片（含时间戳、来源应用），落 SQLite `clipboard` 表
  - 落地：`electron/services/clipboardManager.ts`（600ms 轮询 + 内容指纹去重；图片落盘 `clipboard-images/`，条目本体仅元数据）
- [x] 历史管理：置顶条目、文本全文搜索、按时间/类型筛选、一键清空（设置 → 剪贴板）
- [x] 隐私保护：排除关键词、应用白名单、可选加密存储（spec 5.4；AES-256-GCM，`electron/utils/secrets.ts`）
- [x] 浮动粘贴面板：全局热键（默认 Ctrl+Shift+V）上下选择粘贴（`src/ClipboardApp.vue`，Enter 粘贴 / Ctrl+Enter 复制）
- [~] 片段库：预设常用文本 + 缩写（`fragments` 表 + 管理 UI + 粘贴面板 Tab 展开 + 命令面板可插入）
  - ⚠️ 限制：“任意输入框输入缩写按 Tab 全局展开”需全局键盘钩子，v1 在粘贴面板/命令面板内实现展开粘贴，全局钩子列入后续迭代
- [x] 增强工具：屏幕取色器（复制 HEX/RGB，`src/CaptureApp.vue` color 模式）、剪贴板图片 OCR（复用 Tesseract，`electron/services/ocr.ts`）并索引进历史
- [x] 验收：记录 500 条文本 + 100 张图片内存增量 ≤ 100MB；监听 CPU < 1%；搜索即输即显
  - **实测（`npm run bench`，`scripts/bench-main.ts`）**：600 条条目（500 文本 + 100 图片）载入内存增量 **堆 0.8MB / 进程 RSS ≈1MB**（门槛 ≤100MB）；剪贴板监听空闲 CPU **0.96%**（门槛 <1%）；搜索即输即显（结果缓存命中 0.0ms）
  - 设计要点：条目本体只存元数据、图片落盘、指纹采样去重、本地过滤不查库
- 📌 对标：CopyQ(12.3k⭐) / Ditto(7.2k⭐) / TieZ(2.9k⭐)；差异化点 = 隐私模式 + 片段展开 + 与面板/宠物联动

### T-02 插件市场 v1（PM-01 ~ PM-04）

- [x] 市场页面：插件列表（分类/名称/版本/作者/描述/下载量），数据源可配置（设置 → 插件市场 → 数据源；HTTPS 索引 / 内置源 `builtin://index`）
- [x] 一键安装 / 更新 / 卸载；安装时自动解析 requirements.txt（复用现有自动 pip 机制）
  - 落地：`electron/services/marketplace.ts` + `src/views/MarketView.vue`
- [x] manifest 协议扩展：新增 `commands` 字段（命令插件），命令直接注册进全局命令面板；**兼容现有插件**
  - 落地：`shared/types.ts` PluginCommand、`pluginManager.runPluginCommand`（`plugin.handle_command`）、`paletteSearch` 插件命令源
- [x] 安全：仅 HTTPS 源 + SHA256 校验（可选签名）、权限提示（文件/网络）、"社区未验证"标签
  - 另加：包内 `manifest.id` 与市场条目一致性校验（防篡改/混淆）
- [x] 验收：从市场安装示例插件成功，其命令出现在命令面板并可执行
  - 示例源：`resources/market/index.json` + `resources/market/packages/com.example.command-tool/`（问好/当前时间/写入记事本）
- [x] 插件图标设计系统：`scripts/generate-plugin-icons.mjs`（`npm run icons`）为 **15** 个内置插件（13 个 `office-*` + 2 个示例插件）生成统一「圆角渐变色块 + 白色线性字形」图标，按族取色（截图青/录屏红/翻译蓝紫/转换橙/监控紫/宠物粉/命令绿），128px SDF 抗锯齿
- 📌 对标：Flow Launcher 插件生态（15.6k⭐）/ ZTools(3.8k⭐)；生态是本产品护城河

### T-03 系统整合收尾（SY-02 ~ SY-04）

- [x] 托盘常驻：主窗口关闭最小化到托盘；托盘菜单（显示主窗口 / 启用禁用收纳盒 / 剪贴板记录 / 开机自启 / 退出）
  - 落地：`electron/services/trayManager.ts` + `deskboardWindow` close 拦截 + `electron/utils/quitState.ts`
- [x] 全局快捷键管理页：统一管理所有热键（侧边栏 Ctrl+Alt+X、面板 **Ctrl+Space**（原 Alt+Space 因与系统菜单/PowerToys 冲突已改）、工作台 Ctrl+Shift+D、剪贴板面板 Ctrl+Shift+V、截图 Ctrl+Alt+A、贴图 F3、划词翻译 Ctrl+Alt+T、取词 OCR Ctrl+Alt+O），修改立即生效
  - 落地：`electron/services/hotkeyManager.ts` + `src/views/SystemIntegrationView.vue`（含 `hotkeys:set` 的 action/accelerator 白名单校验）
- [x] 开机自启（已有 `setLoginItemSettings`）并入"系统集成中心"，与托盘状态同步
- [x] 验收：所有热键冲突可检测（应用内重复分配 + 注册失败原因回报）、可重置（单项/全部恢复默认）；重启后设置保留（SQLite）

### T-04 截图线增强（贴图 / 标注 / 长截图）

- [x] **贴图（Pin）**：截图后钉到桌面置顶（可缩放/透明/关闭），对标 Snipaste 招牌功能
  - 落地：`electron/windows/captureWindows.ts` pin 窗口 + `src/PinApp.vue`；全局贴图热键 F3 把剪贴板图片钉到桌面
- [x] 截图后即时标注：箭头 / 文字 / 矩形 / 马赛克（另加画笔、撤销；`src/AnnotateApp.vue`）
- [x] 滚动长截图（窗口滚动捕获）：手动/自动（PgDn 滚动 + 分段捕获 + 重叠区像素比对拼接，`src/LongApp.vue` + AnnotateApp 拼接内核）
- [x] 落地方式：增强现有 4 个截图插件 + `_shared/screen_capture.py`，不新造插件
  - 新增 `request_pin()` / `save_temp_png()` 辅助；4 个截图插件均增加“截图并贴图”按钮（`pin.capture` 事件联动主进程贴图窗口）
  - 另：核心截图线走 Electron desktopCapturer（区域截图 Ctrl+Alt+A），与 Python 插件互补
- [x] 验收：截图 → 标注 → 贴图/复制全流程 ≤ 3 步操作（热键 → 拖选 → 一键贴图/复制）
- 📌 对标：Snipaste / PixPin / ShareX(39.7k⭐)；打"免费 + 无广告 + 融入工具箱"差异化

---

## P1 — 差异化护城河（第 2–3 季度）

### T-05 AI 桌宠 2.0（战略主线 ⭐）

- [x] LLM 对话 + 人设系统：chat 对话窗口（右键宠物 / 命令面板唤起）、DeepSeek 驱动（`electron/services/llm.ts`）、记忆持久化（`pet_memory` 表，最近 24 条回灌）；名字/性格/口癖/世界观可配（设置 → 桌面宠物）并注入提示词（世界观/自我介绍 = `petWorldview`，聊到相关话题自然体现）
- [x] 语音输入 + 语音播报（TTS）：聊天窗口 🎙 听写输入（Windows SAPI 听写，8 秒转文字）+ 🔊 朗读；桌面宠物气泡消息 TTS 播报（设置 → 桌面宠物：开关 + 语速 + 试听/听写测试）
  - 落地：`electron/services/voice.ts`（System.Speech 零第三方依赖），`petVoiceEnabled` 开启后 `notifyPet` 全通道播报（聊天/提醒/用量管家）
- [x] **宠物即 Agent 入口**（MCP 兼容工具调用）：工具闭环（`add_todo` / `run_plugin_command` / `control_music` / `find_file` / `screenshot`，`electron/services/agentTools.ts` 对话与 MCP 共用）；MCP 对外协议已接入（本机回环 HTTP 实现 Streamable HTTP JSON-RPC 子集 `initialize/tools.list/tools.call` + `scripts/mcp-stdio.js` stdio 桥，设置 → 桌面宠物 开关）
- [x] 事件化提醒升级：完成后庆祝动画（`pet.play` jump + 🎉）；待办到期宠物走动提醒（`main.ts checkReminders` → `playAction('nod')` + `notifyPet('待办提醒：…')` 气泡，宠物不可见时退化为系统通知）
  - 另（T-15 / P3-6）：提醒检查改为"只在真有提醒触发时写库"，不再每 10 秒全量落盘 + 全窗口广播
- [x] DeepSeek 监控插件升级为"AI 用量管家"，余额/任务状态由宠物语音播报（`pet_notify` 插件事件 → 宠物气泡 + TTS）：任务完成播报、低余额预警（<10 元，1 小时节流）、命令面板/宠物对话可触发"AI 用量播报"（`com.office.deepseek.monitor` v2.0）
- [x] 验收：宠物对话能实际完成一次"帮我翻译这段话"跨插件调用闭环
  - 路径：对话 → `run_plugin_command` 工具 → 中英互译插件 `plugin.handle_command` → 译文回呈对话（翻译插件已补 PM-03 commands 声明）
- 📌 对标：VPet(6.8k⭐，有生态无 AI) / git2968/Desktop-pet(16⭐，有 AI 无生态) / vibebud·BetterFly(新兴)；**机会窗口明确**

### T-06 "人人可造插件"产品化（独有资产）

- [x] 产品内向导：一句话需求 → AI 生成插件/宠物（提示词工程固化自 `docs/ai-plugin-prompt.md`，含命令/事件扩展）→ 预览（manifest + 全部源码逐文件审阅）→ 一键安装
  - 落地：`electron/services/pluginForge.ts` + `src/views/PluginForgeView.vue`（设置 → 插件市场 → AI 造插件）
- [x] 生成物可一键发布到插件市场（接 T-02）：选目录生成 zip + SHA256 + 更新 index.json（相对路径条目 + 发布说明），上传任意 HTTPS 静态托管即被其他用户安装；本地源（file://）支持自建市场联调
- [x] UGC 宠物/皮肤主题包：制作、导入、分享（对标 VPet 创意工坊）—— **2026-09-27 落地**
  - 格式 `.xptheme`（本质是 ZIP：`theme.json` + 图片），承载**宠物形象 + 动作帧 + 气泡样式 + 可选界面皮肤**；主题包**不含任何可执行内容**（只允许图片与文本），这是与插件的根本边界——插件才是代码载体
  - **制作**：把"已经调满意"的当前形象与动作帧一键打包（不必先按包结构整理文件），另提供「下载制作模板」（清单样例 + 默认形象 + 制作说明）
  - **导入**：**先审后解** —— 先读 ZIP 中央目录拿到"声明的解压后大小"，校验路径穿越 / 条目数 / 单文件大小 / 压缩比 / 文件类型，全部通过**才开始解压**；解压到暂存目录，全程成功才原子替换；同 id 二次确认覆盖
  - **分享**：导出 `.xptheme` + SHA256 + 可直接发社区（小红书/B站）的投稿文案；创作者指南见 `docs/theme-pack.md`
  - 落地：`shared/themePack/{zip,inflate,manifest}.ts`（纯函数、零依赖：自研 ZIP 读写与 RFC 1951 解压，**不引第三方包、不依赖 PowerShell/tar**）+ `electron/services/themePack.ts` + `electron/ipc/themeIpc.ts` + 设置 → 桌面宠物「主题包」卡片网格
  - 安全面：路径穿越（含反斜杠变体 / NTFS 交换数据流 / Windows 设备名 / 尾随点）、加密条目、ZIP 炸弹（压缩比 + 总量 + 条目数三重）、可执行文件一律拒绝；**IPC 不接受渲染层传路径**（导入用主进程自己的选择器与记忆路径），制作只打包"当前设置里的形象与帧"
  - 应用语义：换主题只改宠物相关设置；包内界面皮肤**默认不套用**，需用户显式勾选——换一只宠物不该顺手改掉用户调好的配色
- [x] 验收：零代码用户从"我想要一个 XX 插件"到可用插件 ≤ 5 分钟（向导流程 ≤ 3 步：描述 → 审阅 → 安装；生成耗时约 20~60 秒，依赖 DeepSeek API Key）

### T-07 命令面板升级为"万能入口"

- [x] 划词翻译 / 取词 OCR：pot 模式热键取词弹悬浮条（默认 Ctrl+Alt+T 划词翻译 / Ctrl+Alt+O 取词 OCR，热键管理页统一可改），复用聚合翻译引擎（`office-translate-pro`，兜底中英互译），悬浮条 复制/朗读/关闭，取词后自动恢复原剪贴板
  - 落地：`electron/services/translateBar.ts` + `src/TranslateBarApp.vue`；取词走模拟 Ctrl+C（无全局键盘钩子），OCR 复用 Tesseract（`electron/services/ocr.ts`）
- [x] 面板内计算器、待办快记（`todo xxx` 直接落库）、剪贴板历史搜索（接 T-01 ✅）
  - 计算器：算式即时求值（递归下降，不用 eval），回车复制结果；快记：`todo 文本` / `待办 文本` 一键写入待办模块
- [x] 结果排序接入 `palette_usage` 使用频率 + 拼音/首字母匹配（pinyin-pro 已有，CP-04/CP-06）
- [x] 搜索内核增强：无 Everything 时的快速兜底 —— **评估完成并落地**
  - **MFT 直读：评估后不采用**。Everything 那套"直读 NTFS $MFT"需要**管理员权限 + 原始卷访问**，与"双击 exe 即用、不要求提权"的产品定位直接冲突，且自研 MFT 解析（记录修复、USN 增量、多卷/压缩/加密差异）的维护成本与风险远高于收益
  - **改用 Windows 自带搜索索引（SYSTEMINDEX）**：通过 ADO `Search.CollatorDSO` 查询系统已维护的全量索引 —— 零安装、零提权、零常驻内存；本机实测**命中 40~46ms**（内置遍历的时间预算是 180ms），且能覆盖遍历因深度/时间预算到不了的深层用户目录
  - 落地：`electron/services/windowsSearch.ts`（可用性探测 + 结果缓存 + SQL LIKE 转义 + 1.5s 超时 + 失败降级为调试日志）
  - 三级来源：**Everything → 内置遍历 → Windows 索引**；全盘搜索并发跑遍历与索引并去重合并；命令面板**异步补全**（先用遍历出首屏，索引结果到了再经 `palette:results` 推送替换）
  - **性能回归与修复（bench 抓出）**：把索引同步串进面板检索链会让首屏 181ms → 600ms/1150ms；根因是 PowerShell 冷启动 250~400ms + 脚本里 `[double]` 强转 DBNull（目录无 System.Size）导致整段失败、每次白等 550ms。改为异步补全 + `GetVal` 防 DBNull + 查询 ≥3 字符 + 连续失败 3 次停用后，首屏回到 191.8/196.3ms
  - 设置项 `searchUseWindowsIndex`（默认开，不可用自动回退）+ 设置 → 命令面板 展示当前可用后端与不采用 MFT 的原因
- [x] 验收：首屏结果 ≤ 200ms（CP-03 标准）；高频结果显著前移
  - **实测（`npm run bench`）**：10 组不同查询的冷启动首屏 **P50 180.8ms / P95 181.8ms**（门槛 ≤200ms）；同查询缓存命中 **0.0ms**；高频结果前移由 `palette_usage` 权重排序保证
  - 本轮优化：`gatherStatic` 增加 1.5s 候选集缓存（此前每个按键都全量重建应用/模块/剪贴板/插件候选，实测一次约 180ms），设置/剪贴板/待办变更时主动失效

### T-08 收纳盒深化（沿 `docs/deskbox-integration-plan.md` 二期）

- [x] 盒子组 / 胶囊模式：盒子收起成胶囊（💊 按钮），同组（`DesktopBox.group`）胶囊并排停靠成胶囊栏，悬停临时展开 / 点击固定展开（`boxWindow` 胶囊布局 + `setCapsulePreview`）
- [x] QuickLook 集成：盒子内按空格预览文件（探测运行中/安装的 QuickLook.exe 调用其预览；未检测到自动用内置预览窗兜底：图片/文本/音视频/元信息卡，`electron/services/filePreview.ts` + `src/PreviewApp.vue`）
- [x] 文件叠放（Stacks）：手动叠放（盒内拖 A 到 B 上合成一摞）+ 自动归组（按 图片/软件/压缩包/文档/视频/音频 分类聚摞），展开面板可单条取消叠放/解散
- [x] 自动整理增强：下载/解压稳定后自动归类桌面新文件（`restartSmartWatch` 扩展：下载目录监听 `settings.boxWatchDownloads` + 大小/修改时间连续 4 秒静默才归类，30 秒兜底）
- [x] 多显示器**布局记忆**：按显示器组合（拓扑+DPI）分别保存盒子位置尺寸，热插拔后恢复
  - 落地：`DesktopBox.layouts` 按显示器组合指纹（bounds+scaleFactor）存 8 组布局，`boxWindow` 按当前组合恢复，无记忆回退单一 bounds 兼容旧数据
- [x] 验收：重启/换屏后布局完整恢复；叠放操作不误删/不移动原文件（叠放/胶囊均为纯索引与窗口状态，desktop_box 的"归类不移动"原则）

### T-09 待办模块升级（情感化联动）

- [x] 截止日期、重复任务、颜色标签、Markdown 备注（`TodoItem` 扩展 dueAt/repeat/color/note，编辑弹窗一站式配置，备注支持极简 Markdown 实时预览）
- [x] 筛选与批量操作（全部/今天/逾期/已完成 计数筛选；批量模式选中完成/删除；清空已完成）
- [x] 与宠物提醒深联动（T-05）：提醒动画（气泡 + nod 点头，主进程既有）+ 完成庆祝（新增 `pet.play` 通道，完成时宠物 jump + 🎉 提示）
- [x] 验收：一个周期性待办从创建 → 到期提醒 → 完成庆祝全流程可用（重复任务完成后自动生成下一期：日/周/月）

---

## P2 — 长期竞争力（第 4 季度及以后）

### T-10 性能与资源治理

- [x] 性能模式：均衡 / 节省资源 / 自定义（动画开关 + 闲置释放），对标 DeskBox 设计；缓存回收沿用 Chromium 自动管理 + 后台节流
  - 落地：`electron/services/perf.ts`（设置 → 通用 → 性能与资源），动画开关经 preload 注入 `html[data-anim]` 全窗口统一生效
- [~] 空闲内存 ≤ 250MB 达标并**在设置中可视化展示资源占用**（坦诚换信任）：RSS/堆内存/窗口数/运行时长设置页实时展示 ✅；**≤250MB 实测未达标（附数据与结论，见下）**
  - **实测（`npm run bench`，本机 Electron 33 / Windows）**：无任何业务窗口时整机常驻 **319MB**（主进程 135MB + GPU 99MB + Utility 85MB）；工作台打开后 **582~607MB**（多出渲染进程 117MB 与 GPU 上涨）
  - **结论（坦诚换信任）**：Chromium 自身基线（≈319MB）已高于 250MB 门槛，与我们写多少业务代码无关 —— 该门槛在"启用硬件加速 + Electron"前提下**不可达成**。可选缓解：①「禁用硬件加速」在工作台打开时省约 95MB；②**节省资源模式**（`perfMode: 'saver'`）在工作台隐藏 1.5s 后销毁其渲染进程，实测**回收 118~120MB**（首次实现于本轮）；③关闭工作台常驻（默认即非常驻，启动不创建该窗口）
  - 建议：把门槛改为"业务窗口增量"口径（当前 ≈1MB/600 条条目）或按"禁用硬件加速 + 工作台关闭"重新标定；`npm run bench` 已把该项标为**只记录不判定**，避免工具因环境基线永远报红
- [x] 多窗口（宠物/侧边栏/盒子/面板/看板）隐藏时按策略释放渲染资源：`browser-window-created` 统一接入 `setBackgroundThrottling`（允许 Chromium 后台节流；关闭「闲置释放」则保持满速）
- [x] 节省资源模式进一步释放：工作台作为"呼之即来"的面板，隐藏 1.5s 后**销毁其渲染进程**（延迟是为了让在途 IPC 收尾），下次呼出按需重建 —— 实测回收 118~120MB（本轮新增，仅 `perfMode: 'saver'` 生效）
  - 注：曾尝试用 `webContents.setFrameRate(4/0)` 降帧，但该 API **仅对离屏渲染生效且只接受 1~240**（契约之外，实测对普通窗口无效），已移除
- [ ] Tauri 迁移维持"暂不迁移"决策；新代码保持模块化以便未来增量替换

### T-11 数据资产与信任

- [x] 设置备份 / 恢复（一键导出导入）：设置 → 系统集成 → 数据备份与诊断；导入后立即重放热键/托盘/自启等副作用
- [x] 一键诊断包（隐私过滤后导出日志）：`electron/utils/log.ts` 日志落盘（1MB 轮转）+ 导出时自动脱敏（API Key/邮箱/证照号/用户目录）
- [x] 剪贴板/插件安装包加密存储选项（spec 5.4）：剪贴板 AES-256-GCM 加密已落地（CH-03）；插件安装包加密留存已落地（T-11：`settings.marketEncryptPackages` 开启后市场安装包 AES-256-GCM 留存 `secure-packages/`，设置 → 隐私与文件 可查看/清理）

### T-12 生态与国际化

- [x] 多语言（i18n）：简中/繁中/English/日本語 —— **2026-09-27 落地基础设施 + 外壳**
  - 分层：`shared/i18n/`（纯函数：字典 + 插值 + 回退链 + 词表优先的简繁转换）、`electron/services/i18n.ts`（主进程）、`src/i18n.ts`（渲染层响应式）
  - **繁体不逐条人工翻译**：由 `hant.ts` 从简体转换（先词表后字表）—— 逐字转换必错（复制→復制、设置→設置、文件→文件），词表收了两岸用词差异与一字多形词；`zh-TW.ts` 只留少量整条覆写
  - 已本地化外壳：托盘菜单 / 宠物右键 / 系统通知 / 工作台全部标签 / 命令面板 / 设置导航 + 语言选择器 / 侧边栏按钮
  - 未本地化：设置各分区正文、剪贴板、市场、开发者工具、插件输出等长尾（全仓 1683 行含中文）—— `npm run i18n` 给出可复跑的覆盖率与优先级，见 `docs/i18n.md`
  - 质量约束：en/ja **必须**覆盖 zh-CN 全部 key（测试强制）；新增文案漏字会被"不残留简体独有字"不变式挡住；缺 key 显示 key 本身而不是空白
- [ ] 皮肤/主题包市场、插件开发大赛 / 社区运营（主题包格式 / SHA256 / 分享文案已就绪，市场可直接消费）
- [ ] 文档站：用户手册 + 插件开发教程（`docs/plugin-development.md` 扩充）

### T-13 分发与商业化

- [ ] 商业模式：免费 + 生态变现（官方插件市场服务 / 云同步订阅），核心保持开源
- [ ] 上架 Microsoft Store；国内软媒渠道（小众软件/异次元）+ 小红书/B 站 UGC 传播（宠物+收纳组合有天然传播力）
- [ ] ⚠️ 品牌风险：**"小鹏"与小鹏汽车撞名**，评估改名或注册独立商标
- [~] ⚠️ 开源合规：DeskBox 为 GPL-3.0、translators 为 GPL-3.0 —— 只可借鉴交互思路，**严禁复制其代码进 MIT 项目**；构建 SBOM 清单 ✅（`npm run sbom` → `sbom.json`，CycloneDX 精简格式 + copyleft 自动审查，当前依赖树无 GPL/AGPL/LGPL 组件）

---

## T-16 插件异步任务模型（PM-03 扩展，2026-09-27 立项并落地）

> 来源：`独立测试报告.md` P1-5 的修复建议 —— "长任务改异步任务模型（返回 jobId + 轮询/事件回报）"。
> T-15 先落地了等价兜底（在途调用不回收 + 超时放宽到 600s），本轮把模型本身做完。
> 状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成

### 协议（向后兼容，不改动任何既有方法签名）

- [x] 宿主 → 插件：新增**可选**方法 `plugin.jobs` → `{"jobs":[{id,title,status,progress,message,result,startedAt,updatedAt}]}`
  - 未实现的插件返回 `unknown-method`/报错都被静默忽略，行为与改造前完全一致（宿主每 2s 轮询一次，仅在该插件有进行中任务时）
- [x] 插件 → 宿主：新增事件 `{"type":"job","jobId":…,"status":"running|done|error","progress":0-100,"message":…,"result":…}`
  - 也支持在 `plugin.handle_action` 的返回值里直接带 `job` 字段（最省事的一种写法）
- [x] 共享库 `plugins/_shared/jobs.py`：`JobRegistry` / `Job.start()` / `progress()` / `done()` / `fail()`，
  并自动应答 `plugin.jobs`（内置录屏三插件已接入，版本 1.0.0 → 1.1.0）

### 宿主行为

- [x] 任务登记：`upsertJob` 统一处理"事件上报"与"返回值带 job"两条入口；`listPlugins()` 把任务附到记录上（`jobs` 字段，仅内存态）
- [x] **保护**：存在 `running` 任务时**绝不回收**插件进程；每轮轮询会续期保护窗口（`JOB_GRACE_MS` 10 分钟）
- [x] **心跳**：插件发回的任何消息（结果/事件/进度）都会刷新活跃时间并解除过期保护
- [x] **终态反馈**：`running → done/error` 弹系统通知（含产物路径）；插件进程退出时未完成任务标记为
  `error: 插件进程已退出，任务未完成`（此前用户完全看不到失败原因）
- [x] **可观测**：`PluginRecord.runtimeStatus` 新增并暴露到 UI —— `running` / `等待并发槽位…` / `空闲回收` /
  `error: 缺少模块 X` / `exited (n)` / `后台执行中：…` / `超时（600s）：…` 终于能在插件卡片上看到
- [x] 超时语义修正：动作类调用超时不再等于"这次调用没发生"，状态里明确写"插件可能仍在后台执行，产物稍后可能出现"

### UI

- [x] 插件卡片：后台任务标题 + 进度条 + 状态文案（running/done/error 三态配色），无任务时不渲染、外观与之前一致
- [x] 卡片订阅 `plugins:changed` 刷新任务；动作返回 `job` 时立即刷新一次（点完就能看到进度条）
- [x] 运行期状态提示（仅在非正常状态显示，避免日常噪音）

### 验收与回归

- [x] `npm test`：新增「PM-03 插件异步任务模型（B）」一节 —— Python 侧协议一致性（事件结构/进度透传/终态/快照/应答）
  + 宿主侧源码契约（登记、保护、轮询、退出标记、状态暴露）+ "登记表必须在 send() 之后初始化"这类踩坑断言
- [x] `npm run smoke`：新增「B 插件异步任务模型」端到端 —— 桩插件（`scripts/smoke-job-plugin.py`，纯标准库）
  走真实链路：loadPlugin → 动作立即返回 job → 事件/轮询推进进度 → `listPlugins().jobs` 显示终态与产物
- [x] 真机验证：`office-screenrecord-gif` 真实录屏 3 秒 → 事件序列 `running@5 → @21 → @41 → @61 → @85 → done@100`，
  `plugin.jobs` 轮询拿到同一状态，产物 GIF 正常生成（测试产物已清理）
- [x] 文档：`docs/plugin-development.md` 新增「后台任务协议」整节（含三步接入示例与踩坑提示）；
  `docs/ai-plugin-prompt.md` 修正过期的 30 秒超时口径，并加入长任务写法（AI 生成的插件也能直接用）

---

## T-15 独立测试报告缺陷修复（2026-09-27，来源 `独立测试报告.md`）

> 第三方独立测试（静态审计 + 纯函数模糊测试 + Electron 运行期真机 + zxing-cpp / Python qrcode 交叉验证）共报 41 项：**6 项 P1、25 项 P2、10 项 P3**。
> 本轮**全部处理**，并新增两条回归防线。详细修复清单见 `docs/变更记录.md`；验收见 `docs/acceptance-checklist.md` 第 11 节。
> 状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成

### T-15.1 P1 严重缺陷（6 项）

- [x] P1-1 全新安装后侧边栏无任何内置模块 —— `defaults.modules` 是死代码
  - 落地：`dataStore.load()` 判定"无任何设置行 = 全新库"时播种内置模块并 `persistAll()`；运行期断言「全新安装首启即有内置模块」通过
- [x] P1-2 「检查更新」永远失败且版本号不一致
  - 落地：`package.json` 1.0.0 → **2.1.0**（与产品文档口径一致）；`updateFeedUrl` 支持 `owner/repo` 简写；设置页在仍使用内置占位仓库时**显式提示**（失败依旧静默不打扰）
- [x] P1-3 加密存储未覆盖缩略图与 OCR 文本
  - 落地：加密模式下缩略图落 `*.thumb.bin`（不再有明文 `.thumb.png`）、OCR 文本与正文同等加密（`ocrEncrypted` 标记）；运行期断言磁盘上只有密文、缩略图仍可由主进程解密读回
- [x] P1-4 设置项类型错乱即让剪贴板监听永久停摆
  - 落地：`sanitizeSettingsPatch` 按默认值形态逐类校验（数组/纯对象/枚举白名单/数值区间夹取），并提供可读警告日志
- [x] P1-5 长任务被宿主超时与空闲回收打断（完整异步任务模型见 T-16）
  - 落地：动作类调用超时 30s → **600s**（与插件内部允许值对齐）；引入 `inflight` 计数（在途调用期间不回收）、插件消息心跳、以及"后台执行中"保护窗口（识别"录制中（N 秒）"这类返回）；超时不再等同于"没发生"（状态注明可能仍在后台执行）
  - 完整"异步任务模型（jobId + 轮询 + 进度上报）"已作为 **T-16** 落地（见下）
- [x] P1-6 Office → PDF 分支永远不可达
  - 落地：`office_kinds` 键名口径统一（`.lstrip('.')`）；`run_cmd` 增加可选 `env` 并真正下发 `SRC/OUT`；输出走 `unique_path`

### T-15.2 P2 一般缺陷（25 项）

- [x] P2-1 呼出工作台清空「复制的文件」剪贴板 —— 不再预先 `writeText('')`，只在内容真的变化时回写；检测到文件列表格式时完全跳过模拟取词
- [x] P2-2 命令面板首次呼出空白且无焦点 —— 等 `did-finish-load` 再发 `palette:shown`，渲染层挂载即聚焦兜底
- [x] P2-3 侧边栏窗口关闭后本次运行内无法再显示 —— `showSidebar` 按需重建并重挂自动收回监听
- [x] P2-4 内置预览整文件读入内存 —— 改为 `readHead()` 只读前 512KB（实测 300MB 文件 RSS +1MB）
- [x] P2-5 跨盘符「真移动」文件夹静默失败 —— 目录走 `cpSync(recursive)`，失败弹可读通知
- [x] P2-6 胶囊盒位置记忆失效 —— 非胶囊态清除 `expandBounds`（`updateBox`/`updateBoxBounds` 两侧同步），窗口侧也只在胶囊态读取
- [x] P2-7 别名「导出→导入」自身备份 100% 失败 —— 导入改为按别名**覆盖更新**（幂等）
- [x] P2-8 备份导入不剥离 BOM —— 备份/别名导入均剥 BOM，并给出正确提示文案
- [x] P2-9 片段展开污染剪贴板历史 —— 走 `setClipboardText` + 抑制窗口
- [x] P2-10 插件依赖标记 `depsInstalled` 被覆盖 —— `persist` 改为展开运行时记录，不再丢字段
- [x] P2-11 正则测试可冻结界面 —— 静态风险提示 + 输入长度上限 + **Worker 内执行并超时强制终止**
- [x] P2-12 时间解析接受不存在的日期 —— 逐字段回验；`explainTimeInput` 给出可读原因
- [x] P2-13 合法 cron 表达式被报"无法解析"（`0 0 29 2 *`）—— 改为按天筛选 + 命中日枚举时分秒，窗口扩到 8 年
- [x] P2-14 排除目录纯前缀匹配误伤兄弟目录 —— 按路径分隔符划边界
- [x] P2-15 附加匹配键未小写化 —— 统一小写后参与匹配
- [x] P2-16 收纳盒卡片向下拖拽排序无效 —— 按拖拽方向决定插入位置
- [x] P2-17 JSON 后端写盘失败后不再重试 —— 失败保留 dirty 并按退避重试（最多 5 次）
- [x] P2-18 密钥文件异常即被覆盖 —— 先备份为 `*.bad-<ts>.bak` 再重建；注释如实说明 Windows 下 0600 无效
- [x] P2-19 多文件转换只处理第一个却提示"完成" —— 追加"仅处理了第 1 个，其余 N 个已忽略"
- [x] P2-20 PDF 系列输出绕过 `unique_path` —— 报告列出的 7 处 + 同类的 3 处写盘点全部统一
- [x] P2-21 PDF→图片 / OCR 目标在 UI 不可达 —— 下拉补齐，并让 OCR 对 PDF 真正可用（先渲染再识别）
- [x] P2-22 OCR 失败时临时明文截图不清理 —— 临时文件路径提前声明并 `finally` 清理
- [x] P2-23 `forge:install` 未校验 `manifest.entry` —— 安装侧文件名白名单 + 加载侧入口路径包含性校验（纵深防御）
- [x] P2-24 托盘菜单快照过期 / 剪贴板热键副作用不重放 —— 托盘内补 `applyClipboardHotkey()`；设置变更后刷新托盘菜单
- [x] P2-25 「修复卡住的窗口」修不到侧边栏 —— 改为按**已加载页面**判定（标题仅作兜底）

### T-15.3 P3 轻微问题（10 项）

- [x] P3-1 孤立代理项按 WTF-8 编码 → 统一替换为 U+FFFD（与 Node/Python 标准一致）
- [x] P3-2 `radixConvert('-0xFF')` 被拒 → 先摘符号再摘进制前缀
- [x] P3-3 `urlDecode` 把字面 `+` 当空格 → 与 `encodeURIComponent` 规则对齐
- [x] P3-4 `diffLines` 忽略结尾换行差异 → 保留末尾空行（可无损还原）+ 差异标记
- [x] P3-5 剪贴板上限下限 50 与设置不一致 → 下限改为 10 并与设置校验区间对齐
- [x] P3-6 每 10 秒无条件全量落盘 + 全窗口广播 → 无提醒时不写库不广播
- [x] P3-7 空路径 IPC 产生误导性错误日志 → `asset:to-url` 返回空串、`boxes:preview-data` 返回空预览
- [x] P3-8 每条剪贴板记录都启动 PowerShell 探测 → 探测加 1.5s TTL 缓存；名单为空时先入库后补来源
- [x] P3-9 文档插件数量口径不一致（原写"16 个"，实测为 15 个）→ 已按实际数量订正
- [x] P3-10 `PluginRecord.origin` 从未写入 → 市场安装标记 `origin: 'market'`

### T-15.4 新增回归防线

- [x] `npm test` 新增「审计缺陷回归（独立测试报告 41 项）」一节：纯函数行为断言 + 关键修复的源码契约断言
- [x] `npm run smoke` 新增「审计缺陷运行期回归」小节：全新安装播种、设置类型校验、加密覆盖面、片段不污染历史、别名导入幂等、侧边栏重建、看门狗覆盖、面板焦点、剪贴板格式保留
- [x] 修正 `test-audit/edge-pure.mjs` 自身 3 处缺陷（latin1 哈希参考 / 非良构字符串往返期望 / cron 参考窗口 366 天），修正后该脚本 0 问题

---

## T-14 主流化功能补齐（2026-09-27 立项，详见 `docs/项目需求文档.md` / `docs/SPC文档.md`）

> 来源：`docs/调研报告-2026-09.md`（uTools/Quicker/PixPin/Listary/PowerToys 对标）。
> 已拍板：分期 B 方案（P0=M1+M2，P1=M3+M4）；超级面板=**扩展既有工作台**实现；开发者工具**内置实现**；上下文抓取=模拟 Ctrl+C+剪贴板保护；更新源=GitHub Releases；不引入全局鼠标钩子。
> 粒度 0.5~2 天/条；状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成

### T-14.1 M1 工作台智能化（P0，WK-01 ~ WK-06）

- [x] WK-a 上下文抓取服务 `contextCapture`：模拟 Ctrl+C + 剪贴板快照/暂停监听/恢复（复用 translateBar 机制），类型判定 text/file/url/image/none（约 2 天）
  - 依赖：clipboardManager 既有 pause/resume；验收：抓取 ≤ 300ms，剪贴板 100% 恢复（含异常路径），类型识别 ≥ 95%
  - 落地：`electron/services/contextCapture.ts`（剪贴板快照 + `suppressClipboardCapture` + 20ms 轮询预算 300ms + finally 恢复；异常一律恢复并按 none 兜底）；类型判定复用 `shared/devtools/intent.ts`（`inferClipboardIntent`）；`npm test` 断言 8 条意图识别用例全绿
- [x] WK-b 动作模型 + 内置动作落地：text/file/url/image 四组（翻译/搜索/大小写/去空格/朗读；显示/复制路径/预览/归档；快开；贴图/OCR）（约 2 天）
  - 依赖：WK-a；验收：每组 ≥ 4 动作，全部走既有服务；归档动作**默认不启用**（用户手动启用/固定后显示），收纳盒关闭时强制隐藏（WK-06）
  - 落地：`shared/types.ts` ContextAction/ContextPayload + `electron/services/contextActions.ts`（19 个内置动作：text 8 / file 4 / url 2 / image 2 + 智能匹配 3）；归档动作 `requiresEnable` 且收纳盒关闭时强制隐藏；使用频率写入 `palette_usage`（键 `ctx:<id>`）
- [x] WK-c 工作台 UI 接入：上下文分组区 + 固定（Pin）+ 频率排序（`palette_usage`）+ Ctrl+数字快捷序号（约 1.5 天）
  - 依赖：WK-b；验收：固定重启保留；无上下文时 UI 与现状一致（WK-05）
  - 落地：`src/DeskboardApp.vue` 顶部上下文区（常驻/本次两组 chip、右键或 📌 固定、Ctrl+1~9 快捷执行、执行反馈）；主进程 `showDeskboard` 先抓取再 `showInactive → focus`（不抢焦点，取词才取得到选中内容）；无上下文时仅显示提示，搜索/应用网格/功能卡布局不变
- [x] WK-d 设置项 `deskboardContextCapture`（默认开）+ 设置页开关 + `npm test` 断言（约 0.5 天）
  - 验收：关闭后行为与现状完全一致
  - 落地：设置 → 桌面工作台「上下文感知」开关（含固定动作清空入口）；关闭时 `showDeskboard` 直接显示并推送 `none` 上下文，行为与改造前一致

### T-14.2 M2 开发者工具百宝箱（P0，DEV-01 ~ DEV-12）

- [x] DEV-a `shared/devtools/` 纯函数第一批：json/time/codec/uuid/radix/hash（约 2 天）
  - 验收：函数零 IO；`npm test` 用例 ≥ 15 条全绿；非法输入返回结构化错误
  - 落地：`shared/devtools/{json,time,codec,uuid,radix,hash}.ts`；哈希为纯 JS 实现（MD5/SHA1/SHA256，标准测试向量断言通过，渲染层无需 IPC）
- [x] DEV-b 纯函数第二批：unit/cron/diff/regex/qrcode（约 2 天）
  - 依赖：DEV-a 的测试骨架；验收：用例 ≥ 15 条；qrcode 自研/公有领域实现（Q7），不引第三方库
  - 落地：`shared/devtools/{unit,cron,diff,regex,qrcode,intent,alias}.ts`；二维码为自研编解码（版本 1~10 / L·M·Q·H / 数字·字母数字·字节模式，几何推导的总码字数与 ISO 标准逐版本一致；解码含角标定位 + Otsu 二值化），Q7 按“自研/公有领域”假设闭环，零第三方依赖
- [x] DEV-c 命令面板即时结果：DEV-12 输入形态识别 + 置顶渲染 + 回车复制（约 1 天）
  - 依赖：DEV-a；验收：即时结果 ≤ 100ms，沿用 150ms 防抖，不拖慢既有搜索
  - 落地：`paletteSearch.devInstantResults`（`json {…}` / 直接粘贴 JSON、`ts 1727…` 或纯 10·13·16 位、`uuid`、`md5|sha1|sha256|hash`、`b64`、`url`、`radix` 或 `0x/0b/0o`、`cron`），新增 `instant` 分类置于结果最前，回车复制（`dev-copy:` 动作）；计算全部为纯函数（单次 < 1ms）
- [x] DEV-d 独立小面板 `DevtoolsView.vue`：正则测试/diff/二维码 Tab（约 1.5 天）
  - 依赖：DEV-b；验收：`devtools` 指令可达，结果一键复制
  - 落地：`src/views/DevtoolsView.vue` + `src/devtools.html` + `electron/windows/devtoolsWindow.ts`；四个 Tab（正则 / diff / 二维码 / 工具箱：JSON·时间戳·编解码·哈希·进制·单位·cron）；入口 `devtools` 及 `devtools:regex|diff|qrcode|tools`，命令面板与设置 → 系统集成 均可打开

### T-14.3 M3 划词动作条 + 格式化粘贴（P1，WK-07 / CH-07 ~ CH-10）

- [x] WK-e 划词动作条可配置化：动作启用/排序设置 UI + 大小写/去空格/朗读/搜索等新动作（约 1.5 天）
  - 依赖：translateBar 既有链路；验收：默认 ≥ 6 动作，设置增删排序即生效
  - 落地：`translateBar.ts` `currentBarActions/runBarAction` + `TranslateBarApp.vue` 动作 chip（Ctrl+数字）；默认 7 个动作（翻译/搜索/复制/大写/小写/去空白/朗读）；设置 → 系统集成「划词动作条」可开关与上下排序，翻译为必留动作
- [x] CH-a 格式化粘贴三件套：纯文本粘贴 / JSON 格式化粘贴 / 图片 OCR 转文字粘贴（约 1.5 天）
  - 依赖：DEV-a（jsonFormat）、ocr.ts 既有；验收：粘贴面板右键 + 工作台图片组双入口；写回-粘贴-恢复链路不破坏原剪贴板
  - 落地：`clipboardManager.pasteClipboardAs(id, 'plain'|'json'|'ocr')`（纯文本额外清理零宽/BOM/NBSP；JSON 共用 `jsonFormat`；OCR 复用 Tesseract）+ `ClipboardApp.vue` 右键菜单与 Ctrl+Shift+T；工作台图片组提供「OCR 取字 / 贴图到桌面」

### T-14.4 M4 别名与智能匹配（P1，AL-01 ~ AL-03 / CP-07）

- [x] AL-a 别名数据层 + 命中规则 + 冲突检测 + 管理页（导入/导出）（约 1.5 天）
  - 验收：别名精确匹配置顶；冲突拒绝保存；`npm test` 表结构断言
  - 落地：新表 `aliases`（key=id, value=JSON）+ `electron/services/aliases.ts` + 纯规则 `shared/devtools/alias.ts`（可在 npm test 直接断言）；`paletteSearch` 精确别名把目标结果提到第一；设置 → 系统集成「指令别名」支持增删改查与 JSON 导入导出
- [x] CP-a 粘贴智能匹配：`inferClipboardIntent` + 面板推荐动作分组 + `paletteSmartSuggest` 开关（约 1 天）
  - 依赖：WK-b 动作模型；验收：path/url/json/timestamp 识别 ≥ 95%，可一键执行可关闭
  - 落地：`shared/devtools/intent.ts`（path/url/json/timestamp/color/unknown）+ `paletteSearch.smartSuggestions`（空查询时置顶 `suggest` 分组，与 WK-02 共用 ContextAction）+ 设置 → 命令面板「粘贴智能匹配」开关；推荐动作执行时按当前剪贴板现场重建载荷

### T-14.5 轻量项 UPD-01 检查更新（P1）

- [x] UPD-a `updateChecker`：GitHub Releases 轮询（≤1 次/天）+ 托盘气泡/设置横幅 + 跳转下载（约 1 天）
  - 验收：失败静默写日志；`updateCheckEnabled`/`updateFeedUrl` 可配；不自动下载安装
  - 落地：`electron/services/updateChecker.ts`（零依赖 `https` + semver 比较 + 启动后延迟 30s + 24h 频率限制；发现新版发系统通知，点击跳转 Release 页）+ 设置 → 系统集成「检查更新」（开关 / 立即检查 / 自定义更新源 / 前往下载）

### T-14 验收工具

- [x] `npm test`：shared/devtools 纯函数 68 条断言（Node 类型剥离直跑，无需构建）
- [x] `npm run smoke`：Electron 运行期冒烟（`scripts/smoke-main.ts` + `scripts/run-smoke.mjs`；esbuild 打包 → 快照渲染产物 → 隐藏窗口运行；独立临时 userData，不触碰用户数据）
- [x] `npm run bench`：真机性能基准（`scripts/bench-main.ts` + `scripts/run-bench.mjs`），把文档里写死的性能门槛测出来：CP-03 首屏 / DEV-12 即时结果 / T-01 剪贴板内存与 CPU / T-10 空闲内存 / WK-01 抓取耗时；支持 `XP_BENCH_NO_GPU=1` 对照量化"禁用硬件加速"的收益

### T-14 依赖与风险

| 风险 | 应对 |
|------|------|
| 范围过大 | P0（T-14.1/14.2）为发布门槛，P1 允整体顺延 |
| 剪贴板抓取副作用 | WK-a 必须覆盖异常恢复路径用例 |
| GitHub 访问不稳 | UPD-a 失败静默，不影响主流程 |

---

## 路线图（一页版）

| 阶段 | 主题 | 核心任务 |
|------|------|----------|
| 第 1 季度 | 补承诺、堵口碑 | T-01 剪贴板、T-02 插件市场 v1、T-03 系统整合、T-04 截图增强（✅ 已完成，见 P0 落地说明） |
| 第 2 季度 | 差异化亮相 | T-05 AI 桌宠 2.0（✅ 语音/MCP/AI 用量管家已落地）、T-06 AI 造插件（✅ 向导+安装+发布闭环）、T-07 面板万能入口（✅ 划词翻译/取词 OCR） |
| 第 3 季度 | 生态起飞 | T-02 市场二期、T-06 UGC 市场、T-08 收纳盒深化（✅ 胶囊/QuickLook/叠放/自动整理）、T-09 待办情感化（✅） |
| 第 4 季度 | 品质与增长 | T-10 性能、T-11 数据信任、T-12 国际化、T-13 分发商业化 |
| 2026-09 立项 | 主流化补齐 | **T-14**：M1 工作台智能化、M2 开发者工具百宝箱（P0）→ M3 划词/粘贴、M4 别名智能匹配（P1），见 `docs/调研报告-2026-09.md` |

## 风险登记簿

| 风险 | 等级 | 应对 |
|------|------|------|
| "小鹏"商标撞名（小鹏汽车） | 高 | 尽早评估改名/注册商标（T-13） |
| GPL 代码污染 MIT 协议 | 高 | 合规审查 + SBOM（T-13） |
| Electron 内存/体积口碑 | 中 | 性能模式 + 可视化占用（T-10） |
| 插件市场安全事件 | 中 | HTTPS + SHA256 + 权限提示 + 未验证标签（T-02） |
| 剪贴板隐私泄露 | 中 | 排除关键词/白名单/加密（T-01） |
| **透明置顶窗渲染进程崩溃 → 幽灵窗口**（看不见却挡住点击） | 中 | 看门狗自动恢复 + 反复崩溃自动隐藏 + 显示前 `isCrashed` 自检 + 托盘急救 + 禁用硬件加速开关（维护迭代 9，见 `测试报告.md` 第十三节） |
| **打包链路依赖机器状态**（嵌入式 Python 缺组件 / 输出目录被占用） | 中 | 零注册的 CPython 独立构建（自带 tkinter）+ `prepare-dist` 自动清理 + `npm test` 运行时看门狗断言（维护迭代 8） |
| **数据文件被外部工具改写**（UTF-8 BOM / 损坏）→ 整库静默丢失 | 中 | 解析前剥离 BOM；真正损坏时先备份 `*.corrupt-<ts>.bak` 再启用空库（维护迭代 9） |
| 与 DeskBox/Flow Launcher 正面竞争 | 低 | 坚持"组合体 + AI + UGC"差异化，不对抗单点 |
