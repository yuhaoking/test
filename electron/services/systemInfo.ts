import si from 'systeminformation';
import { logError } from '../utils/log';
import type { SystemInfoData } from '../../shared/types';

/**
 * 系统信息采集
 *
 * 资源约束：systeminformation 在 Windows 上会通过 wmic/PowerShell 子进程获取
 * CPU/显卡/磁盘/温度等数据，每次调用代价较高。因此：
 * - 静态数据（CPU 型号/核心数、显卡型号）缓存 5 分钟；
 * - 磁盘容量缓存 60 秒（变化缓慢）；
 * - 温度缓存 15 秒（探测较慢且容忍延迟）；
 * - 动态数据（CPU 负载、内存）每次实时获取。
 */

const STATIC_TTL = 5 * 60_000;
const DISK_TTL = 60_000;
const TEMP_TTL = 15_000;
/** 显卡快照：型号稳定、利用率变化较快，统一按 10 秒缓存 */
const GRAPHICS_TTL = 10_000;

interface StaticCpu {
  model: string;
  cores: number;
}

interface GraphicsSnapshot {
  model: string;
  usage?: number;
  temp?: number;
}

let cpuStatic: StaticCpu | null = null;
let cpuStaticAt = 0;
let graphicsSnapshot: GraphicsSnapshot = { model: '' };
let graphicsSnapshotAt = 0;
let diskSnapshot: { total: number; used: number } | null = null;
let diskSnapshotAt = 0;
let tempSnapshot: { cpu?: number } | null = null;
let tempSnapshotAt = 0;

function fresh(at: number, ttl: number): boolean {
  return Date.now() - at < ttl;
}

/** 读取（可能命中的）静态 CPU 信息，避免每 2 秒启动一次 wmic */
async function getCpuStatic(): Promise<StaticCpu> {
  if (cpuStatic && fresh(cpuStaticAt, STATIC_TTL)) return cpuStatic;
  try {
    const cpu = await si.cpu();
    cpuStatic = { model: cpu.brand ?? '', cores: cpu.cores ?? cpu.physicalCores ?? 0 };
  } catch {
    cpuStatic = { model: '', cores: 0 };
  }
  cpuStaticAt = Date.now();
  return cpuStatic;
}

/** 显卡信息（型号/利用率/温度）：单次 wmic 调用统一缓存，降低子进程开销 */
async function getGraphics(): Promise<GraphicsSnapshot> {
  if (fresh(graphicsSnapshotAt, GRAPHICS_TTL)) return graphicsSnapshot;
  try {
    const gpu = await si.graphics();
    const controller = gpu?.controllers?.[0];
    graphicsSnapshot = {
      model: controller?.model ?? '',
      usage: typeof controller?.utilizationGpu === 'number' ? controller.utilizationGpu : undefined,
      temp:
        typeof controller?.temperatureGpu === 'number' && controller.temperatureGpu > 0
          ? Math.round(controller.temperatureGpu)
          : undefined
    };
  } catch {
    graphicsSnapshot = { model: '' };
  }
  graphicsSnapshotAt = Date.now();
  return graphicsSnapshot;
}

/** 磁盘容量变化缓慢，独立缓存并随采样周期校准 */
async function getDiskUsage(): Promise<{ total: number; used: number }> {
  if (diskSnapshot && fresh(diskSnapshotAt, DISK_TTL)) return diskSnapshot;
  try {
    const fs = await si.fsSize();
    diskSnapshot = {
      total: fs?.reduce((s, d) => s + (d.size ?? 0), 0) ?? 0,
      used: fs?.reduce((s, d) => s + (d.used ?? 0), 0) ?? 0
    };
  } catch {
    diskSnapshot = { total: 0, used: 0 };
  }
  diskSnapshotAt = Date.now();
  return diskSnapshot;
}

/** CPU 温度探测（部分硬件不支持，做兜底；热查询较慢，按 15 秒缓存） */
async function getTemperature(): Promise<{ cpu?: number }> {
  if (tempSnapshot && fresh(tempSnapshotAt, TEMP_TTL)) return tempSnapshot;
  let cpu: number | undefined;
  try {
    const t = await si.cpuTemperature();
    const cpuTemp = t?.main ?? t?.max;
    cpu = cpuTemp && cpuTemp > 0 ? Math.round(cpuTemp) : undefined;
  } catch {
    cpu = undefined;
  }
  tempSnapshot = { cpu };
  tempSnapshotAt = Date.now();
  return tempSnapshot;
}

export async function getSystemInfo(): Promise<SystemInfoData | null> {
  try {
    // 动态数据每次实时采集；静态/慢变化数据走缓存
    const [load, mem, staticCpu, gpu, disk, temp] = await Promise.all([
      si.currentLoad().catch(() => undefined),
      si.mem().catch(() => undefined),
      getCpuStatic(),
      getGraphics(),
      getDiskUsage(),
      getTemperature()
    ]);
    return {
      cpu: {
        model: staticCpu.model,
        cores: load?.cpus?.length ?? staticCpu.cores,
        usage: Math.round((load?.currentLoad ?? 0) * 10) / 10,
        temp: temp.cpu
      },
      mem: {
        total: mem?.total ?? 0,
        used: mem?.used ?? 0,
        usage: mem?.total ? Math.round((mem.used / mem.total) * 100) : 0
      },
      disk: {
        total: disk.total,
        used: disk.used,
        usage: disk.total ? Math.round((disk.used / disk.total) * 100) : 0
      },
      gpu: {
        model: gpu.model,
        usage: gpu.usage,
        temp: gpu.temp
      },
      temps: {
        cpu: temp.cpu,
        gpu: gpu.temp
      }
    };
  } catch (e) {
    logError('[systemInfo] 获取系统信息失败', e);
    return null;
  }
}
