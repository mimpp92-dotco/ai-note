#!/usr/bin/env node
// 마크다운 링크 무결성 체커 (CI 게이트).
// 저장소 내 모든 .md의 상대 링크가 실재 파일/디렉토리를 가리키는지 검사.
// 깨진 링크가 하나라도 있으면 exit 1 → CI가 머지를 막는다.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
// .venv/.next/.pytest_cache/data 는 생성물·의존성이라 스캔 제외(로컬 false-positive 방지).
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.venv', '.next', '.pytest_cache', 'data',
]);
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const isExternal = (t) => /^(https?:|mailto:|tel:|#)/i.test(t);
const broken = [];
let checked = 0;

for (const file of walk(ROOT)) {
  // HTML 주석은 비활성 콘텐츠 — 링크 검사에서 제외.
  const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(LINK_RE)) {
    let target = m[1].trim();
    if (!target || isExternal(target)) continue;
    target = target.split('#')[0].split('?')[0].trim();
    if (!target) continue;
    checked++;
    if (!existsSync(resolve(dirname(file), target))) {
      broken.push({ file: relative(ROOT, file), link: m[1].trim() });
    }
  }
}

if (broken.length) {
  console.error(`✗ 깨진 마크다운 링크 ${broken.length}개 (검사 ${checked}개):`);
  for (const b of broken) console.error(`  ${b.file} -> ${b.link}`);
  process.exit(1);
}
console.log(`✓ 링크 무결성 OK — ${checked}개 상대 링크 전부 실재.`);
