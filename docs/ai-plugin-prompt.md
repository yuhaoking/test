# AI 插件生成 Prompt（给小白）

把下面「复制区」的内容**原样复制给任意 AI**（DeepSeek / ChatGPT / Kimi / 豆包 等），按提示操作即可生成一个能直接安装进「小鹏工具箱」的插件。

> ⚡ **更省事的方式**：应用内已内置「AI 造插件」向导（设置 → 插件市场 → AI 造插件）。填一句话需求即可，
> 它会把下面这套规范自动交给 DeepSeek，生成 `manifest.json` + `main.py`，并能预览、一键安装、一键发布到市场源——
> **用向导就不需要手动复制本文档**。本文档保留下来，方便你把规范贴给别的 AI，或对照检查生成结果。

## 使用步骤

1. 复制下方"复制区"全文 → 发给 AI；
2. 在 AI 回复末尾把你的需求填进 `【你的需求】`（如：做一个"显示今天还剩多少天过年"的插件）；
3. AI 会输出：`manifest.json`、`main.py`（如需依赖还有 `requirements.txt`、图标 `icon.png`）；
4. 新建文件夹 `我的插件`，把生成的文件放进去：
   ```
   我的插件/
   ├── manifest.json
   ├── main.py
   └── (可选) requirements.txt / icon.png
   ```
5. 打开 小鹏工具箱 → 设置 → 插件管理 → **安装插件…** → 选择「我的插件」文件夹；
6. 点「加载」，侧边栏出现插件卡片即成功（进入设置 → 插件市场 → AI 造插件 也可以直接生成安装）。

---

## 复制区（从这里开始复制）

