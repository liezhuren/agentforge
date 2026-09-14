/** 调试：buildLlm 之后 provider 到底处于哪个 jsonMode。 */
import { join } from 'node:path';
import { loadConfigFile, buildLlm } from '../packages/llm/src/index.ts';

const ws = process.argv[2] ?? 'workspace/llm-11';
const config = await loadConfigFile(join(import.meta.dirname, '..', 'agentforge.config.json'));

console.log('config.probe =', JSON.stringify(config.probe));
console.log('root =', ws);

const built = await buildLlm(config, {
  root: ws,
  runId: 'dbg',
  record: false,
  probe: true,
  onNotice: (m) => console.log('[notice]', m.slice(0, 120)),
});

console.log('\nprobes:');
for (const p of built.probes) {
  console.log(`  ${p.provider}/${p.model} jsonSchema=${p.jsonSchema} reachable=${p.reachable} conclusive=${p.conclusive} live=${p.live}`);
}

// 直接看 provider 的内部状态
const raw = (built as unknown as { raw?: Map<string, unknown> }).raw;
console.log('\nraw providers:', raw ? [...raw.keys()] : '(不可访问)');
for (const [k, v] of raw ?? []) {
  const prov = v as { jsonMode?: string; strictSchemaMode?: string; config?: { defaultModel?: string } };
  console.log(`  ${k}: jsonMode=${prov.jsonMode} strictSchemaMode=${prov.strictSchemaMode} model=${prov.config?.defaultModel}`);
}
