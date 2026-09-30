# Python 插件开发教程

插件为独立的 Python 3.10+ 进程（随包分发的嵌入式运行时为 CPython 3.12，见后文），
与主程序通过 **JSON-RPC 2.0 over stdio**（每行一个 JSON 对象）通信。

> 不想从零手写？应用内已有「AI 造插件」向导（设置 → 插件市场 → AI 造插件），会把
> `docs/ai-plugin-prompt.md` 的规范交给 DeepSeek 生成 `manifest.json` + `main.py`，再按本教程校对即可。

宿主侧还提供了一套桌宠对话 / 外部 MCP 共用的工具集（`electron/services/agentTools.ts`、
`electron/services/mcpServer.ts`），其中的 `run_plugin_command` 会调用插件的 `plugin.handle_command`——
也就是说插件命令除了全局命令面板，还可能被桌宠或 MCP 客户端触发；插件侧不需要为此做额外适配。

## 插件结构

```
my-plugin/
├── manifest.json    # 插件清单
├── main.py          # 入口脚本（默认）
└── icon.png         # 可选，插件图标
```

插件目录放于：

- `%APPDATA%\xiaopeng-toolbox\plugins\<插件id>\`（用户安装目录，可被"移除"）
- 应用自带 `plugins/`（内置目录）

## manifest.json

```json
{
  "id": "com.example.myplugin",
  "name": "示例插件",
  "version": "1.0.0",
  "author": "作者名",
  "description": "插件描述",
  "category": "工具",
  "type": "module",
  "entry": "main.py",
  "icon": "icon.png",
  "permissions": ["file"],
  "commands": [
    { "id": "hello", "title": "示例：问好", "keywords": ["hello", "nihao"] }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一，反向域名式小写标识（须匹配 `^[a-z0-9]+(\.[a-z0-9-]+)+$`，如 `com.example.myplugin`）；同时用作插件目录名，安装时强校验 |
| `name` | ✅ | 显示名：卡片、插件管理、通知标题兜底都用它 |
| `version` | ✅ | 版本号，建议语义化（`1.0.0`） |
| `author` | 建议 | 加载确认弹窗、插件管理、市场列表展示 |
| `description` | 建议 | 同上 |
| `category` | 可选 | 分类文本，如 `截图`/`录屏`/`转换`/`翻译`/`工具`。内置目录中命中「截图/录屏/转换/翻译」的插件会在首次启动自动启用 |
| `type` | ✅ | `module`（侧边栏卡片插件）或 `pet`（宠物插件）。**务必显式声明**：缺失时宿主会走宠物分支去调 `pet.get_actions` |
| `entry` | ✅ | 入口脚本，相对插件目录 |
| `icon` | 可选 | 图标文件名，相对插件目录 |
| `permissions` | 可选 | 权限声明数组，合法取值见下；**当前仅用于展示**，不做运行时限制 |
| `commands` | 可选 | 命令声明数组，进入全局命令面板（见「命令插件协议」）；旧插件无此字段完全兼容 |

> 缺少 `id` / `name` / `entry` 的目录不会被识别为插件（直接忽略）。

**`permissions` 合法取值**（标签表见 `electron/services/marketplace.ts`；未知值原样展示，不会报错）：

| 值 | 含义 |
|----|------|
| `file` | 文件（读写本地文件） |
| `network` | 网络（访问互联网） |
| `clipboard` | 剪贴板（读写剪贴板） |
| `screen` | 屏幕（截图/录屏） |
| `process` | 进程（启动外部程序） |

市场安装 / 加载确认弹窗会把这些值渲染成中文提示，请如实声明、不要夸大。

## 通信协议

**请求（主程序 → 插件）：**

```json
{"jsonrpc": "2.0", "id": 1, "method": "plugin.init", "params": {"config": {}}}
```

**响应（插件 → 主程序）：**

```json
{"jsonrpc": "2.0", "id": 1, "result": {"status": "ok"}, "error": null}
```

**主动事件（插件 → 主程序，无 id）：**

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "show_notification", "message": "任务完成"}}
```

约定：

1. **每帧一条 JSON、以 `\n` 结尾、写完立即 flush**；插件标准输出**只输出 JSON**，调试信息写 stderr
   （宿主把 stderr 收进调试日志，并从中识别 `No module named xxx` 用于依赖自愈）。
2. **UTF-8 输出**：宿主以 `PYTHONUTF8=1` 启动插件；JSON 用 `json.dumps(..., ensure_ascii=False)`。
3. 建议在入口加一次 `sys.stdout.reconfigure(encoding='utf-8')`（见下方最小模板）：
   `PYTHONUTF8=1` 只对宿主拉起的进程生效，插件被第三方拉起（别的工具、手动 `python main.py`、
   GBK 控制台）时 stdout 可能是 cp936，写中文会 `UnicodeEncodeError`，或写出 GBK 字节让解析方 JSON 解析失败。
   用 `try/except` 包住即可（Python 3.7+）。
4. **依赖要懒加载（踩过的坑）**：`plugin.init` 只有 15 秒，任何重的 `import` 都放到**首次真正使用**处，
   不要放模块顶层。`translators` 首次导入要联网拉引擎配置，实测 10~35 秒
   （见 `plugins/office-translate-pro/main.py` 的 `get_translators()`），顶层导入会让 `plugin.init` 直接超时、
   被标记为启动失败并误触发依赖重装。
5. 耗时操作（网络、截图、循环 > 1 秒）放到后台线程，先返回 `{"message": "进行中…"}`，完成后用 `event` 通知。
6. 文件读写显式写 `encoding='utf-8'`。

**宿主调用超时**（`electron/services/pluginManager.ts`）：

| 调用 | 超时 | 说明 |
|------|------|------|
| `plugin.init` | 15 秒 | 超时即杀进程、状态置 `error:`，并触发一次依赖自愈 |
| `plugin.get_ui` | 8 秒 | 卡片挂载 / 刷新 / 轮询都会调用，必须轻量 |
| `plugin.handle_action` | 30 秒 | |
| `plugin.handle_command` | 30 秒 | |
| `pet.get_actions` / `pet.play_action` | 8 秒 | |

## 环境变量

宿主拉起插件时注入以下环境变量：

| 变量 | 说明 |
|------|------|
| `PYTHONUTF8` | 恒为 `1` |
| `PLUGIN_SAVE_DIR` | 用户在设置里配置的默认保存目录，**可能为空字符串**，用前判空并 `os.path.isdir` 校验 |
| `ENGINES_ROOT` | 随包分发的 `engines` 目录（内含 `python/`，以及可选的 ffmpeg / LibreOffice 等外部工具） |
| `DEEPSEEK_API_KEY` | 用户在设置里填的 DeepSeek Key（可能为空） |

解释器选择顺序：`XP_PYTHON` 环境变量 > 随包嵌入式 Python（`engines/python/python.exe`）> 系统 PATH 的 `python`。

## 模块插件方法

必须实现 `plugin.init` / `plugin.get_ui` / `plugin.handle_action` 三个；`plugin.handle_command` 可选（见「命令插件协议」）。

| 方法 | 参数 | 超时 | 返回 |
|------|------|------|------|
| `plugin.init` | `{config: {}}` | 15s | 任意，成功即可（推荐 `{"status":"ok","name":"…","version":"…"}`） |
| `plugin.get_ui` | `{values: {...}}`（进程初始化后的首次为 `{}`） | 8s | UI 描述，见下 |
| `plugin.handle_action` | `{action, values}` | 30s | `{message?, metrics?, openUrl?}` |
| `plugin.handle_command`（可选） | `{command, text?}` | 30s | `{message?}` |

**UI 描述格式（`plugin.get_ui` 返回值）：**

```json
{
  "title": "示例",
  "text": "一段说明文字",
  "inputs": [
    {"id": "seconds", "label": "延迟(秒)", "type": "number", "default": "3"},
    {"id": "lang", "label": "目标语言", "type": "select", "options": ["zh-CN", "en"], "default": "zh-CN"},
    {"id": "file", "label": "文件路径", "type": "picker", "picker": "file", "default": ""},
    {"id": "dir", "label": "保存目录", "type": "picker", "picker": "folder", "default": ""}
  ],
  "buttons": [
    {"id": "hello", "label": "打个招呼"}
  ],
  "metrics": [
    {"label": "状态", "value": "运行中"}
  ]
}
```

- `title`：可选，当前侧边栏聚合卡不渲染它（保留字段兼容）。
- `inputs[].type`：`text`（默认）/ `number` / `select`（需 `options`）/ `picker`（需 `picker: "file"` 或 `"folder"`，
  宿主弹系统文件/目录选择器，选完自动回填并再次调用 `plugin.get_ui`）。
- `select` 的当前值不在 `options` 里时会被自动改成第一个选项。
- `metrics`：指标卡数组（`{label, value}`）。**只要返回了非空 `metrics`，卡片会每 5 秒调用一次 `plugin.get_ui` 轮询刷新**，
  所以 `get_ui` 必须快、可重复调用、无副作用。
- `get_ui` 会在卡片挂载、输入值变化（450ms 防抖）、选择器回填后反复调用，请每次返回完整的最新状态。
- `text` 支持换行（按原样换行显示）。
- 点击按钮后 `plugin.handle_action` 收到 `{"action": "hello", "values": {"seconds": "3", "lang": "zh-CN"}}`。
- `handle_action` 返回值的处理：
  - `{"message": "..."}` → 卡片弹出提示（toast）；
  - `{"metrics": [...]}` → 直接替换卡片指标区（适合手动刷新，如「AI 用量管家」的 `refresh`）；
  - `{"openUrl": "https://..."}` → 用系统浏览器打开（仅允许 `http` / `https` / `mailto`，见 `electron/utils/openExternalSafe.ts`）；
  - 直接返回字符串 → 当成提示文字；
  - 抛异常 / 超时 → 错误信息取自响应的 `error` 字段并提示给用户。

## 依赖安装（requirements.txt）

插件目录可放 `requirements.txt`（每行一个 pip 包，如 `mss`、`Pillow`）。宿主在**加载插件前**会自动执行：

```
<python> -m pip install setuptools wheel -r requirements.txt --disable-pip-version-check
```

- 安装成功后会在插件记录里持久化「已安装 + 使用的解释器」指纹，同一解释器下不会重复安装；
  换解释器（开发机 → 打包版）会自动重装。
- 单次安装超时 **5 分钟**；失败不抛异常，插件状态显示 `依赖安装失败 (code=…)`。
- 首次启动时，已启用插件的依赖会在后台按序补齐（不阻塞应用启动）。
- 全局并发上限 **5 个 Python 子进程**（插件进程与 pip 安装共用这个池），超出的排队等待。
- 启动失败且 stderr 出现 `No module named xxx` 时，宿主会自动清除依赖指纹并后台重装一次，
  状态提示「已自动重装依赖，请再点一次启动」——这也是**依赖必须懒加载**的现实原因之一：
  顶层 `import` 失败会被算作 `plugin.init` 失败。
- 内置插件（`plugins/`）的依赖会在打包阶段被 `npm run setup-python` 预装进嵌入式 Python，用户侧零等待。

## 嵌入式 Python 运行时

`npm run setup-python`（`scripts/setup-python.mjs`）会把一份 **python-build-standalone 的 CPython 3.12 独立构建
（install_only 归档）** 解压到 `engines/python`，随安装包分发，最终用户无需自装 Python：

- **自带 tkinter / tcl-tk / pip / ssl** —— 需要图形界面框选的插件可以放心 `import tkinter`
  （区域截图、区域录制就依赖它）。旧方案用的 python.org embeddable 包不含 tkinter，已弃用。
- 打包前会精简运行时（删除 `*.pdb` 调试符号与 `idlelib`/`test`/`lib2to3` 等开发组件），
  并预装全部内置插件 `requirements.txt` 里的第三方库。
- 冒烟测试覆盖 `ssl / json / sqlite3 / tkinter`，保证这些标准库可用。
- 设置 → 运行环境 会显示实际使用的解释器路径与 tkinter 诊断（就绪 / 缺失），对应
  `electron/services/pluginManager.ts` 的 `runtimeInfo()`。
- `engines/` 不进 git（已被 `.gitignore` 排除）；本地构建时执行一次 `npm run setup-python`，
  首次会联网下载，约 1~3 分钟。可用 `XPOS_PY_URL` 环境变量换成同结构的其他归档。

解释器选择顺序：`XP_PYTHON` 环境变量 > `engines/python/python.exe` > 系统 `python`
（开发调试时可用 `XP_PYTHON` 指向自己的虚拟环境）。

## 内置插件共享库

内置办公插件共用 `plugins/_shared/screen_capture.py`：截屏与 PNG 编码走纯 ctypes GDI（无第三方依赖），
**区域框选用 `tkinter`**（因此依赖嵌入式 Python 的 tkinter，见上）。插件通过
`sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))` + `from _shared import screen_capture` 引用；
其中 `save_temp_png(...)` / `request_pin(path)` 用于「截图并贴图」。
第三方插件请自包含，不要依赖该目录。

## 宠物插件方法

| 方法 | 参数 | 超时 | 返回 |
|------|------|------|------|
| `plugin.init` | `{config}` | 15s | 任意，成功即可 |
| `pet.get_actions` | `{}` | 8s | 动作名数组，如 `["nod", "wave", "dance"]` |
| `pet.play_action` | `{action, context}`（`context` 当前恒为 `"clicked"`） | 8s | 任意 JSON |

宠物被单击时，宿主会从 `pet.get_actions` 的返回值里随机挑一个动作调用 `pet.play_action`；
同时内置宠物仍会播放默认动作。只有已启用、且进程已拉起的 `type: "pet"` 插件会被调用。

## 支持的事件（插件 → 主程序）

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "pet_notify", "message": "任务完成"}}
```