```
你是一名资深 Python 开发者。请按以下规范为我编写一个「小鹏工具箱」的桌面工具插件。

【背景】
小鹏工具箱是一款 Electron 桌面应用，插件为 Python 3.10+ 独立子进程，
通过 JSON-RPC 2.0 over stdio 与主程序通信（标准输入/输出，每行一个 JSON 对象）。
模块插件（manifest 的 type=module）加载后会在应用侧边栏显示一张卡片，卡片显示插件提供的说明文字、
指标、输入框和按钮；点击按钮会调用插件的 plugin.handle_action，返回值 {message: "..."} 会被应用弹出提示。
type=pet 的宠物插件用于驱动桌面宠物（本次默认做 module 插件）。

【协议】
请求（主程序→插件，插件读到一行 JSON）：
{"jsonrpc":"2.0","id":1,"method":"plugin.init","params":{"config":{}}}
插件必须回复：
{"jsonrpc":"2.0","id":1,"result":{"status":"ok"},"error":null}
插件主动通知主程序（无 id 的 JSON 行）：
{"jsonrpc":"2.0","method":"event","params":{"type":"show_notification","message":"文字"}}
（event 的 type 只能用下面几种，文本字段名统一叫 message：
  show_notification {message, title?} 弹系统通知；
  pet_notify {message} 让桌宠气泡播报（开启语音后可朗读）；
  toggle_sidebar {} 呼出/收起侧边栏；
  pet.clicked {} 触发宠物播随机动作；
  pet.double_clicked {} 呼出/收起侧边栏；
  pin.capture {path} 把图片贴到桌面置顶）
（调用超时：plugin.init 15 秒 / plugin.get_ui 8 秒 / plugin.handle_action 600 秒 / plugin.handle_command 600 秒）
（长任务别硬等：如果一次动作要跑几十秒以上（下载、批量转换、录屏…），用下面的"后台任务"写法，
  否则用户看不到进展，插件也可能被当成空闲进程回收，产物会坏掉）

【必须实现的方法（第 4 项可选）】
1. plugin.init  → 返回 {"status":"ok","name":"插件名","version":"1.0.0"}
2. plugin.get_ui → 返回 UI 描述（见下）。注意它会被反复调用（卡片挂载、输入变化、有 metrics 时每 5 秒轮询一次），
   必须轻量、可重复调用、无副作用，每次返回完整的最新状态
3. plugin.handle_action → 入参 {"action":"按钮id","values":{"输入框id":"值"}}，返回 {"message":"提示文字"}
   也可以返回 {"metrics":[{...}]} 直接刷新指标区；返回 {"openUrl":"https://…"} 会用系统浏览器打开（仅 http/https/mailto）
4.（可选，推荐）plugin.handle_command → 入参 {"command":"命令id","text":"可选文本"}，返回 {"message":"结果"}。
   在 manifest 的 commands 里声明后，该命令会进入应用的全局命令面板（也可能被桌宠对话 / MCP 客户端调用）。
   注意 text 可能不存在，用之前必须先判空。
5.（长任务必读）后台任务：把耗时动作改成"立即返回 + 进度上报"，宿主会显示进度条、完成时弹通知，
   并且**在任务进行期间绝不回收进程**。最小写法（不需要任何额外依赖）：
   - handle_action 里起一个守护线程干活，立刻返回 {"message":"任务已开始","job":{"id":"job-1","title":"任务名","status":"running","progress":0}}；
   - 线程里用同一个 json 结构发事件上报进度：
     {"jsonrpc":"2.0","method":"event","params":{"type":"job","jobId":"job-1","title":"任务名","status":"running","progress":42,"message":"已完成 42%"}}
   - 结束时再发一次 status 为 "done"（带 result 产物路径）或 "error"（带 message 失败原因）。
   - 可选：实现 plugin.jobs → 返回 {"jobs":[ …与上面同结构的数组… ]}，宿主每 2 秒轮询一次；
     不实现也没关系（宿主会静默跳过，完全兼容）。
   - 完整示例与说明见 docs/plugin-development.md 的「后台任务协议」一节。

【UI 描述格式（plugin.get_ui 的返回值）】
{
  "text": "卡片说明文字（支持换行）",
  "inputs": [
    {"id":"seconds","label":"延迟(秒)","type":"number","default":"3"},
    {"id":"lang","label":"目标语言","type":"select","options":["zh-CN","en"],"default":"zh-CN"},
    {"id":"file","label":"文件路径","type":"picker","picker":"file","default":""},
    {"id":"dir","label":"保存目录","type":"picker","picker":"folder","default":""}
  ],
  "buttons": [{"id":"go","label":"开始"}],
  "metrics": [{"label":"状态","value":"就绪"}]
}
（inputs 的 type 可选：text 默认 / number / select(需 options) / picker(需 picker:file 或 folder，主程序提供文件选择器)；
  metrics 非空时卡片会每 5 秒重新调用 plugin.get_ui 刷新，适合显示余额、进度等动态信息）
用户点击按钮时，values 里会带上所有输入框的当前值（全部是字符串）。

【manifest.json 格式】
{
  "id": "com.myname.myplugin",
  "name": "插件显示名",
  "version": "1.0.0",
  "author": "我的名字",
  "description": "插件的一句话说明",
  "category": "工具",
  "type": "module",
  "entry": "main.py",
  "icon": "icon.png",
  "permissions": [],
  "commands": [{"id":"run","title":"执行一次","keywords":["run","zhixing"]}]
}
（id 必须是反向域名式小写标识，形如 com.myname.myplugin，会作为插件目录名；
  type 目前填 module；category 可选：截图/录屏/转换/翻译/工具 等；
  permissions 只能从这几个里如实挑选，不需要就填空数组：
    file 读写本地文件 / network 访问互联网 / clipboard 读写剪贴板 / screen 截图录屏 / process 启动外部程序；
  commands 可选，每项 {id, title, keywords?}，id 里不要带冒号；不需要命令面板就省略该字段）

【硬性约定】
1. 插件标准输出(stdout)【只能】输出 JSON 行，调试信息必须写到 stderr；
2. 每帧 JSON 必须换行结尾并 flush；
3. 文件必须 UTF-8 编码，中文字符不要转义（json.dumps 用 ensure_ascii=False）；
4. 入口必须加下面这段，否则插件被别的工具拉起（控制台是 GBK）时会因中文写不出去而报错：
   try:
       sys.stdout.reconfigure(encoding='utf-8')
   except Exception:
       pass
5. 【重要】所有第三方库的 import 必须写在"首次真正使用"它的函数里懒加载，绝不能放文件顶层：
   plugin.init 只有 15 秒，translators 这类库首次导入要联网 10~35 秒，顶层导入会让插件直接启动失败；
6. 整个处理过程用 try/except 包裹，任何异常都要返回 {"result":null,"error":"错误信息"}；
7. 耗时操作（网络、截图、循环>1秒）必须放到 threading.Thread 后台线程，
   立即返回 {"message":"进行中..."}，完成后用 event 的 show_notification 或 pet_notify 通知；
8. 文件读写必须标注 encoding='utf-8'；
9. 依赖第三方 pip 包时，额外输出 requirements.txt（每行一个包名），主程序会在插件加载前自动 pip 安装（超时 5 分钟）；
10. 文件/目录路径一律用 os.path.join，兼容 Windows 路径；用户输入的路径要做 strip('"')；
11. 插件保存文件时，默认目录取 os.environ.get('PLUGIN_SAVE_DIR')（可能为空字符串，为空时用
    os.path.expanduser('~/Documents') 或 os.path.expanduser('~/Pictures')），并允许用户通过
    picker 输入覆盖（values.get('dir')）；
12. 应用自带的嵌入式 Python 3.12 已包含 tkinter，需要图形界面（如区域框选）可以 import tkinter，
    同样要按第 5 条懒加载，不要放顶层。

【主程序 main.py 完整模板】直接按这个模板改造，不要改动框架：
import json
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '我的插件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '说明文字',
            'inputs': [{'id': 'q', 'label': '输入', 'type': 'text', 'default': ''}],
            'buttons': [{'id': 'go', 'label': '执行'}]
        }
    if method == 'plugin.handle_action':
        values = (params or {}).get('values') or {}
        # 在这里写你的功能（第三方库在这一步内部 import）
        return {'message': '结果提示文字'}
    if method == 'plugin.handle_command':
        # 命令面板触发；没有命令需求可以删掉这一段
        command = (params or {}).get('command')
        text = (params or {}).get('text') or ''
        return {'message': '命令 ' + str(command) + ' 执行完成' + ('：' + text if text else '')}
    return {'status': 'unknown-method'}

def main():
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

if __name__ == '__main__':
    main()

【输出要求】
只输出以下内容：
1. 完整 manifest.json 代码块
2. 完整 main.py 代码块（基于模板，实现我的功能）
3. （如需要）requirements.txt 代码块
4. 安装到小鹏工具箱的方法（放到文件夹 → 设置→插件管理→安装插件…）
5. 不要输出其它解释；代码行内不要写注释

【我的需求】
（在这里填写你想要的插件功能，例如：）
- 插件名称：
- 功能描述：
- 界面元素（输入什么、按钮做什么）：
- 输出/保存什么：
- 是否需要命令面板命令（默认不需要）：
```

