<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { jsonFormat, jsonMinify } from '../../shared/devtools/json';
import { explainTimeInput, parseTimeInput, timeKindLabel, formatLocal } from '../../shared/devtools/time';
import { base64Auto, urlAuto } from '../../shared/devtools/codec';
import { hashAll } from '../../shared/devtools/hash';
import { uuidBatch } from '../../shared/devtools/uuid';
import { radixConvert, RADIXES } from '../../shared/devtools/radix';
import { UNIT_FAMILIES, convertFamily, formatUnit } from '../../shared/devtools/unit';
import { cronNext, cronDescribe } from '../../shared/devtools/cron';
import { diffLines } from '../../shared/devtools/diff';
import { assessRegexRisk, regexTest, regexHighlight, REGEX_PRESETS } from '../../shared/devtools/regex';
import type { RegexResult } from '../../shared/devtools/regex';
import { qrEncode, qrDecodeRgba, qrSvgPath } from '../../shared/devtools/qrcode';

/**
 * 开发者工具百宝箱（DEV-01 ~ DEV-12 独立小面板）
 *
 * 全部能力来自 shared/devtools 纯函数（零依赖、无 IO），渲染层直接用；
 * 入口：命令面板输入 devtools / 各分类指令，或工作台固定动作。
 */

const api = window.api;
const TABS = ['regex', 'diff', 'qrcode', 'tools'] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABEL: Record<TabKey, string> = {
  regex: '正则测试',
  diff: '文本对比',
  qrcode: '二维码',
  tools: '编解码 / 哈希 / 进制 / 单位 / 时间 / cron'
};
const initial = (new URLSearchParams(location.search).get('tab') ?? 'regex') as TabKey;
const tab = ref<TabKey>(TABS.includes(initial) ? initial : 'regex');
const toast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function flash(text: string): void {
  toast.value = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = '';
  }, 2200);
}

async function copy(text: string): Promise<void> {
  if (!text) return;
  await api.clipboard.setText(text);
  flash('已复制到剪贴板');
}

// ---------- DEV-04 正则测试 ----------
const rxPattern = ref('[\\w.+-]+@[\\w-]+\\.[\\w.]+');
const rxFlags = ref('gi');
const rxInput = ref('联系 admin@example.com 或 support@test.cn');
/**
 * P2-11：正则放到 Worker 里跑并加超时，避免灾难性回溯冻住界面。
 * Worker 不可用（极少数环境）时退回同步执行，但会先给出风险提示。
 */
const rxResult = ref<RegexResult>({ ok: true, matches: [] });
const rxSegments = ref<Array<{ text: string; hit: boolean }>>([]);
const rxRunning = ref(false);
const rxTimeoutMsg = ref('');
const rxRisk = computed(() => assessRegexRisk(rxPattern.value));

const REGEX_TIMEOUT_MS = 1200;
let rxWorker: Worker | null = null;
let rxSeq = 0;
let rxTimer: ReturnType<typeof setTimeout> | null = null;

function ensureRxWorker(): Worker | null {
  if (rxWorker) return rxWorker;
  try {
    rxWorker = new Worker(new URL('../workers/regexWorker.ts', import.meta.url), { type: 'module' });
    rxWorker.onmessage = (e: MessageEvent<{ seq: number; result: RegexResult; segments: Array<{ text: string; hit: boolean }> }>) => {
      if (e.data.seq !== rxSeq) return;
      finishRx();
      rxResult.value = e.data.result;
      rxSegments.value = e.data.segments;
    };
    rxWorker.onerror = () => {
      // Worker 自身出错：终止并退回同步模式（不让面板一直转圈）
      killRxWorker();
      finishRx();
      runRegexSync();
    };
  } catch {
    rxWorker = null;
  }
  return rxWorker;
}

function killRxWorker(): void {
  if (rxWorker) {
    try {
      rxWorker.terminate();
    } catch {
      /* 忽略 */
    }
    rxWorker = null;
  }
}

function finishRx(): void {
  rxRunning.value = false;
  if (rxTimer) {
    clearTimeout(rxTimer);
    rxTimer = null;
  }
}

/** 同步兜底（Worker 不可用）：仍受 REGEX_MAX_INPUT 长度限制 */
function runRegexSync(): void {
  rxResult.value = regexTest(rxPattern.value, rxFlags.value, rxInput.value);
  rxSegments.value = rxResult.value.ok ? regexHighlight(rxPattern.value, rxFlags.value, rxInput.value) : [];
}

