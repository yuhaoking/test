import { app, BrowserWindow, Notification, shell } from 'electron';
import { get } from 'https';
import { dataStore } from '../store/dataStore';
import { logDebug, logWarn } from '../utils/log';
import type { UpdateState } from '../../shared/types';

/**
 * 检查更新（UPD-01，轻量版）
 *
 * - 数据源：GitHub Releases latest（repo 由 package.json homepage 推导，可在设置中覆盖 updateFeedUrl）；
 * - 频率 ≤ 1 次/天（force=true 可手动强制检查）；
 * - 发现新版本：托盘气泡/系统通知 + 设置页横幅，点击跳转 Release 页；
 * - 任何失败静默写日志，不影响主流程；**不自动下载安装**（非目标，见 PRD §非目标）。
 */

/**
 * 内置默认仓库（package.json homepage 的 owner/repo）。
 *
 * P1-2 说明：这仍是占位仓库（仓库定名/迁移见 tasks.md T-13 品牌风险），请求会返回 404。
 * 因此这里把"默认源不可用"变成**用户可见但不打扰**的状态：
 *  · 检查失败依旧静默（不弹窗、不影响主流程）；
 *  · 设置页会明确显示"当前使用内置占位仓库，请填写真实仓库"；
 *  · updateFeedUrl 支持 `owner/repo` 简写，用户填一次就能永久生效。
 */
const DEFAULT_REPO = 'xiaopeng/toolbox';
const DEFAULT_FEED = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`;
/** 定时检查延迟（启动后 30 秒，避开启动高峰） */
const START_DELAY_MS = 30_000;
/** 检查间隔：1 天 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 该地址是否为内置占位源（设置页据此提示用户填写真实仓库） */
export function isPlaceholderFeed(): boolean {
  return feedUrl() === DEFAULT_FEED;
}

interface LatestRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  message?: string;
}

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0（忽略 v 前缀与预发布后缀） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((x) => Number.parseInt(x, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi > yi) return 1;
    if (xi < yi) return -1;
  }
  return 0;
}

/**
 * 解析更新源地址（P1-2 / SPC §7「updateChecker 仅 HTTPS」）
 *
 * 支持三种写法，统一归一化为 Releases API 地址：
 *  · `owner/repo`           → https://api.github.com/repos/owner/repo/releases/latest
 *  · `https://…`（完整 API）→ 原样使用
 *  · 空 / 其它非法值          → 回退内置默认源（并写日志，便于诊断）
 */
function feedUrl(): string {
  const custom = String(dataStore().get().settings.updateFeedUrl ?? '').trim();
  if (!custom) return DEFAULT_FEED;
  if (/^https:\/\//i.test(custom)) return custom;
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(custom);
  if (shorthand) return `https://api.github.com/repos/${shorthand[1]}/${shorthand[2]}/releases/latest`;
  logWarn('[update] updateFeedUrl 不是 https 地址也不是 owner/repo 简写，已回退内置源：', custom);
  return DEFAULT_FEED;
}

let state: UpdateState = {
  enabled: true,
  currentVersion: '0.0.0',
  hasUpdate: false,
  checkedAt: 0
};
let checking = false;

export function updateState(): UpdateState {
  const s = dataStore().get().settings;
  return {
    ...state,
    enabled: Boolean(s.updateCheckEnabled),
    currentVersion: app.getVersion(),
    placeholderFeed: isPlaceholderFeed()
  };
}

function broadcast(): void {
  const snapshot = updateState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', snapshot);
  }
}

function fetchJson(url: string, timeoutMs = 10_000): Promise<LatestRelease> {
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'xiaopeng-toolbox/' + app.getVersion(),
          Accept: 'application/vnd.github+json'
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + '：' + text.slice(0, 120)));
            return;
          }
          try {
            resolve(JSON.parse(text) as LatestRelease);
          } catch (e) {
            reject(new Error('返回内容不是合法 JSON：' + (e as Error).message));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 检查更新（force=false 时受 1 次/天频率限制） */
export async function checkForUpdates(force = false): Promise<UpdateState> {
  const settings = dataStore().get().settings;
  const current: UpdateState = { ...state, enabled: Boolean(settings.updateCheckEnabled), currentVersion: app.getVersion() };
  if (!settings.updateCheckEnabled && !force) return current;
  if (checking) return current;
  const last = Number(settings.lastUpdateCheck ?? 0);
  if (!force && last && Date.now() - last < CHECK_INTERVAL_MS) {
    logDebug('[update] 距上次检查不足 1 天，跳过');
    return current;
  }
  checking = true;
  try {
    const data = await fetchJson(feedUrl());
    const latest = String(data.tag_name ?? data.name ?? '').replace(/^v/i, '');
    const hasUpdate = Boolean(latest) && compareVersions(latest, app.getVersion()) > 0;
    state = {
      enabled: Boolean(settings.updateCheckEnabled),
      currentVersion: app.getVersion(),
      latestVersion: latest || undefined,
      releaseName: data.name,
      releaseUrl: data.html_url,
      publishedAt: data.published_at,
      hasUpdate,
      checkedAt: Date.now()
    };
    dataStore().updateSettings({ lastUpdateCheck: Date.now(), lastUpdateVersion: latest });
    logDebug('[update] 检查完成：当前', app.getVersion(), '最新', latest || '(未知)', hasUpdate ? '有新版' : '已是最新');
    if (hasUpdate) {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: '小鹏工具箱有新版本',
            body: 'v' + latest + ' 已发布，点击查看下载页'
          });
          n.on('click', () => void openReleasePage());
          n.show();
        }
      } catch (e) {
        logWarn('[update] 通知展示失败', e);
      }
    }
    broadcast();
    // 发现新版本时刷新托盘菜单（加入「前往下载」入口）
    if (hasUpdate) {
      try {
        const { refreshTray } = await import('./trayManager');
        refreshTray();
      } catch (err) {
        logWarn('[update] 刷新托盘菜单失败', err);
      }
    }
    return updateState();
  } catch (e) {
    // 失败静默：仅写日志（大陆网络访问 GitHub 不稳时不影响主流程）
    state = { ...current, checkedAt: Date.now(), error: (e as Error).message };
    logWarn('[update] 检查更新失败（已静默）', e);
    broadcast();
    return updateState();
  } finally {
    checking = false;
  }
}

/** 打开 Release 下载页（无地址时回退到仓库 Releases 列表） */
export async function openReleasePage(): Promise<void> {
  const url = state.releaseUrl || 'https://github.com/xiaopeng/toolbox/releases';
  if (!/^https:\/\//i.test(url)) return;
  await shell.openExternal(url);
}

/** 启动后延迟检查（main.ts 调用） */
export function startUpdateCheck(): void {
  if (!dataStore().get().settings.updateCheckEnabled) {
    logDebug('[update] 检查更新已关闭，跳过');
    return;
  }
  setTimeout(() => {
    void checkForUpdates(false);
  }, START_DELAY_MS);
}
