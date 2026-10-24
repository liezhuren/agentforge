/**
 * 证据核验的**可自纠性**。
 *
 * 背景（cb-15，2026-10-24 实测）：同一轮出现 **15 条** `evidence-invalid`，
 * 原因完全相同 —— 验证器引用的文件与行号都对，但把 `expect` 写成了描述句
 * （「handleHealth 写 {status:'ok'} 且状态码 200」），
 * 而核验要求它是该行区间的**逐字子串**，于是整条判定作废。
 *
 * 那 15 条判定里文件的、行号的都对，唯一错的是「声称的写法」。
 * 而失败消息当时只说「行区间未包含所声称的内容」——
 * **没有告诉它这段代码实际长什么样**，所以下一轮它只能换个说法再错一次。
 *
 * 现在消息里带上区间实际内容。判定标准一点没放宽（仍然是逐字包含），
 * 只是把「你错了」变成「你错在哪」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyEvidence } from '../src/types.ts';
import type { AnchorContext } from '../src/types.ts';

const SOURCE = [
  'import { createServer } from "node:http";',
  '',
  'export function startServer(port: number) {',
  '  const server = createServer(handle);',
  '  server.listen(port);',
  '  return server;',
  '}',
].join('\n');

/** 最小可用上下文：只实现 verifyEvidence 会用到的 readFile。 */
function ctxOf(): AnchorContext {
  return {
    readFile: async (p: string) => (p === 'src/api/server.ts' ? SOURCE : null),
  } as unknown as AnchorContext;
}

test('🔴 描述句作为证据 → 失败消息必须附上区间实际内容（否则模型只会换个说法再错）', async () => {
  const r = await verifyEvidence(
    {
      kind: 'file',
      path: 'src/api/server.ts',
      startLine: 3,
      endLine: 7,
      // 这是 cb-15 里那种写法：描述"发生了什么"，而不是照抄原文
      expect: 'startServer 内调用 server.listen(port)',
    },
    ctxOf(),
  );

  assert.equal(r.ok, false, '描述句不是原文子串，必须判失败（标准没有放宽）');
  assert.match(r.reason ?? '', /未包含所声称的内容/);
  assert.match(r.reason ?? '', /该区间实际内容是/, '必须告诉它这段代码实际长什么样');
  assert.match(r.reason ?? '', /server\.listen\(port\),?/, `实际内容里应能看到原文：${r.reason}`);
  assert.match(r.reason ?? '', /逐字复制/, '必须给出正确的写法');
});

test('逐字照抄同一段 → 通过（同一个位置，写法不同结果相反）', async () => {
  const r = await verifyEvidence(
    { kind: 'file', path: 'src/api/server.ts', startLine: 3, endLine: 7, expect: 'server.listen(port);' },
    ctxOf(),
  );
  assert.equal(r.ok, true, '照抄原文必须通过 —— 这正是我们要求它做的事');
});

test('行号越界的消息照旧清楚（不受本次改动影响）', async () => {
  const r = await verifyEvidence(
    { kind: 'file', path: 'src/api/server.ts', startLine: 999, endLine: 1001, expect: 'x' },
    ctxOf(),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /越界/);
});
