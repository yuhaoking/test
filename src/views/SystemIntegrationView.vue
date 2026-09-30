<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { showToast } from '../utils';
import type { Alias, HotkeyInfo, SelectionBarAction, UpdateState } from '../../shared/types';

/**
 * 系统集成中心（SY-02 / SY-03 / SY-04）：
 * 托盘常驻 / 开机自启 / 全局快捷键统一管理（冲突检测、注册状态、立即生效、一键重置）。
 */

const api = window.api;
const settings = useSettingsStore();
const s = computed(() => settings.settings);
const hotkeys = ref<HotkeyInfo[]>([]);
const drafts = ref<Record<string, string>>({});

async function refreshHotkeys(): Promise<void> {
  hotkeys.value = await api.hotkeys.list();
  for (const h of hotkeys.value) drafts.value[h.action] = h.accelerator;
}

async function setHotkey(h: HotkeyInfo): Promise<void> {
  try {
    hotkeys.value = await api.hotkeys.set(h.action, (drafts.value[h.action] ?? '').trim());
    await settings.load();
    showToast('快捷键已更新并立即生效');
  } catch (e) {
    showToast(String(e));
    await refreshHotkeys();
  }
}

async function resetAll(): Promise<void> {
  hotkeys.value = await api.hotkeys.reset();
  for (const h of hotkeys.value) drafts.value[h.action] = h.accelerator;
  await settings.load();
  showToast('所有快捷键已恢复默认');
}

async function toggleTray(): Promise<void> {
  await settings.update({ trayEnabled: !s.value.trayEnabled });
  showToast(s.value.trayEnabled ? '托盘常驻已启用' : '托盘已关闭（窗口全部关闭时退出应用）');
}

async function toggleCloseToTray(): Promise<void> {
  await settings.update({ closeToTray: !s.value.closeToTray });
  showToast(s.value.closeToTray ? '主窗口关闭将最小化到托盘' : '主窗口关闭将直接隐藏');
}

async function toggleAutostart(): Promise<void> {
  await settings.update({ autostart: !s.value.autostart });
  showToast(s.value.autostart ? '已加入开机自启' : '已取消开机自启');
}

async function exportBackup(): Promise<void> {
  try {
    const path = await api.backup.exportSettings();
    if (path) showToast(`设置备份已保存：${path}`);
  } catch (e) {
    showToast(String(e));
  }
}

async function importBackup(): Promise<void> {
  try {
    const imported = await api.backup.importSettings();
    if (imported) {
      await settings.load();
      showToast('设置已恢复并立即生效（热键/托盘/自启已重放）');
    }
  } catch (e) {
    showToast(String(e));
  }
}

async function exportDiag(): Promise<void> {
  try {
    const path = await api.backup.diag();
    if (path) showToast(`诊断包已保存（日志已脱敏）：${path}`);
  } catch (e) {
    showToast(String(e));
  }
}

const ACTION_HINT: Record<string, string> = {
  sidebar: '侧边栏',
  palette: '命令面板',
  deskboard: '工作台',
  clipboard: '剪贴板面板',
  capture: '截图',
  pin: '贴图'
};

function conflictLabel(h: HotkeyInfo): string {
  const target = hotkeys.value.find((x) => x.action === h.conflictWith);
  return target?.label ?? h.conflictWith ?? '';
}

// ---------- T-14（AL-01 ~ AL-03）：指令别名 ----------
const aliases = ref<Alias[]>([]);
const targets = ref<Array<{ id: string; label: string; type: string }>>([]);
const aliasDraft = ref<{ id: string; alias: string; targetId: string }>({ id: '', alias: '', targetId: '' });

const TARGET_LABEL: Record<string, string> = {
  function: '内部功能',
  plugin: '插件命令',
  website: '网站',
  snippet: '片段'
};

async function refreshAliases(): Promise<void> {
  try {
    aliases.value = await api.aliases.list();
    if (!targets.value.length) targets.value = await api.palette.targets();
  } catch (e) {
    showToast('别名读取失败：' + (e as Error).message);
  }
}

