#!/usr/bin/env node
/**
 * PostToolUse-хук: напоминание, не блокировка.
 *
 * Правило CLAUDE.md: «Если меняешь шаблон страницы, роутинг, sitemap или
 * коллекции — запусти pnpm test:seo до и после». Хук ловит момент, когда правка
 * попала в такую зону, и возвращает напоминание в контекст.
 */
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.exit(0);
}

const WINDOWS_SEPARATOR = String.fromCharCode(92);
const path = String(payload?.tool_input?.file_path ?? '')
  .split(WINDOWS_SEPARATOR)
  .join('/');
if (!path) process.exit(0);

// Каждая зона называет контролёров, чей вердикт для неё обязателен: напоминание
// «вызови кого-то» бесполезно, если не сказано кого именно.
const zones = [
  {
    // Первой: рекламный блок обычно лежит внутри шаблонов, а риск у него свой —
    // контейнер без зарезервированного места двигает вёрстку и ломает CLS.
    test: /(ad|ads|adsense|yandex-?direct|rtb)[-._/]/i,
    name: 'рекламные блоки',
    guards: 'perf-guard, seo-auditor',
  },
  {
    test: /apps\/web\/src\/(pages|layouts|components)\//,
    name: 'шаблон или роутинг Astro',
    guards: 'seo-auditor, url-guard, perf-guard',
  },
  {
    test: /apps\/web\/src\/middleware/,
    name: 'middleware редиректов',
    guards: 'url-guard, seo-auditor',
  },
  { test: /sitemap|robots/i, name: 'sitemap или robots', guards: 'url-guard, seo-auditor' },
  {
    test: /apps\/cms\/src\/collections\//,
    name: 'коллекции Payload',
    guards: 'seo-auditor, url-guard',
  },
  {
    // Общий контракт: транслитерация и правила URL отсюда определяют будущие slug'и.
    test: /packages\/shared\/src\//,
    name: 'общий контракт packages/shared (правила URL и статусы)',
    guards: 'url-guard, reviewer',
  },
  {
    test: /packages\/images\/src\//,
    name: 'пайплайн изображений',
    guards: 'perf-guard, seo-auditor',
  },
];

const hit = zones.find((zone) => zone.test.test(path));
if (!hit) process.exit(0);

const context = [
  `Задета зона SEO-риска: ${hit.name} (${path}).`,
  'Перед завершением задачи обязательны: pnpm test:seo до и после правки,',
  `вердикты контролёров ${hit.guards}, и reviewer — всегда.`,
  'Полный порядок — в skill finish-task, промпты вызова — в docs/agents-launch.md.',
].join(' ');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }),
);
