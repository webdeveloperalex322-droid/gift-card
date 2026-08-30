/**
 * Маршрут `/sitemap-sections.xml` — карта разделов (задача Э4-04).
 *
 * Содержимое: главная, каталоги `/otkrytki` и `/podborki`, служебные страницы
 * Ч-23 и узлы таксономии — те из них, что выполняют три условия включения
 * (`../data/sitemap-content.ts`). Пока ни одна страница их не выполняет, файла
 * не существует: маршрут отвечает 404, и индекс на него не ссылается.
 */
import type { APIRoute } from 'astro';

import { buildSitemapModel } from '../data/sitemap-content';
import { renderUrlset, sitemapFilePayload } from '../seo/sitemap';
import { serverEnv } from '../server-env';

export const prerender = false;

export const GET: APIRoute = async () => {
  const model = await buildSitemapModel(serverEnv());
  const payload = sitemapFilePayload(model.sections, renderUrlset);

  return new Response(payload.body, { headers: payload.headers, status: payload.status });
};
