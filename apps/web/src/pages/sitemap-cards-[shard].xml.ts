/**
 * Маршрут `/sitemap-cards-N.xml` — части карты карточек (задача Э4-04).
 *
 * Номер части обязателен даже когда часть одна: адрес файла не должен меняться
 * от объёма каталога (обоснование — `../seo/sitemap.ts`, `SITEMAP_CARDS_PREFIX`).
 *
 * Части нумеруются с единицы и существуют ровно те, что перечислены в индексе:
 * номер вне диапазона, `0`, `01` и любой другой мусор отвечают 404 — как и номер
 * страницы пагинации, и по той же причине (у одного файла один адрес).
 */
import type { APIRoute } from 'astro';

import { buildSitemapModel, shardAt } from '../data/sitemap-content';
import { parseShardParam, renderUrlset, sitemapFilePayload } from '../seo/sitemap';
import { serverEnv } from '../server-env';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const shard = parseShardParam(params['shard']);
  // Форма номера проверяется ДО обращения к базе: у адреса `/sitemap-cards-0.xml`
  // файла не существует, и знать для этого состояние каталога не нужно.
  const model = shard === null ? null : await buildSitemapModel(serverEnv());
  const payload = sitemapFilePayload(
    model === null ? null : shardAt(model.cardShards, shard),
    renderUrlset,
  );

  return new Response(payload.body, { headers: payload.headers, status: payload.status });
};
