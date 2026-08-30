/**
 * Маршрут `/sitemap-images-N.xml` — части image sitemap (задача Э4-04).
 *
 * В файл идут адреса тех же страниц карточек и изображение, которое каждая из
 * них ПОКАЗЫВАЕТ, — резервная производная из `<img src>`. Страница без
 * изображения сюда не попадает вовсе: запись `<url>` без `<image:image>` ничего
 * не описывает.
 *
 * Нумерация и отказы — как у частей карты карточек.
 */
import type { APIRoute } from 'astro';

import { buildSitemapModel, shardAt } from '../data/sitemap-content';
import { parseShardParam, renderImageUrlset, sitemapFilePayload } from '../seo/sitemap';
import { serverEnv } from '../server-env';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const shard = parseShardParam(params['shard']);
  const model = shard === null ? null : await buildSitemapModel(serverEnv());
  const payload = sitemapFilePayload(
    model === null ? null : shardAt(model.imageShards, shard),
    renderImageUrlset,
  );

  return new Response(payload.body, { headers: payload.headers, status: payload.status });
};
