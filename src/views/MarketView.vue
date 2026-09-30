<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { useSettingsStore } from '../stores/settings';
import { showToast } from '../utils';
import PluginForgeView from './PluginForgeView.vue';
import { marketItemBlockedReason } from '../../shared/pluginPackage.ts';
import type { MarketItem, MarketState } from '../../shared/types';

/**
 * 插件市场（PM-01 ~ PM-04）：
 * 分类/搜索浏览、一键安装/更新/卸载、数据源可配置（HTTPS 索引 / 内置示例源）、
 * SHA256 校验 + 权限提示（主进程）+ “社区未验证”标签。
 * T-06：内置「AI 造插件」向导（生成 → 预览 → 安装 → 发布）。
 */

const api = window.api;
const settings = useSettingsStore();
const state = ref<MarketState | null>(null);
const loading = ref(false);
const acting = ref('');
const query = ref('');
const category = ref('全部');
const sourceDraft = ref('');
const showForge = ref(false);
/** SEC-004 / OPT-16：远程索引开关（默认关；打开需显式确认） */
const allowRemote = ref(false);

/** 该条目是否因安全策略不可安装（SEC-005：内置插件保留命名空间 / 非法版本号） */
function blocked(it: MarketItem): string | null {
  return marketItemBlockedReason(it);
}

const categories = computed(() => {
  const set = new Set<string>();
  for (const it of state.value?.items ?? []) if (it.category) set.add(it.category);
  return ['全部', ...Array.from(set)];
});

const filtered = computed<MarketItem[]>(() => {
  const q = query.value.trim().toLowerCase();
  return (state.value?.items ?? []).filter((it) => {
    if (category.value !== '全部' && it.category !== category.value) return false;
    if (!q) return true;
    return `${it.name} ${it.id} ${it.description ?? ''}`.toLowerCase().includes(q);
  });
});

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    state.value = await api.market.fetch();
  } catch (e) {
    showToast(String(e));
  } finally {
    loading.value = false;
  }
}

/**
 * 切换到远程索引（SEC-004 / OPT-16）。
 *
 * 远程索引要显式确认：索引条目的 verified 是**索引自报**的，没有签名也没有信任根，
 * 因此"换个索引地址"实际上等于"信任另一个发布者"，这个决定必须让用户自己看见并同意。
 */
async function applySource(): Promise<void> {
  const next = sourceDraft.value.trim() || 'builtin://index';
  const isRemote = !next.startsWith('builtin://');
  if (isRemote && !allowRemote.value) {
    showToast('请先勾选“允许远程索引”再保存（远程索引未经签名验证）');
    return;
  }
  if (isRemote) {
    const ok = confirm(
      '启用远程插件索引？\n\n' +
        '· 索引里的“verified / 官方验证”标签完全由索引发布者自报，本应用无法验证；\n' +
        '· 插件包仍需通过 SHA256 校验与安装确认，但索引本身可被篡改；\n' +
        '· 签名体系落地前，建议只使用你信任的索引。\n\n' +
        '确定继续？'
    );
    if (!ok) return;
  }
  await settings.update({
    marketIndexUrl: next,
    marketAllowRemoteIndex: isRemote ? true : false
  });
  showToast(isRemote ? '已启用远程索引（请自行确认来源可信）' : '已切回内置源');
  await refresh();
}

/** 关闭远程索引并立即切回内置源（一键回到安全默认） */
async function disableRemote(): Promise<void> {
  await settings.update({ marketIndexUrl: 'builtin://index', marketAllowRemoteIndex: false });
  sourceDraft.value = 'builtin://index';
  showToast('已关闭远程索引，使用内置源');
  await refresh();
}

