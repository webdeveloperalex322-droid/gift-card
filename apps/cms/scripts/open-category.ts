/**
 * Отчёт по категории и открытие названных карточек в `index,follow`.
 *
 *   pnpm --filter @otkritka/cms run cards:index:report -- --path=/otkrytki/prazdniki/novyy-god
 *   pnpm --filter @otkritka/cms run cards:index:apply  -- --path=... --slugs=a,b,c --texts-reviewed
 *
 * ## Почему применение идёт по списку slug, а не по фильтру
 *
 * Между отчётом и применением состав категории мог измениться: карточку довели
 * до `published`, и фильтр подхватил бы её молча. Человек подтверждал бы одно
 * множество, а открылось бы другое — это запрещённая «публикация по фильтру из
 * кода». Поэтому `--apply` принимает только явный список, а отчёт печатает его
 * готовой строкой. Список по slug, а не по id: id локальной базы и прода не
 * обязаны совпадать, а slug после первой публикации неизменяем.
 *
 * ## Что здесь НЕ защита
 *
 * Флаг `--texts-reviewed` — speed bump, а не граница: его может выставить и
 * агент. Настоящий контроль в том, что список карточек приходит от человека, а
 * хуки Payload проверяют права и условия на сервере. Скрипт ходит через Local
 * API от имени `admin` с `overrideAccess: false` именно поэтому: хуки обязаны
 * срабатывать (права, условия индексации, аудит в `seo-history`), а прямой SQL
 * их обошёл бы. Карту сайта никакой хук не перегенерирует: её маршруты
 * серверные, но модель карты мемоизирована на SITEMAP_CACHE_SECONDS (300 с),
 * поэтому дельта в карте появляется после истечения этого окна или перезапуска
 * процесса web — не сразу.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolvePhashDistanceThreshold } from '@otkritka/images';
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { similarFingerprint } from '../src/images/duplicates';
import {
  type CategoryCardFacts,
  type HardGate,
  REPORTED_STATUSES,
  collectAttention,
  countCrawlPagesAfter,
  findHardGates,
  medianDescriptionLength,
  resolveRequestedSlugs,
} from '../src/seo/category-index';
import { finishSmoke } from '../src/scripts/smoke-exit';
import type { Card, Collection } from '../src/payload-types';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Под Git Bash MSYS переписывает аргумент, похожий на POSIX-путь:
 * `/otkrytki/...` приезжает как `C:/Program Files/Git/otkrytki/...`. Переменная
 * `MSYS_NO_PATHCONV=1` это не лечит — она ломает запуск pnpm через corepack,
 * поэтому путь восстанавливается здесь.
 */
function normalizeNodePath(raw: string): string {
  const marker = raw.indexOf('/otkrytki');
  const tail = marker > 0 ? raw.slice(marker) : raw;
  const withSlash = tail.startsWith('/') ? tail : `/${tail}`;
  if (withSlash !== raw) console.log(`Путь нормализован: «${raw}» → «${withSlash}»`);
  return withSlash;
}

