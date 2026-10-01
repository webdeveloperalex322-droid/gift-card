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

const zones = [
  { test: /apps\/web\/src\/(pages|layouts|components)\//, name: 'шаблон или роутинг Astro' },
  { test: /apps\/web\/src\/middleware/, name: 'middleware редиректов' },
  { test: /sitemap|robots/i, name: 'sitemap или robots' },
  { test: /apps\/cms\/src\/collections\//, name: 'коллекции Payload' },
];

const hit = zones.find((zone) => zone.test.test(path));
if (!hit) process.exit(0);

const context = [
  `Задета зона SEO-риска: ${hit.name} (${path}).`,
  'Перед завершением задачи обязательны: pnpm test:seo до и после правки,',
  'вердикт seo-auditor и, если тронуты URL/canonical/редиректы/sitemap, вердикт url-guard.',
  'Полный порядок — в skill finish-task.',
].join(' ');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }),
);