async function install(it: MarketItem): Promise<void> {
  acting.value = it.id;
  try {
    state.value = await api.market.install(it.id);
    showToast(`插件“${it.name}”安装成功，其命令已进入全局命令面板`);
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

async function upgrade(it: MarketItem): Promise<void> {
  acting.value = it.id;
  try {
    state.value = await api.market.upgrade(it.id);
    showToast(`插件“${it.name}”已更新到 v${it.version}`);
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

async function uninstall(it: MarketItem): Promise<void> {
  if (!confirm(`确定卸载插件“${it.name}”？其目录将被删除。`)) return;
  acting.value = it.id;
  try {
    state.value = await api.market.uninstall(it.id);
    showToast(`插件“${it.name}”已卸载`);
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

function permLabel(p: string): string {
  const map: Record<string, string> = {
    file: '文件',
    network: '网络',
    clipboard: '剪贴板',
    screen: '屏幕',
    process: '进程'
  };
  return map[p] ?? p;
}

// UI-2 修复：数据源草稿跟随 store 回填（store.load 为异步 IPC，避免用默认值覆盖用户配置）
watch(
  () => settings.settings.marketIndexUrl,
  (v) => {
    sourceDraft.value = v;
  },
  { immediate: true }
);

watch(
  () => settings.settings.marketAllowRemoteIndex,
  (v) => {
    allowRemote.value = v === true;
  },
  { immediate: true }
);

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="set-stack">
    <!-- ⓪ AI 造插件向导（T-06） -->
    <section class="set-card">
      <h4>
        AI 造插件（T-06）
        <button class="btn small" style="float: right" @click="showForge = !showForge">
          {{ showForge ? '收起向导' : '✨ 打开向导' }}
        </button>
      </h4>
      <PluginForgeView v-if="showForge" />
      <p v-else class="desc">一句话需求 → AI 生成插件 → 预览 → 一键安装 / 发布到市场：零代码 5 分钟拿到可用插件。</p>
    </section>

    <!-- ① 数据源 -->
    <section class="set-card">
      <h4>数据源（PM-04 · SEC-004）</h4>
      <p class="desc">
        默认只使用<b>内置源</b>（builtin://index）。安装包经 SHA256 强校验 + 权限提示后才会写入。
      </p>
      <p class="warn">
        ⚠️ 远程索引默认关闭：索引里的「验证」标签由索引发布者自报，<b>没有签名、也无法被本应用验证</b>。
        签名体系落地前，请只在完全信任索引来源时才启用。
      </p>
      <div class="set-line">
        <label class="set-field-label">市场索引</label>
        <input
          v-model="sourceDraft"
          placeholder="builtin://index 或 https://…/index.json（仅 HTTPS）"
          style="flex: 1; min-width: 240px"
        />
        <button class="btn small" @click="void applySource()">保存并刷新</button>
      </div>
      <div class="set-line tight">
        <label class="set-field-label">允许远程索引</label>
        <input v-model="allowRemote" type="checkbox" />
        <span class="hint">勾选后才允许保存非 builtin:// 的索引地址（默认关闭，安全默认）</span>
        <span class="spacer"></span>
        <button
          v-if="settings.settings.marketAllowRemoteIndex || !(state?.source ?? '').startsWith('builtin://')"
          class="btn small"
          @click="void disableRemote()"
        >
          关闭远程索引
        </button>
      </div>
      <div class="set-line tight">
        <span class="hint">当前源：{{ state?.source ?? '加载中…' }}</span>
      </div>
      <p v-if="state?.error" class="warn">⚠️ {{ state.error }}</p>
    </section>

    <!-- ② 插件列表 -->
    <section class="set-card">
      <h4>插件列表（PM-01 ~ PM-02）</h4>
      <p class="desc">一键安装 / 更新 / 卸载；安装时自动解析 requirements.txt 安装依赖，插件命令直接注册进全局命令面板。</p>
      <div class="set-line">
        <input v-model="query" placeholder="搜索插件名称 / 描述…" style="flex: 1; min-width: 200px" />
        <select v-model="category" style="width: 130px">
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
        <button class="btn small" :disabled="loading" @click="void refresh()"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>

      <div class="items">
        <div v-for="it in filtered" :key="it.id" class="item">
          <div class="item-meta">
            <div class="item-name">
              {{ it.name }}
              <span v-if="it.category" class="tag cat">{{ it.category }}</span>
              <span class="tag">{{ it.type === 'pet' ? '宠物插件' : '模块插件' }}</span>
              <!--
                SEC-004 / OPT-16：不再写"官方验证"。
                verified 字段是**索引自报**的，没有签名也没有信任根，说成"官方"属于无背书承诺。
                这里只如实描述字段本身的来源，把判断权交回用户。
              -->
              <span v-if="it.verified" class="tag" title="该标记来自市场索引的自报字段，本应用无法验证其真实性">索引自报验证</span>
              <span v-else class="tag warn-tag">社区未验证</span>
              <span v-if="blocked(it)" class="tag warn-tag" :title="blocked(it) ?? ''">不可安装：{{ blocked(it) }}</span>
              <span v-if="state?.updatable.includes(it.id)" class="tag upd">可更新</span>
            </div>
            <div class="hint item-sub">
              v{{ it.version }} · {{ it.author || '未知作者' }}
              <template v-if="it.downloads != null"> · {{ it.downloads }} 次下载</template>
              <template v-if="state?.installed[it.id]"> · 已安装 v{{ state.installed[it.id] }}</template>
            </div>
            <div v-if="it.description" class="hint item-sub desc-text">{{ it.description }}</div>
            <div v-if="it.permissions?.length" class="hint item-sub">权限：{{ it.permissions.map(permLabel).join(' / ') }}</div>
          </div>
          <div class="item-actions">
            <button
              v-if="!state?.installed[it.id]"
              class="btn small primary"
              :disabled="acting === it.id || Boolean(blocked(it))"
              :title="blocked(it) ?? ''"
              @click="void install(it)"
            >
              {{ blocked(it) ? '不可安装' : '安装' }}
            </button>
            <button
              v-if="state?.updatable.includes(it.id)"
              class="btn small primary"
              :disabled="acting === it.id"
              @click="void upgrade(it)"
            >
              更新
            </button>
            <button
              v-if="state?.installed[it.id]"
              class="btn small danger"
              :disabled="acting === it.id"
              @click="void uninstall(it)"
            >
              卸载
            </button>
          </div>
        </div>
        <div v-if="!filtered.length && !loading" class="empty">没有匹配的插件</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  background: var(--bg-solid);
}

.item-meta {
  flex: 1;
  min-width: 0;
}

.item-name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  line-height: 1.5;
}

.item-sub {
  margin-top: 3px;
}

.desc-text {
  line-height: 1.6;
}

.tag {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

.tag.cat {
  color: var(--accent);
  border-color: var(--accent);
}

.tag.ok {
  color: var(--success);
  border-color: var(--success);
}

.tag.warn-tag {
  color: var(--danger);
  border-color: var(--danger);
}

.tag.upd {
  color: var(--accent);
  border-color: var(--accent);
}

.item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.warn {
  color: var(--danger);
  font-size: 12px;
  margin-top: 10px;
}
</style>
