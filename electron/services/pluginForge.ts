import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { dialog } from 'electron';
import { dataStore, userDataDir } from '../store/dataStore';
import { callDeepSeek, type LlmMsg } from './llm';
import { listPlugins, loadPlugin, unloadPlugin } from './pluginManager';
import { logWarn } from '../utils/log';
import type { ForgeResult, MarketIndex, MarketItem, PluginManifest } from '../../shared/types';

/**
 * AI 造插件向导（T-06「人人可造插件」产品化）
 *
 * 一句话需求 → DeepSeek 生成 插件（manifest + main.py…）→ 预览 → 一键安装 → 发布到市场源：
 * - 生成提示词工程固化自 `docs/ai-plugin-prompt.md`（协议/manifest/硬性约定），
 *   并要求模型输出严格 JSON（manifest + files + notes），主进程校验后落盘；
 * - 安装 = 写入 userData/plugins/<id> 并加载（依赖自动 pip，复用插件管理器机制）；
 * - 发布 = 生成 zip 包 + SHA256 + 更新市场源目录 index.json（相对路径条目，可直接上传 HTTPS 托管）。
 */

/** 生成提示词（源自 docs/ai-plugin-prompt.md，面向模型裁剪 + JSON 输出契约） */
const FORGE_SYSTEM_PROMPT = `你是一名资深 Python 开发者。请按以下规范为「小鹏工具箱」桌面工具插件生成完整代码。

【背景】
小鹏工具箱是 Electron 桌面应用，插件为 Python 3.10+ 独立子进程，通过 JSON-RPC 2.0 over stdio 与主程序通信（每行一个 JSON 对象）。
模块插件（type=module）在侧边栏显示卡片（文本/输入框/按钮/metrics）；宠物插件（type=pet）驱动桌面宠物。

【协议】
请求（主程序→插件）：{"jsonrpc":"2.0","id":1,"method":"plugin.init","params":{"config":{}}}
回复：{"jsonrpc":"2.0","id":1,"result":{"status":"ok"},"error":null}
主动通知（无 id）：{"jsonrpc":"2.0","method":"event","params":{"type":"show_notification","message":"文字"}}
event.type 支持：show_notification 系统通知 / pet_notify 宠物气泡播报 / toggle_sidebar 开关侧边栏 / pet.clicked / pet.double_clicked / pin.capture(path=截图路径，贴到桌面)

【必须实现的方法】
1. plugin.init → {"status":"ok","name":"插件名","version":"1.0.0"}
2. plugin.get_ui → {"text":"卡片说明","inputs":[…],"buttons":[{"id":"go","label":"开始"}],"metrics":[{"label":"x","value":"y"}]}
   inputs.type：text / number / select(options) / picker(picker=folder 时主程序提供目录选择器)
3. plugin.handle_action → 入参 {"action":"按钮id","values":{…}}，返回 {"message":"提示文字"}
4.（可选）plugin.handle_command → 入参 {"command":"命令id","text":"可选文本"}，返回 {"message":"结果"}；在 manifest.commands 声明后进入全局命令面板

【manifest.json】
{"id":"com.myname.myplugin","name":"插件显示名","version":"1.0.0","author":"作者","description":"一句话说明","category":"工具","type":"module","entry":"main.py","icon":"icon.png","permissions":[],"commands":[{"id":"cmd1","title":"命令标题"}]}
permissions 可选：file / network / clipboard / screen / process（如实声明，不要夸大）。

【硬性约定】
1. stdout 只输出 JSON 行，调试信息写 stderr；每行 JSON 换行结尾并 flush；
2. UTF-8 编码，中文不转义（json.dumps(..., ensure_ascii=False)）；
3. 单文件尽量自包含；确需第三方库时提供 requirements.txt（pip 自动安装）；
4. 不删除/不移动用户文件；写文件只写到用户指定目录或系统临时目录；
5. 入口必须有 if __name__ == '__main__' 主循环（读 stdin 逐行处理）。

【输出格式（严格遵守）】
只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），结构：
{
  "manifest": { ...完整 manifest.json 内容... },
  "files": { "main.py": "完整文件内容", "requirements.txt": "可选" },
  "notes": "给用户的 1~3 句使用说明"
}`;