function editAlias(a: Alias): void {
  aliasDraft.value = { id: a.id, alias: a.alias, targetId: a.targetId };
}

function resetAliasDraft(): void {
  aliasDraft.value = { id: '', alias: '', targetId: '' };
}

async function saveAlias(): Promise<void> {
  const draft = aliasDraft.value;
  if (!draft.alias.trim()) {
    showToast('请填写别名');
    return;
  }
  if (!draft.targetId) {
    showToast('请选择别名指向的目标');
    return;
  }
  const target = targets.value.find((t) => t.id === draft.targetId);
  try {
    aliases.value = await api.aliases.save({
      id: draft.id,
      alias: draft.alias.trim(),
      targetId: draft.targetId,
      targetType: (target?.type ?? 'function') as Alias['targetType'],
      targetLabel: target?.label,
      createdAt: 0
    });
    showToast('别名已保存，输入「' + draft.alias.trim() + '」即可直达');
    resetAliasDraft();
  } catch (e) {
    showToast(String((e as Error).message ?? e));
  }
}

async function removeAlias(a: Alias): Promise<void> {
  if (!confirm('删除别名「' + a.alias + '」？')) return;
  aliases.value = await api.aliases.remove(a.id);
}

async function importAliases(): Promise<void> {
  const r = await api.aliases.importJson();
  aliases.value = r.list;
  showToast(r.ok ? (r.message ?? '别名已导入') : (r.message ?? '导入失败'));
}

async function exportAliases(): Promise<void> {
  const path = await api.aliases.exportJson();
  if (path) showToast('别名已导出：' + path);
}

// ---------- T-14（WK-07）：划词动作条配置 ----------
const barCatalog = ref<Array<{ id: string; label: string; icon: string; enabled: boolean; order: number }>>([]);

async function refreshBarCatalog(): Promise<void> {
  try {
    barCatalog.value = await api.deskboard.selectionCatalog();
  } catch {
    barCatalog.value = [];
  }
}

async function persistBar(next: Array<{ id: string; label: string; icon: string; enabled: boolean; order: number }>): Promise<void> {
  const list: SelectionBarAction[] = next
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((a, i) => ({ id: a.id, enabled: a.enabled, order: i }));
  await settings.update({ selectionBarActions: list });
  await refreshBarCatalog();
}

async function toggleBarAction(id: string): Promise<void> {
  const next = barCatalog.value.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a));
  await persistBar(next);
  showToast('划词动作条已更新（下次取词生效）');
}

async function moveBarAction(id: string, delta: number): Promise<void> {
  const sorted = barCatalog.value.slice().sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((a) => a.id === id);
  const swap = idx + delta;
  if (idx < 0 || swap < 0 || swap >= sorted.length) return;
  const tmp = sorted[idx].order;
  sorted[idx].order = sorted[swap].order;
  sorted[swap].order = tmp;
  await persistBar(sorted);
}

const enabledBarCount = computed(() => barCatalog.value.filter((a) => a.enabled).length);

// ---------- T-14（UPD-01）：检查更新 ----------
/** 内置占位仓库标识（与 electron/services/updateChecker.ts 的 DEFAULT_REPO 保持一致，仅用于提示文案） */
const DEFAULT_REPO_LABEL = 'xiaopeng/toolbox';
const updateStateInfo = ref<UpdateState | null>(null);
const checkingUpdate = ref(false);
let offUpdate: (() => void) | null = null;

async function refreshUpdate(): Promise<void> {
  try {
    updateStateInfo.value = await api.update.state();
  } catch {
    updateStateInfo.value = null;
  }
}

async function checkUpdate(): Promise<void> {
  checkingUpdate.value = true;
  try {
    updateStateInfo.value = await api.update.check(true);
    const s = updateStateInfo.value;
    showToast(s.hasUpdate ? '发现新版本 v' + s.latestVersion : s.error ? '检查失败（已静默记录日志）' : '已是最新版本');
  } finally {
    checkingUpdate.value = false;
  }
}

