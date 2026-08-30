/**
 * Маршрут `/sitemap.xml` — индекс карты сайта (задача Э4-04).
 *
 * Индекс перечисляет только НЕПУСТЫЕ файлы: карта без единого адреса не
 * выкладывается вовсе, а её адрес отвечает 404 (`./sitemap-sections.xml.ts` и
 * маршруты частей). Поэтому индекс никогда не ссылается на пустой файл.
 *
 * Пустой индекс — законное состояние ненаполненного сайта: ни одна страница пока
 * не выполняет трёх условий включения (разбор — `../data/sitemap-content.ts`).
 * Он отдаётся с кодом 200 и с комментарием внутри: 404 на адресе, который назван
 * в `robots.txt`, выглядел бы поломкой, а не пустотой.
 *
 * Маршрут не пререндерится: и состав, и хост читаются в рантайме.
 */
import type { APIRoute } from 'astro';

import { buildSitemapModel, sitemapIndexEntries } from '../data/sitemap-content';
import { canonicalUrlFor } from '../routing/canonical';
import {
  renderSitemapIndex,
  SITEMAP_CACHE_CONTROL,
  SITEMAP_CONTENT_TYPE,
} from '../seo/sitemap';
import { serverEnv } from '../server-env';

export const prerender = false;

/**
 * Пояснение внутри пустого индекса.
 *
 * Комментарий, а не элемент: он не меняет структуру документа, но отвечает
 * человеку, открывшему адрес, на вопрос «почему пусто». Чисел в нём нет
 * намеренно — состояние неопубликованного контента наружу не публикуется.
 */
const EMPTY_INDEX_NOTE =
  '<!-- Карта сайта пуста: ни одна страница пока не удовлетворяет условиям включения ' +
  '(ответ 200, разрешение на индексацию, собственный canonical). -->';

export const GET: APIRoute = async () => {
  const env = serverEnv();
  const model = await buildSitemapModel(env);
  const entries = sitemapIndexEntries(model, (path) => canonicalUrlFor(path, env));
  const xml = renderSitemapIndex(entries);
  const body = entries.length === 0 ? `${xml.trimEnd()}\n${EMPTY_INDEX_NOTE}\n` : xml;

  return new Response(body, {
    headers: {
      // Короткий кеш. То же число, что у остальных файлов карты и у памяти
      // процесса под собранную модель: один срок на всё (SITEMAP_CACHE_SECONDS).
      'Cache-Control': SITEMAP_CACHE_CONTROL,
      'Content-Type': SITEMAP_CONTENT_TYPE,
    },
    status: 200,
  });
};