`event` 方法的 `params.type` 支持以下全部取值（注意**文本字段统一叫 `message`**）：

| type | params | 说明 |
|------|--------|------|
| `show_notification` | `{message, title?}` | 弹系统通知；`title` 缺省时用插件 `name`。文本字段是 `message`，不是 `text`/`body` |
| `pet_notify` | `{message}` | 让桌宠气泡播报（用户开启语音后由桌宠朗读）；同样用 `message` |
| `toggle_sidebar` | `{}` | 呼出/收起侧边栏 |
| `pet.clicked` | `{}` | 触发宠物播放随机动作 |
| `pet.double_clicked` | `{}` | 呼出/收起侧边栏 |
| `pin.capture` | `{path}` | 把图片「贴到桌面置顶」（可缩放/透明/关闭）；`path` 为空时忽略 |

**其他 type** 会以 `plugin:event` 广播给所有窗口（payload 为 `{pluginId, type, params}`），
渲染进程可用 `window.api.plugins.onEvent` 订阅（当前内置界面未使用该通道）。

## 最小模板

`main.py`：

```python
import json, sys

# 强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '示例插件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {'text': '你好', 'buttons': [{'id': 'hi', 'label': '你好'}]}
    if method == 'plugin.handle_action':
        return {'message': '收到：' + str(params)}
    if method == 'plugin.handle_command':      # 可选，配合 manifest.commands
        return {'message': '命令 ' + str((params or {}).get('command'))}
    return None

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get('id') is None:
        continue
    try:
        result = handle(req.get('method', ''), req.get('params') or {})
        send({'jsonrpc': '2.0', 'id': req['id'], 'result': result, 'error': None})
    except Exception as e:
        send({'jsonrpc': '2.0', 'id': req['id'], 'result': None, 'error': str(e)})
```