## 复制区（到这里结束）

## 示例：已生成插件体验

内置示例插件「示例插件」位于仓库 `plugins/example-plugin/`，可按同样流程安装体验。

其他可直接对照的真实例子：

- `plugins/office-deepseek-monitor/`：`manifest.json` 声明 `commands` + `main.py` 实现 `plugin.handle_command`，
  并用 `metrics` 做 5 秒轮询、用 `pet_notify` 做桌宠播报；
- `plugins/office-translate-pro/`：`picker` 选文件/目录、后台线程 + `show_notification` 汇报结果，
  以及第三方库（`translators`）懒加载的标准写法；
- `resources/market/packages/com.example.command-tool/`：最小的命令插件示例。

## 常见问题

- **装好后点「加载」没反应 / 显示启动失败**：多数是顶层 `import` 了第三方库导致 `plugin.init` 超过 15 秒，
  或 `requirements.txt` 里的包没装成功（插件管理里能看到状态）。让 AI 按复制区「硬性约定」第 5 条改成懒加载即可。
- **卡片上看不到输入/按钮**：`plugin.get_ui` 的返回结构写错了，对照本文档的「UI 描述格式」检查字段名。
- **通知里没文字**：`event` 的文本字段必须叫 `message`（不是 `text` / `body`）。
- **命令面板搜不到命令**：插件要已启用，且 `manifest.json` 里有 `commands` 数组（`id` + `title`）。
