import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/** 从 cwd 向上查找包含 src/app.ts 的项目根目录。 */
function findProjectRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'src', 'app.ts'))) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`无法定位项目根目录：从 ${process.cwd()} 向上未找到 src/app.ts`);
}

const projectRoot = findProjectRoot();
const srcRoot = join(projectRoot, 'src');
const testRoot = join(projectRoot, 'test');

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const srcFiles = collectTsFiles(srcRoot);
const testFiles = collectTsFiles(testRoot);

const SPECIFIER_PATTERN = /from\s+['"]([^'"]+)['"]/g;

function specifiersOf(text: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(SPECIFIER_PATTERN.source, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      found.push(specifier);
    }
    match = pattern.exec(text);
  }
  return found;
}

const FS_WRITE_TOKENS = ['write' + 'File', 'append' + 'File', 'createWrite' + 'Stream'];
const FORBIDDEN_PROCESS_TOKENS = ['child' + '_process', 'spawn' + '('];
const REQUIRED_TEST_TOKENS = ['400', '404', '?status='];
const ENTRY_CANDIDATES = ['src/server.ts', 'src/index.ts', 'src/main.ts'];

function hasTopLevelListen(text: string): boolean {
  return text.split('\n').some((line) => /^[A-Za-z_$][\w$]*\.listen\s*\(/.test(line));
}

test('R-012/R-013：相对导入带 .ts 扩展名，非相对导入只用 node: 内置模块', () => {
  const checkedFiles = [...srcFiles, ...testFiles];
  assert.ok(checkedFiles.length > 0, '未找到待检查的 TypeScript 文件');
  const relativeViolations: string[] = [];
  const bareViolations: string[] = [];
  for (const file of checkedFiles) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        if (!specifier.endsWith('.ts')) {
          relativeViolations.push(`${file} -> ${specifier}`);
        }
      } else if (!specifier.startsWith('node:')) {
        bareViolations.push(`${file} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(relativeViolations, [], '相对导入必须带显式 .ts 扩展名');
  assert.deepEqual(bareViolations, [], '非相对导入必须是 node: 内置模块，不允许第三方包');
});

test('R-010：src 中不存在文件系统写操作（数据只驻留内存）', () => {
  assert.ok(srcFiles.length > 0, '未找到任何 src TypeScript 文件');
  const violations: string[] = [];
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8');
    for (const token of FS_WRITE_TOKENS) {
      if (text.includes(token)) {
        violations.push(`${file} 含有 ${token}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('R-013/R-014：源码与测试中不出现子进程调用', () => {
  const violations: string[] = [];
  for (const file of [...srcFiles, ...testFiles]) {
    const text = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN_PROCESS_TOKENS) {
      if (text.includes(token)) {
        violations.push(`${file} 含有 ${token}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('R-011：测试源码中存在 400 / 404 状态码与 ?status= 过滤断言', () => {
  const otherTestFiles = testFiles.filter((file) => !file.endsWith('static-checks.test.ts'));
  assert.ok(otherTestFiles.length >= 3, `期望至少 3 个其它测试文件，实际 ${otherTestFiles.length}`);
  const corpus = otherTestFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const token of REQUIRED_TEST_TOKENS) {
    assert.ok(corpus.includes(token), `测试源码中缺少 ${token} 断言`);
  }
});

test('R-001：入口模块在顶层调用 listen，npm start 时进程不会立即退出', () => {
  const entries = ENTRY_CANDIDATES.map((rel) => join(projectRoot, rel)).filter((file) => existsSync(file));
  assert.ok(entries.length > 0, '未找到入口模块（src/server.ts、src/index.ts、src/main.ts 均不存在）');
  const texts = entries.map((file) => readFileSync(file, 'utf8'));
  const selfListening = texts.filter((text) => hasTopLevelListen(text));
  const delegating = texts.filter((text) => /from\s+['"]\.\/server\.ts['"]/.test(text));
  assert.ok(
    selfListening.length + delegating.length > 0,
    '入口模块既没有顶层 listen，也没有引用会在顶层 listen 的 ./server.ts',
  );
});
