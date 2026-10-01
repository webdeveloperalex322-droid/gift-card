/**
 * ОДНОРАЗОВЫЙ скрипт волны 1 (решение Ч-33, 2026-10-01). В репозиторий не коммитится.
 * Списки id — дословно из docs/publikaciya-volna-1.md. Каждая запись — отдельный
 * update от имени admin: все хуки (валидация полноты, claim пути, seo-history) срабатывают.
 *
 *   payload run ./scripts/_volna-1.tmp.ts -- --phase=publish [--apply]
 *   payload run ./scripts/_volna-1.tmp.ts -- --phase=index   [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { finishSmoke } from '../src/scripts/smoke-exit';

const NODES = [307, 306, 308, 305, 312, 309] as const;
const apply = process.argv.includes('--apply');
const phase = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length);

const doc = fs.readFileSync(path.resolve('../../docs/publikaciya-volna-1.md'), 'utf8');
const lists = [...doc.matchAll(/```\r?\n([\d, ]+)\r?\n```/g)].map((m) =>
  (m[1] ?? '').split(',').map((s) => Number(s.trim())),
);
const cardIds = lists.slice(0, 6).flat();
const indexIds = lists[6] ?? [];
if (cardIds.length !== 113 || indexIds.join() !== NODES.join()) {
  throw new Error(`Списки из документа не сошлись: карточек ${String(cardIds.length)}, узлы ${indexIds.join()}`);
}

const payload = await getPayload({ config });
const admins = await payload.find({ collection: 'users', where: { role: { equals: 'admin' } }, limit: 2, overrideAccess: true });
if (admins.docs.length !== 1) throw new Error(`Ожидался ровно один admin, найдено ${String(admins.docs.length)}`);
const user = admins.docs[0];
console.log(`Режим: ${apply ? 'APPLY' : 'dry-run'}, фаза ${String(phase)}, от имени users#${String(user?.id)}`);
console.log(`Старт: ${new Date().toISOString()}`);

let failed = 0;
async function step(collection: 'cards' | 'collections', id: number, data: Record<string, unknown>): Promise<void> {
  const current = await payload.findByID({ collection, id, depth: 0, overrideAccess: true });
  const label = `${collection}#${String(id)} ${String((current as { slug?: string }).slug)} [${String(current.status)}/${String(current.robots)}]`;
  if (!apply) {
    console.log(`  план: ${label} -> ${JSON.stringify(data)}`);
    return;
  }
  try {
    await payload.update({ collection, id, data, user, overrideAccess: false, depth: 0 });
    console.log(`  ок:   ${label} -> ${JSON.stringify(data)}`);
  } catch (error) {
    failed += 1;
    console.log(`  ОТКАЗ: ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (phase === 'publish') {
  for (const id of cardIds) await step('cards', id, { status: 'published' });
  await step('collections', 309, { status: 'published' });
} else if (phase === 'index') {
  for (const id of NODES) await step('collections', id, { robots: 'index,follow' });
} else {
  throw new Error('Нужен --phase=publish или --phase=index');
}

console.log(`Конец: ${new Date().toISOString()}, отказов: ${String(failed)}`);
await finishSmoke(failed);
