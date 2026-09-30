/**
 * 单位换算（DEV-08）：长度 / 数据大小 / 时间 / 重量（≥3 类单位族）
 */

export type UnitFamily = 'length' | 'data' | 'time' | 'weight';

export interface UnitDef {
  key: string;
  label: string;
  /** 相对族基准单位的倍率（基准见 FAMILY_BASE） */
  factor: number;
}

export interface UnitFamilyDef {
  key: UnitFamily;
  label: string;
  base: string;
  units: UnitDef[];
}

export const UNIT_FAMILIES: UnitFamilyDef[] = [
  {
    key: 'length',
    label: '长度',
    base: 'm',
    units: [
      { key: 'mm', label: '毫米 (mm)', factor: 0.001 },
      { key: 'cm', label: '厘米 (cm)', factor: 0.01 },
      { key: 'm', label: '米 (m)', factor: 1 },
      { key: 'km', label: '千米 (km)', factor: 1000 },
      { key: 'inch', label: '英寸 (in)', factor: 0.0254 },
      { key: 'foot', label: '英尺 (ft)', factor: 0.3048 },
      { key: 'mile', label: '英里 (mi)', factor: 1609.344 }
    ]
  },
  {
    key: 'data',
    label: '数据大小',
    base: 'B',
    units: [
      { key: 'B', label: '字节 (B)', factor: 1 },
      { key: 'KB', label: '千字节 (KB, 1000)', factor: 1000 },
      { key: 'MB', label: '兆字节 (MB, 1000²)', factor: 1e6 },
      { key: 'GB', label: '吉字节 (GB, 1000³)', factor: 1e9 },
      { key: 'TB', label: '太字节 (TB, 1000⁴)', factor: 1e12 },
      { key: 'KiB', label: 'KiB (1024)', factor: 1024 },
      { key: 'MiB', label: 'MiB (1024²)', factor: 1048576 },
      { key: 'GiB', label: 'GiB (1024³)', factor: 1073741824 }
    ]
  },
  {
    key: 'time',
    label: '时间',
    base: 's',
    units: [
      { key: 'ms', label: '毫秒 (ms)', factor: 0.001 },
      { key: 's', label: '秒 (s)', factor: 1 },
      { key: 'min', label: '分钟 (min)', factor: 60 },
      { key: 'h', label: '小时 (h)', factor: 3600 },
      { key: 'day', label: '天 (d)', factor: 86400 },
      { key: 'week', label: '周', factor: 604800 }
    ]
  },
  {
    key: 'weight',
    label: '重量',
    base: 'kg',
    units: [
      { key: 'mg', label: '毫克 (mg)', factor: 1e-6 },
      { key: 'g', label: '克 (g)', factor: 0.001 },
      { key: 'kg', label: '千克 (kg)', factor: 1 },
      { key: 'ton', label: '吨 (t)', factor: 1000 },
      { key: 'lb', label: '磅 (lb)', factor: 0.45359237 },
      { key: 'oz', label: '盎司 (oz)', factor: 0.028349523125 }
    ]
  }
];

export function findFamily(key: string): UnitFamilyDef | null {
  return UNIT_FAMILIES.find((f) => f.key === key) ?? null;
}

function unitOf(family: UnitFamilyDef, key: string): UnitDef | null {
  return family.units.find((u) => u.key.toLowerCase() === String(key ?? '').toLowerCase()) ?? null;
}

/** 单值换算；单位不存在返回 null */
export function convertUnit(value: number, from: string, to: string): number | null {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  for (const family of UNIT_FAMILIES) {
    const a = unitOf(family, from);
    const b = unitOf(family, to);
    if (a && b) return (v * a.factor) / b.factor;
  }
  return null;
}

/** 同族全量对照（DEV-08：同屏展示一族单位） */
export function convertFamily(value: number, from: string, familyKey: string): Record<string, number> | null {
  const family = findFamily(familyKey);
  if (!family) return null;
  const src = unitOf(family, from);
  if (!src) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const baseValue = v * src.factor;
  const out: Record<string, number> = {};
  for (const u of family.units) out[u.key] = baseValue / u.factor;
  return out;
}

/** 去掉浮点尾差后的展示文本（最多 6 位有效小数） */
export function formatUnit(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e15 || abs < 1e-9) return v.toExponential(6);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return String(Number(v.toFixed(digits)));
}