function readSlugs(): readonly string[] {
  const fromFile = arg('slugs-file');
  const raw =
    fromFile === undefined ? (arg('slugs') ?? '') : readFileSync(fromFile, 'utf8').replace(/\s+/g, ',');
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const apply = process.argv.includes('--apply');
const textsReviewed = process.argv.includes('--texts-reviewed');
const rawPath = arg('path');
if (rawPath === undefined || rawPath === '') {
  throw new Error('Нужен --path=/otkrytki/prazdniki/<tema>: категория не угадывается');
}
const nodePath = normalizeNodePath(rawPath);
const requestedSlugs = readSlugs();

const phashThreshold = resolvePhashDistanceThreshold();

const payload = await getPayload({ config });

const admins = await payload.find({
  collection: 'users',
  limit: 2,
  overrideAccess: true,
  where: { role: { equals: 'admin' } },
});
if (admins.docs.length !== 1) {
  throw new Error(`Ожидался ровно один admin, найдено ${String(admins.docs.length)}`);
}
const user = admins.docs[0];
if (user === undefined) {
  // undefined здесь означал бы анонимного вызывающего при overrideAccess: false,
  // то есть отказ доступа вместо внятной ошибки.
  throw new Error('Запись admin не прочиталась');
}

const nodes = await payload.find({
  collection: 'collections',
  depth: 0,
  limit: 2,
  overrideAccess: true,
  where: { path: { equals: nodePath } },
});
if (nodes.docs.length !== 1) {
  throw new Error(`По пути ${nodePath} найдено записей: ${String(nodes.docs.length)}. Проверь путь`);
}
const node: Collection | undefined = nodes.docs[0];
if (node === undefined) {
  throw new Error(`По пути ${nodePath} запись не прочиталась`);
}

/** Все карточки с ПРЯМОЙ привязкой к узлу. Дочерние узлы не обходятся — см. отчёт. */
const cards: Card[] = [];
for (let page = 1; ; page += 1) {
  const res = await payload.find({
    collection: 'cards',
    depth: 0,
    limit: 200,
    overrideAccess: true,
    page,
    sort: 'id',
    where: { collections: { equals: node.id } },
  });
  cards.push(...res.docs);
  if (!res.hasNextPage) break;
}

function text(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function facts(card: Card): CategoryCardFacts {
  const similar = card.visualDuplicate?.similar ?? [];
  const conflicts = card.metaConflict?.conflicts ?? [];
  // Отпечаток считается ровно той же функцией, что и в хуке: иначе шлюз
  // разошёлся бы с платформой в понимании «решение актуально».
  const similarIds = similar
    .map((row) => (typeof row.card === 'number' ? row.card : row.card?.id))
    .filter((id): id is number => typeof id === 'number');
  const fingerprint =
    typeof card.pHash === 'string' && card.pHash !== ''
      ? similarFingerprint({ hash: card.pHash, ids: similarIds })
      : null;
  return {
    canonical: text(card.canonical),
    description: text(card.description),
    hasImage: card.image !== null && card.image !== undefined,
    id: card.id,
    metaConflicts: typeof card.metaConflict?.total === 'number' ? card.metaConflict.total : conflicts.length,
    duplicateDecision: card.visualDuplicate?.decision ?? null,
    duplicateDecisionCurrent:
      fingerprint !== null && card.visualDuplicate?.decisionFor === fingerprint,
    duplicateScanTruncated: card.visualDuplicate?.scanTruncated === true,
    hasDerivatives: (card.derivative?.variants ?? []).length > 0,
    metaDescription: text(card.metaDescription),
    robots: text(card.robots),
    similarDistances: similar
      .map((row) => row.distance)
      .filter((d): d is number => typeof d === 'number'),
    slug: text(card.slug),
    status: card.status ?? 'draft',
    title: text(card.title),
  };
}

const all = cards.map(facts);
const alreadyOpen = all.filter((c) => c.robots === 'index,follow');
const closed = all.filter((c) => c.robots !== 'index,follow');

console.log(`Категория ${nodePath} (collections#${String(node.id)}, ${String(node.status)}/${String(node.robots)})`);
console.log(`Карточек с прямой привязкой: ${String(all.length)} (дочерние узлы НЕ включены)`);
for (const status of REPORTED_STATUSES) {
  const n = all.filter((c) => c.status === status).length;
  if (n > 0) console.log(`  ${status}: ${String(n)}`);
}
console.log(`Уже в index,follow: ${String(alreadyOpen.length)}`);

/* ── Жёсткие шлюзы и поводы ───────────────────────────────────────────── */

const gates = findHardGates(closed, phashThreshold);
const blocked = new Set(gates.flatMap((g) => g.cards.map((c) => c.slug)));
const eligible = closed.filter((c) => !blocked.has(c.slug));

console.log('--- жёсткие шлюзы (открывать нельзя) ---');
if (gates.length === 0) {
  console.log('ни один не сработал');
} else {
  for (const gate of gates) printGate(gate);
}

function printGate(gate: HardGate): void {
  console.log(`  ${gate.code}: ${String(gate.cards.length)} — ${gate.reason}`);
  for (const c of gate.cards.slice(0, 10)) console.log(`      cards#${String(c.id)} ${c.slug}`);
  if (gate.cards.length > 10) console.log(`      …и ещё ${String(gate.cards.length - 10)}`);
}

console.log('--- поводы посмотреть глазами (решает человек) ---');
const attention = collectAttention(eligible);
if (attention.length === 0) {
  console.log('не нашлось');
} else {
  for (const item of attention) {
    console.log(`  ${item.code}: ${String(item.cards.length)} — ${item.reason}`);
  }
}
console.log(`медиана длины description у пригодных: ${String(medianDescriptionLength(eligible))}`);

/* Прогноз обхода считается по всем индексируемым страницам, а не по карточкам. */
const indexableCards = await payload.count({
  collection: 'cards',
  overrideAccess: true,
  where: { and: [{ robots: { equals: 'index,follow' } }, { status: { equals: 'published' } }] },
});
const indexableNodes = await payload.count({
  collection: 'collections',
  overrideAccess: true,
  where: { and: [{ robots: { equals: 'index,follow' } }, { status: { equals: 'published' } }] },
});
const crawlPages = countCrawlPagesAfter({
  indexableCards: indexableCards.totalDocs,
  indexableNodes: indexableNodes.totalDocs,
  opening: eligible.length,
});
console.log(
  `индексируемых страниц после открытия: ${String(crawlPages)} (нижняя оценка: без пагинации ` +
    'списков и служебных страниц, обход увидит больше)',
);
console.log(
  '  Судит о пределе сам прогон: ищи в выводе pnpm test:seo строку «обход ОБОРВАН пределом ' +
    'запросов» и пометку [проверено нечем]. При обрыве spec исключает из утверждения неизмеренные ' +
    'адреса и перечисляет их — то есть про найденные проверка остаётся верной, а про остальные ' +
    'не сказано ничего. Это и есть повод поднять CRAWL_MAX_REQUESTS.',
);

console.log(`--- пригодны к открытию: ${String(eligible.length)} ---`);
if (eligible.length > 0 && apply) {
  // В режиме применения файл НЕ перезаписывается. Иначе прогон затёр бы тот
  // самый список, который человек правил вычёркиванием, и следующий запуск с тем
  // же путём открыл бы вычеркнутые карточки — «применяется только подтверждённое
  // множество» перестало бы быть правдой со второго раза.
  console.log('Список отчёта не перезаписан: в режиме применения он остаётся как был.');
} else if (eligible.length > 0) {
  // Длинный список печатать строкой нельзя: он нечитаем и упирается в предел
  // длины командной строки. Файл заодно переживает прокрутку терминала — человек
  // правит его, вычёркивая карточки, и тем же файлом запускает применение.
  const listPath = arg('out') ?? join(tmpdir(), `open-category-${node.id.toString()}.slugs.txt`);
  writeFileSync(listPath, eligible.map((c) => c.slug).join('\n') + '\n', 'utf8');
  console.log(`Список slug для применения записан: ${listPath}`);
  console.log('Проверь состав глазами, вычеркни лишние строки и запусти применение с');
  console.log(`  --slugs-file=${listPath}`);
  if (eligible.length <= 20) {
    console.log(`  (или строкой) --slugs=${eligible.map((c) => c.slug).join(',')}`);
  }
}

/* ── Применение ───────────────────────────────────────────────────────── */

if (!apply) {
  console.log('--- отчёт: ничего не изменено ---');
  // finishSmoke получает ЧИСЛО НАХОДОК и превращает его в код выхода 1 или 0:
  // так «сработал жёсткий шлюз» отличимо машинно, а не только глазами.
  await finishSmoke(gates.length);
}

if (requestedSlugs.length === 0) {
  console.log('ОТКАЗ: --apply без --slugs. Применение идёт только по явному списку от человека.');
  await finishSmoke(1);
}

if (!textsReviewed) {
  console.log(
    'ОТКАЗ: нет --texts-reviewed. Подтверди, что тексты этих карточек показаны человеку и он ' +
      'сказал применять: открытие в индекс — его решение, а не следствие правки текстов.',
  );
  await finishSmoke(1);
}

const { missing, picked } = resolveRequestedSlugs(eligible, requestedSlugs);
if (missing.length > 0) {
  console.log(`ОТКАЗ: в категории нет пригодных карточек со slug: ${missing.join(', ')}`);
  console.log('Состав категории изменился после отчёта или slug указан с опечаткой. Сними отчёт заново.');
  await finishSmoke(missing.length);
}

console.log(`--- применяю к ${String(picked.length)} карточкам ---`);
let ok = 0;
let failed = 0;
const reasons = new Map<string, number>();

for (const card of picked) {
  try {
    await payload.update({
      collection: 'cards',
      data: { robots: 'index,follow' },
      depth: 0,
      id: card.id,
      overrideAccess: false,
      user,
    });
    ok += 1;
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    const key = message.slice(0, 160);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    console.log(`  ОТКАЗ cards#${String(card.id)} ${card.slug}: ${message}`);
  }
}

console.log(`--- применено: ${String(ok)}, отказов: ${String(failed)} ---`);
for (const [message, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count)}x ${message}`);
}
if (failed > 0) {
  console.log(
    'Отказы хуков при чистом отчёте штатны: шлюзы читают СНИМКИ последнего сохранения, а хук ' +
      'проверяет свежее состояние. Сними отчёт заново перед следующей попыткой.',
  );
}
console.log(
  'Дальше: сверить <loc> в sitemap-cards-*.xml до и после — но не раньше, чем истечёт ' +
    'мемоизация карты (300 с) или перезапустится процесс web; при несовпадении кеш это первая ' +
    'версия, а не последняя. В image sitemap та же карточка даёт свой <loc>, по всему дереву ' +
    'дельта выйдет двойной. Затем: подвинуть updatedContentAt у карточек с переписанным текстом, ' +
    'прогнать pnpm verify, обновить замеры в declared-pages.ts, записать решение в ' +
    'docs/etap-0-resheniya.md.',
);
await finishSmoke(failed > 0 ? 1 : 0);