function parseForgeJson(raw: string): ForgeResult {
  let text = raw.trim();
  // 剥掉可能的 ```json 围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 结果，请重试或换种说法');
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    manifest?: Partial<PluginManifest>;
    files?: Record<string, string>;
    notes?: string;
  };
  const m = parsed.manifest ?? {};
  if (!m.id || !m.name) throw new Error('生成结果缺少 manifest.id / manifest.name');
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(String(m.id))) {
    throw new Error(`manifest.id 不合法（应形如 com.myname.myplugin）：${String(m.id)}`);
  }
  const manifest: PluginManifest = {
    id: String(m.id),
    name: String(m.name),
    version: String(m.version || '1.0.0'),
    author: m.author ? String(m.author) : 'AI 造插件',
    description: m.description ? String(m.description) : '',
    category: m.category ? String(m.category) : '工具',
    type: m.type === 'pet' ? 'pet' : 'module',
    entry: String(m.entry || 'main.py'),
    permissions: Array.isArray(m.permissions) ? m.permissions.map(String) : [],
    commands: Array.isArray(m.commands)
      ? m.commands.map((c) => ({ id: String(c.id), title: String(c.title ?? c.id), keywords: c.keywords?.map(String) }))
      : undefined
  };
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(parsed.files ?? {})) {
    // 文件名防穿越：仅允许相对文件名
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new Error(`生成结果包含非法文件名：${name}`);
    }
    files[name] = String(content);
  }
  if (!files[manifest.entry]) {
    const py = Object.entries(files).find(([n]) => n.endsWith('.py'));
    if (py) manifest.entry = py[0];
    else throw new Error('生成结果没有 Python 入口文件');
  }
  return { manifest, files, notes: parsed.notes ? String(parsed.notes) : undefined };
}

/** T-06：一句话需求 → AI 生成插件（manifest + 源码），返回可预览的生成物 */
export async function generatePlugin(prompt: string): Promise<ForgeResult> {
  const key = (dataStore().get().settings.deepseekApiKey ?? '').trim();
  if (!key) throw new Error('请先在 设置 → 通用 填入 DeepSeek API Key');
  const requirement = String(prompt ?? '').trim();
  if (!requirement) throw new Error('请先描述你的插件需求（一句话即可）');
  const msgs: LlmMsg[] = [
    { role: 'system', content: FORGE_SYSTEM_PROMPT },
    { role: 'user', content: `【你的需求】${requirement}` }
  ];
  const reply = await callDeepSeek(key, msgs, undefined, 8192);
  const content = (reply.content ?? '').trim();
  if (!content) throw new Error('模型返回为空，请重试');
  try {
    return parseForgeJson(content);
  } catch (e) {
    logWarn('[forge] 生成结果解析失败', e);
    throw new Error(`生成结果无法解析：${(e as Error).message}`);
  }
}

function sanitizeFiles(result: ForgeResult): Array<{ name: string; content: string }> {
  return Object.entries(result.files).map(([name, content]) => {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new Error(`非法文件名：${name}`);
    }
    return { name, content };
  });
}

/** 插件 id 白名单（SEC-1）：反向域名式小写标识 */
const PLUGIN_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

function assertPluginId(id: string): void {
  if (!PLUGIN_ID_RE.test(String(id ?? ''))) throw new Error(`插件标识不合法：${id}`);
}

/** 安全解析插件目录：校验 id 格式并断言解析后仍位于插件根内（防路径穿越，SEC-1） */
function pluginDirOf(id: string): string {
  assertPluginId(id);
  const root = join(userDataDir(), 'plugins');
  const target = resolve(root, id);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error('插件标识非法（路径穿越已拦截）');
  }
  return target;
}

/**
 * 入口 / 图标等"包内相对文件名"白名单（P2-23）。
 *
 * 此前只校验了 manifest.id，entry 原样写进 manifest.json —— 渲染层可以提交
 * `entry: '..\\..\\evil.py'`，后续加载时 pluginManager 会直接 spawn 插件目录之外的脚本。
 * 这里要求：非空、不含路径分隔符、不含 '..'、不以点开头（隐藏文件）、长度受限。
 */
function safeRelativeFileName(value: string, label: string): string {
  const s = String(value ?? '').trim();
  if (!s || s.length > 64) throw new Error(`${label}不合法：${value}`);
  if (/[\\/]/.test(s) || s.includes('..') || s.startsWith('.')) {
    throw new Error(`${label}不合法（不允许路径分隔符 / 上级目录 / 隐藏文件）：${value}`);
  }
  return s;
}