## 安全说明

- 加载**非内置**插件前宿主会弹确认对话框；在插件管理里把插件加入「信任来源」后不再弹窗。
  内置目录 `plugins/` 下的插件视为可信，免确认。「AI 造插件」向导安装的插件因为在预览里已让用户看过代码，
  会自动写入信任来源。
- 插件运行在独立子进程中，崩溃或死循环不会影响主程序；调用超时见上面的超时表（8 / 15 / 30 秒）。
  超时或被回收后状态会变成 `error:` / `空闲回收`，再点一次卡片即可重新拉起。
- 同时最多 5 个 Python 子进程（插件 + pip 共用）；插件进程空闲超过 180 秒（每 60 秒扫描一次）会被回收，
  状态显示「空闲回收（点击卡片自动重启）」，用户点击卡片会自动重启，基本无感。
- `permissions` 只是声明，当前版本不做运行时限制；安装/加载弹窗里的权限提示来自插件自己的声明。
- 插件是本地代码，只加载你信任来源的插件。

## 调试

```bash
python plugins/example-plugin/main.py
# 在另一个终端：
python scripts/plugin-debug.py
```

或直接手写输入：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"plugin.init","params":{}}' | python plugins/example-plugin/main.py
```

调试要点：

- 应用内的调试日志会带上 `[plugin:<插件id>]` 前缀输出插件的 stderr，插件里的 `print(..., file=sys.stderr)` 能直接看到。
- `plugin.init` 返回失败 / 超时：先排查顶层 `import`（改懒加载）、再排查 `requirements.txt`
  是否装成功（插件管理里看状态）。
- 依赖出问题时可删除插件记录里的依赖指纹或直接重装：宿主在识别到 `No module named xxx` 时会自动重装一次。

## 命令插件协议（PM-03，v2.1 新增）

`manifest.json` 可声明 `commands` 字段，命令会**直接注册进全局命令面板**（兼容旧插件：无此字段即不注册）。
只有**已启用**的插件才会注册命令：

```json
{
  "commands": [
    { "id": "hello", "title": "示例：问好", "keywords": ["hello", "nihao"] }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 命令 id，插件内唯一；**不要包含 `:`**（命令面板内部用 `:` 拼接路由，含冒号会被截断） |
| `title` | ✅ | 命令面板里显示的名字 |
| `keywords` | 可选 | 额外搜索关键词数组（拼音、别名等） |

用户在命令面板选中命令并回车后，宿主调用 `plugin.handle_command`：

```json
{"jsonrpc": "2.0", "id": 3, "method": "plugin.handle_command", "params": {"command": "hello", "text": "可选文本"}}
```

- `params.command` 是上面声明的命令 `id`；`params.text` 只有部分调用方会传（如桌宠 Agent 工具 `run_plugin_command`、
  划词翻译兜底），**可能不存在**，取用前先判空。
- 超时 30 秒；抛错会把错误写进调试日志。
- 返回 `{"message": "…"}`：命令面板会把它写进调试日志；被 `run_plugin_command`（桌宠对话 / MCP）
  或划词翻译调用时，`message` 就是返回给调用方的结果文本。
- `plugin.handle_command` 是**可选**方法：不实现时宿主只会拿到插件自己的兜底返回值（如 `{"status":"unknown-method"}`），不会崩。

完整示例见 `resources/market/packages/com.example.command-tool/`；
内置实例见 `plugins/office-translate-cnen`（`translate` 命令）与 `plugins/office-deepseek-monitor`
（`report` 命令，配合 `pet_notify` 播报）。

## 后台任务协议（PM-03 异步任务模型，v2.1 新增）

**什么时候需要它**：一次动作要跑几十秒到几分钟（录屏、批量转换、大文件下载…）。
如果让 `plugin.handle_action` 一直挂着等结果，会有三个具体后果：

1. 宿主有调用超时（动作类 600 秒），超时后这次调用就被判失败 —— 但插件其实还在跑，用户白等；
2. 期间用户看不到任何进展（只有个转圈）；
3. 早期版本里空闲回收器还会把这个"看起来没动静"的进程 kill 掉 → **产物直接损坏**
   （典型现象：MP4 缺 moov 索引不可播放、转换结果被丢弃）。

异步任务模型把长任务拆成「立即返回 + 进度上报」，宿主负责登记、轮询、通知与保护。

### 插件侧：三步接入

`_shared/jobs.py` 提供了现成的登记表（内置录屏三插件都在用）：

```python
import json, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _shared.jobs import JobRegistry

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

# 注意：必须在 send() 之后初始化 —— 它把 send 作为回调注入，提前写会 NameError 导致插件起不来
JOBS = JobRegistry(send)

def work(job):
    for pct in range(0, 101, 10):
        time.sleep(1)
        job.progress(pct, '已完成 %d%%' % pct)   # 进度 + 文案
    job.done('处理完成', result='C:\\out\\result.mp4')  # 或 job.fail('磁盘已满')

def handle(method, params):
    answer = JOBS.handle(method, params)         # 宿主轮询 plugin.jobs 时自动应答
    if answer is not None:
        return answer
    if method == 'plugin.handle_action':
        job = JOBS.start('批量转换')
        threading.Thread(target=work, args=(job,), daemon=True).start()
        return {'message': '任务已开始', 'job': job.to_dict()}   # 立即返回，不阻塞
    return {'status': 'unknown-method'}
```

不想用共享库也可以自己实现，只要满足下面两条协议即可。

### 协议 A：宿主查询任务（可选实现）

宿主每 **2 秒**调用一次 `plugin.jobs`（只在该插件有进行中的任务时）：

```json
{"jsonrpc": "2.0", "id": 9, "method": "plugin.jobs", "params": {}}
→ {"jobs": [{"id": "rec-1", "title": "全屏录制", "status": "running", "progress": 42,
             "message": "已录制 42%", "startedAt": 1790500000000, "updatedAt": 1790500001000}]}
```

**不实现该方法完全没问题**（返回 `{"status":"unknown-method"}` 或直接报错）：宿主会静默跳过，
插件行为与以前一字不差 —— 这是本协议刻意保持的向后兼容。

### 协议 B：任务状态字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 任务 id，插件内唯一 |
| `title` | ✅ | 显示名，如"全屏录制" |
| `status` | ✅ | `running` / `done` / `error` |
| `progress` | 可选 | 0~100；不给则 UI 显示不确定进度 |
| `message` | 可选 | 当前进展文案 |
| `result` | 可选 | 产物路径等结果说明（完成时展示） |

两种上报方式，任选其一或都用：

- **返回值**：`plugin.handle_action` 的返回里带上 `job` 字段（见上面示例）；
- **事件**：`{"jsonrpc":"2.0","method":"event","params":{"type":"job","jobId":"…","status":"running","progress":42}}`
  （`_shared/jobs.py` 会自动发这种事件）。

### 宿主会为你做什么

- 任务登记后**绝不会被空闲回收**（存在 running 任务即跳过回收；每轮轮询还会续期保护窗口）；
- 进度随 `plugins:changed` 广播到 UI：侧边栏插件卡片显示标题、进度条与终态；
- `running → done/error` 时弹系统通知（含 `result`），不需要你再发 `show_notification`（发了会双通知）；
- 插件进程退出时，未完成的任务会被标记为 `error: 插件进程已退出，任务未完成`，用户看得到原因。

参考实现：`plugins/office-screenrecord-full|region|gif/main.py`（v1.1.0 起接入），
共享库：`plugins/_shared/jobs.py`。

## 生命周期与加载行为

写插件前先了解宿主怎么管进程，能省掉大量"为什么没跑起来"的困惑：

1. **按需拉起**：应用启动不会立刻拉起所有插件进程，只补侧边栏卡片；侧边栏卡片上点「启动插件」、
   或在插件管理点「加载」、或命令面板执行该插件命令时才会 `spawn`。
2. **加载 = 装依赖 → 拉进程 → `plugin.init` → （module）`plugin.get_ui` / （pet）`pet.get_actions`**。
   `init` 失败即视为加载失败（状态 `error:`）。
3. **空闲回收**：进程空闲超过 180 秒（宿主每 60 秒扫描一次）会被 kill 并标记「空闲回收（点击卡片自动重启）」，
   再点击卡片会重新走一遍加载流程（依赖已装则跳过）。
4. **并发上限**：同时最多 5 个 Python 子进程，排队等待时状态显示「等待并发槽位…」——
   所以一个极慢的 `plugin.init` 会拖慢其他插件的启动。
5. **聚合卡**：所有 module 插件共用侧边栏一张「插件」聚合卡（不再一插件一卡），默认沉底、可置顶。

## 贴图联动事件（T-04，v2.1 新增）

截图类插件可让主程序把结果“贴到桌面置顶”（可缩放/透明/关闭），无需自建窗口：

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "pin.capture", "path": "C:\\path\\shot.png"}}
```

`plugins/_shared/screen_capture.py` 提供 `save_temp_png(...)` 与 `request_pin(path)` 两个辅助函数，
四个内置截图插件的“截图并贴图”按钮即基于此实现。

## 发布到插件市场（PM-02 / PM-04）

1. 打包插件目录为 `zip`（根目录或单层子目录含 `manifest.json`），发布到 **HTTPS** 下载地址；
2. 在市场索引 `index.json` 的 `items` 中登记：

```json
{
  "id": "com.example.myplugin",
  "name": "我的插件",
  "version": "1.1.0",
  "author": "作者",
  "description": "描述",
  "category": "效率",
  "type": "module",
  "url": "https://example.com/releases/com.example.myplugin-1.1.0.zip",
  "sha256": "…zip 的 SHA256（必填，安装时强校验）…",
  "verified": false,
  "permissions": ["file", "network"]
}
```

> 索引条目里**没有** `commands` / `entry` 等字段——这些一律以 zip 包内 `manifest.json` 为准
> （命令同样来自包内 manifest，安装后自动进命令面板）。

3. 安装时主程序会：仅允许 HTTPS / `builtin://` / 本地 `file://` 源 → 校验 SHA256 → 弹出权限提示（未验证插件展示
   “社区未验证”标签）→ 解压并校验 `manifest.id` 与市场条目一致 → 写入 `%APPDATA%\xiaopeng-toolbox\plugins\`
   并自动加入信任来源（不再二次弹确认）→ 自动安装 `requirements.txt` 依赖并启用。
   索引地址在“设置 → 插件市场 → 数据源”配置（默认内置示例源 `builtin://index`）。

4. 也可以完全不手写索引：用「AI 造插件」向导生成插件后点「发布到市场源」，
   宿主会自动打包 `packages/<id>-v<version>.zip`、算好 SHA256 并更新/新建 `index.json`
   （`url` 写相对路径，上传到 HTTPS 托管后按索引地址自动解析）。