const updateFeedDraft = ref('');

async function applyUpdateFeed(): Promise<void> {
  await settings.update({ updateFeedUrl: updateFeedDraft.value.trim() });
  showToast('更新源已保存（留空 = 默认 GitHub Releases API）');
}

async function toggleUpdateCheck(): Promise<void> {
  await settings.update({ updateCheckEnabled: !s.value.updateCheckEnabled });
  showToast(s.value.updateCheckEnabled ? '已开启启动后检查更新' : '已关闭检查更新');
}

onMounted(() => {
  void refreshHotkeys();
  void refreshAliases();
  void refreshBarCatalog();
  void refreshUpdate();
  offUpdate = api.update.onState((st) => {
    updateStateInfo.value = st;
  });
  updateFeedDraft.value = s.value.updateFeedUrl ?? '';
});

onUnmounted(() => {
  offUpdate?.();
});
</script>

<template>
  <div class="set-stack">
    <!-- ① 托盘与开机自启 -->
    <section class="set-card">
      <h4>托盘常驻（SY-03）</h4>
      <p class="desc">托盘菜单可快速显示主窗口、开关收纳盒 / 剪贴板记录、切换开机自启、退出应用；双击托盘图标重新打开主窗口。</p>
      <div class="set-line">
        <div class="switch" :class="{ on: s.trayEnabled }" @click="void toggleTray()"></div>
        <span class="hint">启用托盘图标（关闭后窗口全部退出时应用随之退出）</span>
      </div>
      <div class="set-line tight">
        <div class="switch" :class="{ on: s.closeToTray }" @click="void toggleCloseToTray()"></div>
        <span class="hint">主窗口关闭时最小化到托盘（而不是退出）</span>
      </div>
      <div class="set-divider"></div>
      <h4 style="margin-top: 2px">开机自启动（SY-04）</h4>
      <p class="desc">与托盘菜单中的自启状态实时同步；登录系统后自动启动小鹏工具箱。</p>
      <div class="set-line tight">
        <div class="switch" :class="{ on: s.autostart }" @click="void toggleAutostart()"></div>
        <span class="hint">开机自动启动</span>
      </div>
    </section>

    <!-- ② 全局快捷键管理 -->
    <section class="set-card">
      <h4>全局快捷键管理（SY-02）</h4>
      <p class="desc">
        统一管理全部热键，修改立即生效并自动冲突检测（应用内重复分配 / 被系统占用会显示原因），支持单项重置与一键恢复默认。
        默认：侧边栏 Ctrl+Alt+X · 面板 Alt+Space · 工作台 Ctrl+Shift+D · 剪贴板 Ctrl+Shift+V · 截图 Ctrl+Alt+A · 贴图 F3。
      </p>
      <div class="hotkey-list">
        <div v-for="h in hotkeys" :key="h.action" class="hk-row">
          <span class="hk-label">{{ h.label }}<span class="tag">{{ ACTION_HINT[h.action] }}</span></span>
          <input v-model="drafts[h.action]" class="hk-input" :placeholder="h.defaultAccelerator" />
          <button class="btn small primary" @click="void setHotkey(h)">应用</button>
          <button class="btn small" title="恢复该项默认" @click="((drafts[h.action] = h.defaultAccelerator), void setHotkey(h))">
            重置
          </button>
          <span class="hk-status">
            <span v-if="h.conflictWith" class="err">⚠️ 与“{{ conflictLabel(h) }}”冲突</span>
            <span v-else-if="h.error" class="err">⚠️ {{ h.error }}</span>
            <span v-else-if="!h.enabled" class="hint">所属功能未启用</span>
            <span v-else-if="h.registered" class="ok">✓ 已生效</span>
            <span v-else class="hint">未注册</span>
          </span>
        </div>
      </div>
      <div class="set-line">
        <button class="btn small" @click="void resetAll()">全部恢复默认</button>
        <span class="hint">修改后立即生效，无需重启</span>
      </div>
    </section>

    <!-- ③ T-14：指令别名（AL-01 ~ AL-03） -->
    <section class="set-card">
      <h4>指令别名（AL-01 ~ AL-03）</h4>
      <p class="desc">
        给常用功能 / 插件命令 / 网站 / 片段设置短别名（如 <code>fy</code> = 中英互译）。命令面板中输入别名即可直达，
        <b>精确匹配优先于一切模糊匹配</b>；同名别名会被拒绝保存。
      </p>
      <div class="set-line">
        <input v-model="aliasDraft.alias" class="alias-input mono" placeholder="短别名，如 fy" />
        <select v-model="aliasDraft.targetId" class="alias-select">
          <option value="">选择指向的目标…</option>
          <optgroup v-for="(label, type) in TARGET_LABEL" :key="type" :label="label">
            <option v-for="t in targets.filter((x) => x.type === type)" :key="t.id" :value="t.id">
              {{ t.label }}
            </option>
          </optgroup>
        </select>
        <button class="btn small primary" @click="void saveAlias()">{{ aliasDraft.id ? '更新' : '添加' }}</button>
        <button v-if="aliasDraft.id" class="btn small" @click="resetAliasDraft()">取消编辑</button>
        <button class="btn small" @click="void importAliases()">导入…</button>
        <button class="btn small" @click="void exportAliases()">导出</button>
      </div>
      <div v-if="aliases.length" class="alias-list">
        <div v-for="a in aliases" :key="a.id" class="alias-row">
          <span class="alias-key mono">{{ a.alias }}</span>
          <span class="alias-arrow">→</span>
          <span class="alias-target">{{ a.targetLabel || a.targetId }}</span>
          <span class="tag">{{ TARGET_LABEL[a.targetType] ?? a.targetType }}</span>
          <span class="spacer"></span>
          <button class="btn small" @click="editAlias(a)">编辑</button>
          <button class="btn small" @click="void removeAlias(a)">删除</button>
        </div>
      </div>
      <p v-else class="hint">还没有别名。示例：别名 <code>fy</code> 指向「中英互译」插件命令。</p>
    </section>

    <!-- ④ T-14：划词动作条配置（WK-07） -->
    <section class="set-card">
      <h4>划词动作条（WK-07）</h4>
      <p class="desc">
        按划词翻译热键取词后，悬浮条上会显示这些动作（翻译 / 搜索 / 复制 / 大小写 / 去空白 / 朗读…），
        点击或按 Ctrl+数字 执行。当前启用 <b>{{ enabledBarCount }}</b> 个（建议 ≥ 6）。
      </p>
      <div class="alias-list">
        <div v-for="a in barCatalog.slice().sort((x, y) => x.order - y.order)" :key="a.id" class="alias-row">
          <div class="switch small" :class="{ on: a.enabled }" @click="void toggleBarAction(a.id)"></div>
          <span class="alias-target">{{ a.label }}</span>
          <span class="tag mono">{{ a.id }}</span>
          <span class="spacer"></span>
          <button class="btn small" @click="void moveBarAction(a.id, -1)">↑</button>
          <button class="btn small" @click="void moveBarAction(a.id, 1)">↓</button>
        </div>
      </div>
    </section>

    <!-- ⑤ T-14：检查更新（UPD-01） -->
    <section class="set-card">
      <h4>检查更新（UPD-01）</h4>
      <p class="desc">
        启动后检查 GitHub Releases 最新版本（≤1 次/天，失败静默写日志，<b>不自动下载安装</b>）；
        发现新版本会在系统通知与这里提示，可一键跳转下载页。
      </p>
      <div class="set-line">
        <div class="switch" :class="{ on: s.updateCheckEnabled }" @click="void toggleUpdateCheck()"></div>
        <span class="hint">启动后自动检查更新</span>
        <button class="btn small" :disabled="checkingUpdate" @click="void checkUpdate()">
          {{ checkingUpdate ? '检查中…' : '立即检查' }}
        </button>
        <button v-if="updateStateInfo?.hasUpdate" class="btn small primary" @click="void api.update.open()">
          前往下载 v{{ updateStateInfo.latestVersion }}
        </button>
      </div>
      <div class="set-line tight">
        <span class="hint">
          当前版本 v{{ updateStateInfo?.currentVersion ?? '—' }}
          <template v-if="updateStateInfo?.hasUpdate"> · 发现新版本 v{{ updateStateInfo.latestVersion }}（{{ updateStateInfo.releaseName || 'Release' }}）</template>
          <template v-else-if="updateStateInfo?.checkedAt"> · 上次检查：{{ new Date(updateStateInfo.checkedAt).toLocaleString('zh-CN') }}</template>
          <template v-else> · 尚未检查</template>
        </span>
      </div>
      <div class="set-line tight">
        <input
          v-model="updateFeedDraft"
          class="alias-select"
          placeholder="更新源：填 owner/repo 简写，或完整 Releases API 地址（如 https://api.github.com/repos/你/仓库/releases/latest）"
        />
        <button class="btn small" @click="void applyUpdateFeed()">保存更新源</button>
      </div>
      <p v-if="updateStateInfo?.placeholderFeed" class="warn-hint">
        ⚠️ 当前仍在使用<b>内置占位仓库</b>（{{ DEFAULT_REPO_LABEL }}），该地址不存在，检查结果永远为「失败」。
        请在上面填写真实仓库（支持 <code>owner/repo</code> 简写）后再点「立即检查」。
      </p>
      <p v-if="updateStateInfo?.error" class="hint">上次检查失败：{{ updateStateInfo.error }}（不影响使用）</p>
    </section>

    <!-- ⑥ 数据备份与诊断（T-11） -->
    <section class="set-card">
      <h4>数据备份与诊断（T-11）</h4>
      <p class="desc">
        设置一键导出 / 导入（JSON，含全部热键与开关，导入后立即生效）；诊断包导出环境信息与运行日志，
        密钥 / 邮箱 / 证照号 / 用户目录自动脱敏（spec 5.4），可安全发给他人排障。
      </p>
      <div class="set-line">
        <button class="btn small" @click="void exportBackup()">导出设置备份</button>
        <button class="btn small" @click="void importBackup()">导入恢复设置…</button>
        <button class="btn small" @click="void exportDiag()">导出诊断包（脱敏）</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hotkey-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin-top: 12px;
  background: var(--bg-solid);
}

.hk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hk-label {
  width: 176px;
  font-size: 12px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tag {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

.hk-input {
  width: 150px;
  font-family: Consolas, monospace;
  flex-shrink: 0;
}

.hk-status {
  flex: 1;
  min-width: 140px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.err {
  color: var(--danger);
}

.ok {
  color: var(--success);
}

.alias-input {
  width: 140px;
  font-family: Consolas, monospace;
}

.alias-select {
  flex: 1;
  min-width: 220px;
  max-width: 420px;
}

.alias-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin-top: 10px;
  background: var(--bg-solid);
}

.alias-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.alias-key {
  font-family: Consolas, monospace;
  color: var(--accent);
  min-width: 70px;
}

.alias-arrow {
  opacity: 0.5;
}

.alias-target {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.alias-row .spacer {
  flex: 1;
}

.warn-hint {
  font-size: 11px;
  line-height: 1.7;
  color: var(--warning, #f7b500);
  background: rgba(247, 181, 0, 0.1);
  border: 1px solid rgba(247, 181, 0, 0.3);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
  margin: 6px 0 0;
}

.switch.small {
  transform: scale(0.78);
}

code {
  font-family: Consolas, monospace;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 4px;
  padding: 0 4px;
}
</style>
