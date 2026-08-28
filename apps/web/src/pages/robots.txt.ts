/**
 * Маршрут `/robots.txt` (задача Э4-03).
 *
 * Правил здесь нет: состав директив и их форму собирает `../seo/robots-txt.ts`
 * (решение Ч-22), а состав закрытых путей приходит из реестра
 * `@otkritka/shared`. Задача файла — отдать текст с верным типом содержимого.
 *
 * ## Почему маршрут НЕ пререндерится
 *
 * В файле есть абсолютная ссылка на sitemap-индекс, а хост берётся из `SITE_URL`
 * в РАНТАЙМЕ (`CLAUDE.md`, «Правила URL»). Пререндер запёк бы в артефакт хост
 * того окружения, где выполнялась сборка, и один и тот же билд на стенде и в
 * production отдавал бы один и тот же адрес карты сайта — то есть чужой.
 *
 * ## Про завершающий слеш
 *
 * `/robots.txt` — URL ФАЙЛА, и правило Ч-21 к нему не применяется:
 * `isPageRoute` из `@otkritka/shared` считает путь с расширением файлом, поэтому
 * входной сервер его не нормализует, а `/robots.txt/` остаётся отдельным
 * несуществующим адресом (404). Это уже проверяется приёмкой
 * (`tests/seo/file-urls-not-normalized.spec.ts`).
 */
import type { APIRoute } from 'astro';

import { buildRobotsTxt, ROBOTS_TXT_CONTENT_TYPE } from '../seo/robots-txt';
import { serverEnv } from '../server-env';

export const prerender = false;

export const GET: APIRoute = () => {
  const body = buildRobotsTxt(serverEnv());

  return new Response(body, {
    headers: {
      // Час — компромисс между «правка доезжает быстро» и «файл запрашивают на
      // каждый обход». Поисковые системы и сами держат robots.txt в кеше около
      // суток, поэтому меньшее значение ничего не ускорит.
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': ROBOTS_TXT_CONTENT_TYPE,
    },
    status: 200,
  });
};