/** 版本号白名单：仅允许常见版本字符，防止被用作路径片段 */
function safeVersion(v: string): string {
  const s = String(v ?? '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-+]{0,31}$/.test(s)) throw new Error(`版本号不合法：${v}`);
  return s;
}

/** T-06：一键安装生成物（写入插件目录 → 自动加载，requirements.txt 依赖自动 pip） */
export async function installGenerated(result: ForgeResult): Promise<void> {
  const { manifest } = result;
  // SEC-1 修复：安装入口不可信任渲染层传入的 id（此前仅生成路径校验，安装路径直接拼目录 → 可穿越删目录/写文件）
  assertPluginId(manifest.id);
  const version = safeVersion(manifest.version);
  // P2-23：入口与图标必须是包内裸文件名，且入口必须真实存在于本次生成的文件里
  manifest.entry = safeRelativeFileName(manifest.entry || 'main.py', '插件入口');
  if (manifest.icon) manifest.icon = safeRelativeFileName(manifest.icon, '插件图标');
  const files = sanitizeFiles(result);
  if (!files.some((f) => f.name === manifest.entry)) {
    throw new Error(`插件入口 ${manifest.entry} 不在生成的文件中，已拒绝安装`);
  }
  const existing = listPlugins().find((p) => p.id === manifest.id);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [existing ? '覆盖安装' : '安装', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: 'AI 造插件 - 安装确认',
    message: `${existing ? '覆盖安装' : '安装'}插件“${manifest.name}” v${version}？`,
    detail: [
      `标识：${manifest.id}`,
      `类型：${manifest.type === 'pet' ? '宠物插件' : '模块插件'}`,
      `文件：${files.map((f) => f.name).join('、')}`,
      manifest.permissions?.length ? `权限：${manifest.permissions.join('、')}` : '权限：无特殊权限',
      result.notes ? `说明：${result.notes}` : '',
      '',
      '安装后将运行本地代码；如有 requirements.txt 会自动安装依赖。'
    ]
      .filter(Boolean)
      .join('\n')
  });
  if (response !== 0) return;
  if (existing) await unloadPlugin(manifest.id);
  const target = pluginDirOf(manifest.id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  for (const f of files) {
    if (f.name === 'manifest.json') continue;
    writeFileSync(join(target, f.name), f.content, 'utf-8');
  }
  // 用户已在预览中审阅生成代码：标记信任，加载不再二次弹窗
  const s = dataStore().get().settings;
  if (!s.trustedSources.includes(manifest.id)) {
    dataStore().updateSettingsTrusted({ trustedSources: [...s.trustedSources, manifest.id] });
  }
  await loadPlugin(manifest.id);
}

function zipDir(srcDir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Compress-Archive -Path '${(srcDir + '\\*').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
      ],
      { windowsHide: true, timeout: 120_000 },
      (err) => (err ? reject(new Error(`打包失败：${err.message}`)) : resolve())
    );
  });
}

const PUBLISH_README = `# 小鹏工具箱 · 自建插件市场源

这个目录是一个可直接托管的插件市场源：

- index.json      市场索引（安装包 url 为相对路径，托管后自动按索引地址解析）
- packages/*.zip  插件安装包（SHA256 已写入索引，安装端强校验）

## 发布步骤
1. 把整个目录上传到任意 HTTPS 静态托管（Gitee Pages / GitHub Pages / OSS / 自建 Nginx）；
2. 在 小鹏工具箱 → 设置 → 插件市场 → 数据源 填入 https://你的域名/.../index.json；
3. 刷新市场列表即可看到你的插件，其他用户一键安装（SHA256 校验 + 权限提示）。

本地自用/联调：数据源也可以填 file:///该目录/index.json（仅建议自建可信目录）。
`;

/** T-06：一键发布到插件市场源（生成 zip + SHA256 + 更新 index.json，接 T-02） */
export async function publishGenerated(result: ForgeResult): Promise<string | null> {
  const { manifest } = result;
  // SEC-1 修复：发布同样校验 id/版本（此前可借 ..\ 逃出所选目录）
  assertPluginId(manifest.id);
  const version = safeVersion(manifest.version);
  const files = sanitizeFiles(result);
  const picked = await dialog.showOpenDialog({
    title: '选择插件市场源目录（index.json 所在目录，可新建）',
    properties: ['openDirectory', 'createDirectory']
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const root = picked.filePaths[0];

  // 1) 暂存生成物
  const stage = join(root, `.staging-${manifest.id}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  for (const f of files) {
    if (f.name === 'manifest.json') continue;
    writeFileSync(join(stage, f.name), f.content, 'utf-8');
  }

  // 2) 打包 + SHA256
  mkdirSync(join(root, 'packages'), { recursive: true });
  const zipName = `${manifest.id}-v${version}.zip`;
  const zipPath = join(root, 'packages', zipName);
  rmSync(zipPath, { force: true });
  await zipDir(stage, zipPath);
  rmSync(stage, { recursive: true, force: true });
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');

  // 3) 更新 index.json（同 id 覆盖旧版本）
  const indexFile = join(root, 'index.json');
  let index: MarketIndex = { version: 1, items: [] };
  if (existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, 'utf-8')) as MarketIndex;
      if (!Array.isArray(index.items)) index.items = [];
    } catch {
      index = { version: 1, items: [] };
    }
  }
  const item: MarketItem = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    category: manifest.category,
    type: manifest.type,
    url: `packages/${zipName}`,
    sha256,
    verified: false,
    downloads: 0,
    updatedAt: new Date().toISOString(),
    permissions: manifest.permissions
  };
  index.items = [...index.items.filter((it) => it.id !== manifest.id), item];
  index.generatedAt = new Date().toISOString();
  writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8');
  writeFileSync(join(root, '发布说明.txt'), PUBLISH_README, 'utf-8');
  return root;
}
