/**
 * SBOM 清单生成（tasks.md T-13 开源合规）
 *
 * 扫描 package.json 声明的依赖 + node_modules 实际安装版本，
 * 输出 CycloneDX 精简格式 `sbom.json`（构建随包分发 / 归档），
 * 并对 copyleft（GPL/AGPL/LGPL）许可给出合规提示（T-13：GPL 审查）。
 *
 * 用法：npm run sbom
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

const declared = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
  ...(pkg.optionalDependencies ?? {})
};

const COPYLEFT = /(GPL|AGPL|LGPL)/i;

function readInstalled(name) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  const f = join(dir, 'package.json');
  if (!existsSync(f)) return null;
  try {
    const p = JSON.parse(readFileSync(f, 'utf-8'));
    return {
      name: p.name ?? name,
      version: p.version ?? 'unknown',
      license: typeof p.license === 'string' ? p.license : (p.license?.type ?? (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN')),
      homepage: p.homepage ?? p.repository?.url ?? ''
    };
  } catch {
    return null;
  }
}

const components = [];
const missing = [];
for (const name of Object.keys(declared).sort()) {
  const inst = readInstalled(name);
  if (!inst) {
    missing.push(name);
    continue;
  }
  components.push({
    type: 'library',
    name: inst.name,
    version: inst.version,
    purl: `pkg:npm/${inst.name}@${inst.version}`,
    licenses: [{ license: { id: inst.license } }],
    externalReferences: inst.homepage ? [{ type: 'website', url: inst.homepage }] : undefined
  });
}

const copyleft = components.filter((c) => COPYLEFT.test(c.licenses[0].license.id));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'xiaopeng-toolbox', name: 'generate-sbom.mjs', version: '1.0.0' }],
    component: { type: 'application', name: pkg.name, version: pkg.version, purl: `pkg:npm/${pkg.name}@${pkg.version}` }
  },
  components
};

writeFileSync(join(root, 'sbom.json'), JSON.stringify(sbom, null, 2), 'utf-8');

console.log(`SBOM 已生成：sbom.json（${components.length} 个组件）`);
if (missing.length) console.log(`未安装跳过（dev 环境可忽略）：${missing.join('、')}`);
if (copyleft.length) {
  console.log('\n⚠️ copyleft 许可组件（T-13 GPL 审查：仅可借鉴交互思路，严禁复制其代码进 MIT 项目）：');
  for (const c of copyleft) console.log(`  · ${c.name}@${c.version} — ${c.licenses[0].license.id}`);
} else {
  console.log('✅ 无 copyleft（GPL/AGPL/LGPL）许可组件');
}