function runRegex(): void {
  rxTimeoutMsg.value = '';
  const seq = ++rxSeq;
  const worker = ensureRxWorker();
  finishRx();
  if (!worker) {
    runRegexSync();
    return;
  }
  rxRunning.value = true;
  worker.postMessage({ seq, pattern: rxPattern.value, flags: rxFlags.value, input: rxInput.value });
  rxTimer = setTimeout(() => {
    if (seq !== rxSeq) return;
    // 超时：强制终止 Worker（这一步才能真正打断指数级回溯），并给出可读原因
    killRxWorker();
    finishRx();
    rxResult.value = { ok: false, matches: [], message: '匹配超时：表达式在该文本上发生了灾难性回溯' };
    rxSegments.value = [];
    rxTimeoutMsg.value = '已中止本次匹配（界面保持可用）';
  }, REGEX_TIMEOUT_MS);
}

watch([rxPattern, rxFlags, rxInput], () => runRegex());

function applyPreset(name: string): void {
  const p = REGEX_PRESETS.find((x) => x.name === name);
  if (!p) return;
  rxPattern.value = p.pattern;
  rxFlags.value = p.flags;
  rxInput.value = p.sample;
}

// ---------- DEV-11 文本 diff ----------
const diffA = ref('小鹏工具箱\n桌面工作台\n命令面板');
const diffB = ref('小鹏工具箱\n开发者工具箱\n命令面板\n划词动作条');
const diffResult = computed(() => diffLines(diffA.value, diffB.value));

// ---------- DEV-09 二维码 ----------
const qrText = ref('https://github.com/xiaopeng/toolbox');
const qrEcc = ref<'L' | 'M' | 'Q' | 'H'>('M');
const qrResult = computed(() => qrEncode(qrText.value, qrEcc.value));
const qrPath = computed(() => (qrResult.value.ok ? qrSvgPath(qrResult.value.modules) : ''));
const qrDecoded = ref('');
const qrDecodeError = ref('');

async function decodeFromCanvas(source: HTMLImageElement, width: number, height: number): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  const r = qrDecodeRgba(data.data, width, height);
  if (r.ok) {
    qrDecoded.value = r.text;
    qrDecodeError.value = '';
    flash('识别成功');
  } else {
    qrDecoded.value = '';
    qrDecodeError.value = r.message;
  }
}

/** 从剪贴板历史里最近的一张图片识别（剪贴板图片已由 T-01 落库，无需额外权限） */
async function decodeFromClipboard(): Promise<void> {
  qrDecodeError.value = '';
  try {
    const list = await api.clipboard.list({ kind: 'image', limit: 1 });
    const first = list[0];
    if (!first) {
      qrDecodeError.value = '剪贴板历史里还没有图片（先复制一张二维码图片）';
      return;
    }
    const asset = await api.clipboard.image(first.id, true);
    if (!asset) {
      qrDecodeError.value = '图片读取失败';
      return;
    }
    const img = new Image();
    img.onload = () => void decodeFromCanvas(img, img.naturalWidth, img.naturalHeight);
    img.onerror = () => {
      qrDecodeError.value = '图片解码失败';
    };
    img.src = 'data:' + asset.mime + ';base64,' + asset.data;
  } catch (e) {
    qrDecodeError.value = '识别失败：' + (e as Error).message;
  }
}

function decodeFromFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    void decodeFromCanvas(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
const fileInput = ref<HTMLInputElement | null>(null);

// ---------- DEV-01/02/03/05/06/07/08/10 工具箱 ----------
const tool = ref<'json' | 'time' | 'codec' | 'hash' | 'radix' | 'unit' | 'cron'>('json');
const TOOL_LABEL: Record<typeof tool.value, string> = {
  json: 'JSON',
  time: '时间戳',
  codec: 'Base64 / URL',
  hash: '哈希',
  radix: '进制',
  unit: '单位',
  cron: 'cron'
};
const sample = ref('{"name":"小鹏工具箱","version":"1.0.0","features":["工作台","开发者工具"]}');

const jsonOut = computed(() => jsonFormat(sample.value));
const jsonMin = computed(() => jsonMinify(sample.value));
const timeOut = computed(() => parseTimeInput(sample.value));
const b64Out = computed(() => base64Auto(sample.value));
const urlOut = computed(() => urlAuto(sample.value));
const hashOut = computed(() => hashAll(sample.value));

const radixInput = ref('255');
const radixOut = computed(() => radixConvert(radixInput.value));

const unitFamily = ref(UNIT_FAMILIES[0].key as string);
const unitFrom = ref(UNIT_FAMILIES[0].units[2].key);
const unitValue = ref('1');
const unitOut = computed(() => convertFamily(Number(unitValue.value), unitFrom.value, unitFamily.value));

const cronExpr = ref('*/15 9-18 * * 1-5');
const cronOut = computed(() => cronNext(cronExpr.value, 5));
const cronDesc = computed(() => cronDescribe(cronExpr.value));

const uuidList = ref<string[]>(uuidBatch(4));

function onUnitFamily(): void {
  const fam = UNIT_FAMILIES.find((f) => f.key === unitFamily.value);
  if (fam) unitFrom.value = fam.base;
}

const currentVersion = ref('');
onMounted(async () => {
  runRegex();
  try {
    currentVersion.value = await api.settings.info().then((i) => i.version);
  } catch {
    /* 忽略 */
  }
});
</script>

<template>
  <div class="root">
    <header class="head">
      <span class="title"><Icon name="gear" :size="15" /> 开发者工具箱</span>
      <span class="muted ver">v{{ currentVersion }}</span>
      <span class="spacer"></span>
      <span v-if="toast" class="toast">{{ toast }}</span>
      <button class="icon-btn" title="关闭" @click="api.devtools.close()"><Icon name="close" :size="15" /></button>
    </header>

    <nav class="tabs">
      <button v-for="k in TABS" :key="k" class="tab" :class="{ on: tab === k }" @click="tab = k">
        {{ TAB_LABEL[k] }}
      </button>
    </nav>

    <main class="body">
      <!-- DEV-04：正则测试 -->
      <section v-if="tab === 'regex'" class="pane">
        <div class="row">
          <span class="label">常用预设</span>
          <button v-for="p in REGEX_PRESETS" :key="p.name" class="chip" @click="applyPreset(p.name)">{{ p.name }}</button>
        </div>
        <div class="row">
          <input v-model="rxPattern" class="grow mono" placeholder="正则表达式" />
          <input v-model="rxFlags" class="flags mono" placeholder="gi" />
          <span v-if="rxRunning" class="muted">匹配中…</span>
        </div>
        <p v-if="rxRisk.risky" class="warn-hint">
          ⚠️ 该表达式存在回溯风险：{{ rxRisk.reasons.join('；') }}。匹配在独立线程执行，超过
          {{ REGEX_TIMEOUT_MS }}ms 会被自动中止，界面不会卡死。
        </p>
        <p v-if="rxTimeoutMsg" class="warn-hint">{{ rxTimeoutMsg }}</p>
        <textarea v-model="rxInput" rows="6" placeholder="测试文本"></textarea>
        <div class="row space">
          <span class="muted">
            匹配 <b>{{ rxResult.ok ? rxResult.matches.length : 0 }}</b> 处<template v-if="rxResult.truncated">
              （已截断）</template
            ><template v-if="rxResult.inputTruncated">（文本过长已只取前 20000 字符）</template>
          </span>
          <button class="btn" @click="copy(rxPattern)">复制正则</button>
        </div>
        <div v-if="!rxResult.ok" class="error">{{ rxResult.message }}</div>
        <div v-else class="preview mono">
          <span v-for="(s, i) in rxSegments" :key="i" :class="{ hit: s.hit }">{{ s.text }}</span>
        </div>
        <div v-if="rxResult.ok && rxResult.matches.length" class="matches">
          <div v-for="(m, i) in rxResult.matches.slice(0, 50)" :key="i" class="match-row">
            <span class="idx">#{{ i + 1 }}</span>
            <span class="mono val">{{ m.value }}</span>
            <span class="muted">@{{ m.index }}</span>
            <span v-if="m.groups.length" class="muted">分组：{{ m.groups.join(' | ') }}</span>
          </div>
        </div>
      </section>

      <!-- DEV-11：文本 diff -->
      <section v-else-if="tab === 'diff'" class="pane">
        <div class="two">
          <textarea v-model="diffA" rows="10" placeholder="原文"></textarea>
          <textarea v-model="diffB" rows="10" placeholder="新文本"></textarea>
        </div>
        <div class="row space">
          <span class="muted">
            新增 <b class="add">{{ diffResult.added }}</b> 行 · 删除 <b class="del">{{ diffResult.removed }}</b> 行
            <template v-if="diffResult.truncated">（超长已截断到 2000 行）</template>
            <template v-if="diffResult.trailingNewlineDiffers"> · 两侧结尾换行不一致（\ No newline at end of file）</template>
          </span>
          <button class="btn" @click="copy(diffB)">复制右侧文本</button>
        </div>
        <div class="diff mono">
          <div v-for="(l, i) in diffResult.lines" :key="i" class="diff-line" :class="l.type">
            <span class="ln">{{ l.type === 'add' ? l.bLine : l.aLine || '' }}</span>
            <span class="sign">{{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }}</span>
            <span class="txt">{{ l.text }}</span>
          </div>
        </div>
      </section>

      <!-- DEV-09：二维码 -->
      <section v-else-if="tab === 'qrcode'" class="pane">
        <div class="qr-wrap">
          <div class="qr-box">
            <svg v-if="qrResult.ok" :viewBox="'0 0 ' + qrResult.size + ' ' + qrResult.size" class="qr-svg">
              <rect :width="qrResult.size" :height="qrResult.size" fill="#fff" />
              <path :d="qrPath" fill="#000" />
            </svg>
            <div v-else class="error">{{ qrResult.message }}</div>
          </div>
          <div class="qr-side">
            <textarea v-model="qrText" rows="4" placeholder="要生成二维码的文本 / 链接"></textarea>
            <div class="row">
              <span class="label">纠错等级</span>
              <button v-for="l in ['L', 'M', 'Q', 'H']" :key="l" class="chip" :class="{ on: qrEcc === l }" @click="qrEcc = l as 'L' | 'M' | 'Q' | 'H'">
                {{ l }}
              </button>
            </div>
            <div class="row">
              <span class="muted" v-if="qrResult.ok">版本 {{ qrResult.version }} · {{ qrResult.size }}×{{ qrResult.size }} 模块</span>
            </div>
            <div class="row">
              <button class="btn" :disabled="!qrResult.ok" @click="copy(qrText)">复制原文</button>
            </div>
            <div class="divider"></div>
            <div class="label">解码：识别二维码图片</div>
            <div class="row">
              <button class="btn small" @click="void decodeFromClipboard()">用剪贴板图片识别</button>
              <button class="btn small" @click="fileInput?.click()">选择图片…</button>
              <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="decodeFromFile" />
            </div>
            <div v-if="qrDecoded" class="row">
              <span class="mono decoded">{{ qrDecoded }}</span>
              <button class="btn small" @click="copy(qrDecoded)">复制</button>
            </div>
            <div v-if="qrDecodeError" class="error">{{ qrDecodeError }}</div>
          </div>
        </div>
      </section>

      <!-- DEV-01/02/03/05/06/07/08/10：工具箱 -->
      <section v-else class="pane">
        <div class="row">
          <button
            v-for="k in (['json', 'time', 'codec', 'hash', 'radix', 'unit', 'cron'] as const)"
            :key="k"
            class="chip"
            :class="{ on: tool === k }"
            @click="tool = k"
          >
            {{ TOOL_LABEL[k] }}
          </button>
          <span class="spacer"></span>
          <button class="btn small" @click="uuidList = uuidBatch(4)">生成 UUID ×4</button>
        </div>

        <div v-if="tool !== 'radix' && tool !== 'unit' && tool !== 'cron'" class="row">
          <textarea v-model="sample" rows="4" placeholder="输入内容"></textarea>
        </div>

        <div v-if="tool === 'json'" class="out">
          <template v-if="jsonOut.ok">
            <div class="row space">
              <span class="label">格式化（DEV-01）</span>
              <span>
                <button class="btn small" @click="copy(jsonOut.out)">复制</button>
                <button class="btn small" @click="copy(jsonMin.ok ? jsonMin.out : '')">复制压缩版</button>
              </span>
            </div>
            <pre class="mono">{{ jsonOut.out }}</pre>
          </template>
          <div v-else class="error">第 {{ jsonOut.line }} 行第 {{ jsonOut.column }} 列：{{ jsonOut.message }}</div>
        </div>

        <div v-else-if="tool === 'time'" class="out">
          <template v-if="timeOut">
            <div class="row space">
              <span class="label">识别为 {{ timeKindLabel(timeOut.kind) }}</span>
              <button class="btn small" @click="copy(timeOut.local)">复制本地时间</button>
            </div>
            <div class="kv"><span>本地时间</span><b class="mono">{{ timeOut.local }} ({{ timeOut.zone }})</b></div>
            <div class="kv"><span>ISO 8601</span><b class="mono">{{ timeOut.iso }}</b></div>
            <div class="kv"><span>相对现在</span><b>{{ timeOut.relative }}</b></div>
            <div class="kv"><span>秒级时间戳</span><b class="mono">{{ Math.floor(timeOut.epochMs / 1000) }}</b></div>
            <div class="kv"><span>毫秒时间戳</span><b class="mono">{{ timeOut.epochMs }}</b></div>
          </template>
          <div v-else class="error">
            {{ explainTimeInput(sample) ?? '无法识别为时间戳（10/13/16 位）或日期字符串' }}
          </div>
        </div>

        <div v-else-if="tool === 'codec'" class="out">
          <div class="row space">
            <span class="label">Base64（DEV-03，双向自动识别）</span>
            <button v-if="b64Out" class="btn small" @click="copy(b64Out.out)">
              复制{{ b64Out.mode === 'decode' ? '解码' : '编码' }}结果
            </button>
          </div>
          <pre class="mono">{{ b64Out ? b64Out.out : '—' }}</pre>
          <div class="row space">
            <span class="label">URL（DEV-03，双向自动识别）</span>
            <button v-if="urlOut" class="btn small" @click="copy(urlOut.out)">
              复制{{ urlOut.mode === 'decode' ? '解码' : '编码' }}结果
            </button>
          </div>
          <pre class="mono">{{ urlOut ? urlOut.out : '—' }}</pre>
        </div>

        <div v-else-if="tool === 'hash'" class="out">
          <div class="kv"><span>MD5</span><b class="mono">{{ hashOut.md5 }}</b><button class="btn small" @click="copy(hashOut.md5)">复制</button></div>
          <div class="kv"><span>SHA1</span><b class="mono">{{ hashOut.sha1 }}</b><button class="btn small" @click="copy(hashOut.sha1)">复制</button></div>
          <div class="kv"><span>SHA256</span><b class="mono">{{ hashOut.sha256 }}</b><button class="btn small" @click="copy(hashOut.sha256)">复制</button></div>
          <div class="divider"></div>
          <div class="label">UUID v4（DEV-06）</div>
          <div v-for="(u, i) in uuidList" :key="u" class="kv"><span>#{{ i + 1 }}</span><b class="mono">{{ u }}</b><button class="btn small" @click="copy(u)">复制</button></div>
        </div>

        <div v-else-if="tool === 'radix'" class="out">
          <div class="row">
            <input v-model="radixInput" class="grow mono" placeholder="输入数值（支持 0x / 0b / 0o 前缀）" />
          </div>
          <template v-if="radixOut.ok">
            <div v-for="r in RADIXES" :key="r" class="kv">
              <span>{{ r }} 进制</span><b class="mono">{{ radixOut.values[String(r) as '2' | '8' | '10' | '16'] }}</b>
              <button class="btn small" @click="copy(radixOut.values[String(r) as '2' | '8' | '10' | '16'])">复制</button>
            </div>
            <div class="muted">自动识别输入进制：{{ radixOut.from }}</div>
          </template>
          <div v-else class="error">{{ radixOut.message }}</div>
        </div>

        <div v-else-if="tool === 'unit'" class="out">
          <div class="row">
            <select v-model="unitFamily" class="grow" @change="onUnitFamily">
              <option v-for="f in UNIT_FAMILIES" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
            <input v-model="unitValue" class="num mono" />
            <select v-model="unitFrom" class="grow">
              <option v-for="u in UNIT_FAMILIES.find((f) => f.key === unitFamily)?.units ?? []" :key="u.key" :value="u.key">
                {{ u.label }}
              </option>
            </select>
          </div>
          <div v-for="u in UNIT_FAMILIES.find((f) => f.key === unitFamily)?.units ?? []" :key="u.key" class="kv">
            <span>{{ u.label }}</span>
            <b class="mono">{{ unitOut ? formatUnit(unitOut[u.key]) : '—' }}</b>
            <button class="btn small" @click="copy(unitOut ? String(unitOut[u.key]) : '')">复制</button>
          </div>
        </div>

        <div v-else class="out">
          <div class="row">
            <input v-model="cronExpr" class="grow mono" placeholder="cron 表达式（如 */15 9-18 * * 1-5）" />
            <button class="btn small" @click="copy(cronExpr)">复制</button>
          </div>
          <div class="label">语义：{{ cronDesc }}</div>
          <div v-if="cronOut.length" class="out">
            <div v-for="(d, i) in cronOut" :key="i" class="kv">
              <span>第 {{ i + 1 }} 次</span><b class="mono">{{ formatLocal(d.getTime()) }}</b>
              <button class="btn small" @click="copy(formatLocal(d.getTime()))">复制</button>
            </div>
          </div>
          <div v-else class="error">表达式无法解析或无未来触发时间</div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-solid, #14161c);
  color: var(--text, #e8eaf0);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--border, #2a2e3a);
}

.title {
  font-size: 15px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ver,
.muted {
  font-size: 11px;
  color: var(--text-dim, #8b93a7);
}

.spacer {
  flex: 1;
}

.toast {
  font-size: 12px;
  color: var(--success, #3ecf8e);
}

.icon-btn {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.icon-btn:hover {
  opacity: 1;
}

.tabs {
  display: flex;
  gap: 6px;
  padding: 10px 16px 0;
  flex-wrap: wrap;
}

.tab {
  border: 1px solid var(--border, #2a2e3a);
  background: transparent;
  color: inherit;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.tab.on {
  border-color: var(--accent, #5b8cff);
  color: var(--accent, #5b8cff);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
}

.pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.row.space {
  justify-content: space-between;
}

.label {
  font-size: 12px;
  color: var(--text-dim, #8b93a7);
}

.grow {
  flex: 1;
  min-width: 160px;
}

.flags {
  width: 64px;
}

.num {
  width: 110px;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
}

input,
textarea,
select {
  border-radius: 8px;
  border: 1px solid var(--border, #2a2e3a);
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  padding: 6px 9px;
  font-size: 12px;
  outline: none;
  width: 100%;
}

textarea {
  resize: vertical;
}

.chip {
  border: 1px solid var(--border, #2a2e3a);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}

.chip.on {
  border-color: var(--accent, #5b8cff);
  color: var(--accent, #5b8cff);
}

.btn {
  border: 1px solid var(--border, #2a2e3a);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.btn.small {
  padding: 3px 9px;
  font-size: 11px;
}

.btn:hover:not(:disabled) {
  border-color: var(--accent, #5b8cff);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.preview {
  border: 1px solid var(--border, #2a2e3a);
  border-radius: 8px;
  padding: 10px;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.7;
  max-height: 200px;
  overflow-y: auto;
}

.preview .hit {
  background: rgba(91, 140, 255, 0.35);
  border-radius: 3px;
}

.matches {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.match-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}

.idx {
  color: var(--text-dim, #8b93a7);
  flex-shrink: 0;
}

.val {
  color: var(--accent, #5b8cff);
}

.two {
  display: flex;
  gap: 10px;
}

.two textarea {
  flex: 1;
}

.diff {
  border: 1px solid var(--border, #2a2e3a);
  border-radius: 8px;
  overflow: hidden;
  max-height: 420px;
  overflow-y: auto;
}

.diff-line {
  display: flex;
  gap: 8px;
  padding: 2px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-line .ln {
  width: 34px;
  text-align: right;
  color: var(--text-dim, #8b93a7);
  flex-shrink: 0;
}

.diff-line .sign {
  width: 10px;
  flex-shrink: 0;
}

.diff-line.add {
  background: rgba(62, 207, 142, 0.16);
}

.diff-line.del {
  background: rgba(229, 72, 77, 0.16);
}

.add {
  color: var(--success, #3ecf8e);
}

.del {
  color: var(--danger, #e5484d);
}

.qr-wrap {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.qr-box {
  width: 260px;
  height: 260px;
  background: #fff;
  border-radius: 10px;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qr-svg {
  width: 100%;
  height: 100%;
}

.qr-side {
  flex: 1;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.decoded {
  flex: 1;
  word-break: break-all;
}

.hidden {
  display: none;
}

.out {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kv {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
}

.kv > span:first-child {
  width: 96px;
  color: var(--text-dim, #8b93a7);
  flex-shrink: 0;
}

.kv b {
  flex: 1;
  word-break: break-all;
  font-weight: 500;
}

pre {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, #2a2e3a);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow-y: auto;
}

.divider {
  height: 1px;
  background: var(--border, #2a2e3a);
  margin: 4px 0;
}

.error {
  color: var(--danger, #e5484d);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(229, 72, 77, 0.12);
}

.warn-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--warning, #f7b500);
  background: rgba(247, 181, 0, 0.1);
  border: 1px solid rgba(247, 181, 0, 0.3);
  border-radius: 7px;
  padding: 6px 9px;
}
</style>
