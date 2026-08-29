/**
 * Ручка выгрузки SEO-инвентаря: `GET /api/seo-inventory.csv` (задача Э5-05).
 *
 * Отдельного API-слоя проект не пишет — Payload сам отдаёт REST и GraphQL для
 * коллекций. Эта ручка не CRUD и не обёртка над ним: она собирает ОТЧЁТ, у
 * которого часть колонок берётся с живого сайта, а не из базы. Выразить такое
 * запросом к коллекции нельзя, поэтому и понадобилась своя точка входа. Никаких
 * бизнес-правил она не дублирует и ничего не пишет.
 *
 * ═══ ПРАВА ═══
 *
 * Выгрузка НЕ должна становиться обходом прав. Поэтому:
 *
 *   1. аноним получает 403 и ни строки. Публично отдавать даже список
 *      опубликованных адресов через эту ручку незачем: у сайта для этого есть
 *      карта, а здесь каждая строка стоит запроса CMS к сайту — то есть
 *      неаутентифицированный вызов был бы рычагом обхода всего сайта по одному
 *      HTTP-запросу;
 *   2. записи читаются с `overrideAccess: false` и с `req` вызывающего, то есть
 *      через тот же `contentReadAccess`, что REST и GraphQL. Роль, которой
 *      черновики не видны, не увидит их и в выгрузке — это свойство не
 *      обещанием держится, а тем же предикатом доступа.
 *
 * Урок прошлой волны (Э5-02): снимок визуальных дублей уходил анониму вместе с
 * идентификаторами записей в `review`. Класс ошибки тот же — «отчётное поле
 * отдаётся шире, чем сами записи», — поэтому здесь проверка прав стоит первой
 * строкой обработчика, а не рядом с чтением данных.
 *
 * ═══ ПАРАМЕТРЫ ═══
 *
 *   `?probe=0` — не спрашивать сайт: колонки ответа останутся пустыми, зато
 *   выгрузка мгновенна. Полезно, когда сайт заведомо не поднят.
 *
 * Адреса, куда ходить, параметром не задаются: origin всегда из `SITE_URL`
 * (см. `./inventory.ts`).
 */
import type { Endpoint, PayloadRequest, Where } from 'payload';

import { contentDocumentPath } from '../seo/paths';
import {
  type InventoryRecord,
  MAX_INVENTORY_ROWS,
  buildInventoryCsv,
  fetchProbe,
} from './inventory';

/** Путь ручки. Полный адрес — `/api` + это значение. */
export const SEO_INVENTORY_PATH = '/seo-inventory.csv';

/** Имя файла в браузере. Без даты: дату несёт колонка, а имя должно быть предсказуемым. */
export const SEO_INVENTORY_FILENAME = 'seo-inventory.csv';

/** Заголовок, в котором приходят предупреждения о неизмеренном. */
export const SEO_INVENTORY_WARNINGS_HEADER = 'X-Seo-Inventory-Warnings';

interface ContentPage {
  readonly docs: readonly Record<string, unknown>[];
}

/**
 * Записи обеих контентных коллекций в объёме колонок выгрузки.
 *
 * Ветвление по литералу коллекции, а не переменная в одном вызове: состав
 * `select` разный (у карточки адрес выводится из slug, у подборки хранится в
 * `path`), и лишнее имя поля в выборке — это запрос к несуществующей колонке.
 * Тот же довод, что в `findMetaConflicts`.
 */
export async function collectInventoryRecords(req: PayloadRequest): Promise<InventoryRecord[]> {
  // Предел на один больше: превышение обязано быть видно в предупреждениях
  // сборщика, а не потеряться на границе выборки.
  const limit = MAX_INVENTORY_ROWS + 1;
  const shared = {
    depth: 0,
    limit,
    overrideAccess: false,
    req,
    sort: 'id',
  } as const;
  const anyRecord: Where = {};

  const cards: ContentPage = await req.payload.find({
    ...shared,
    collection: 'cards',
    select: {
      robots: true,
      slug: true,
      status: true,
      title: true,
      updatedAt: true,
      updatedContentAt: true,
    },
    where: anyRecord,
  });

  const collections: ContentPage = await req.payload.find({
    ...shared,
    collection: 'collections',
    select: {
      nodeKind: true,
      path: true,
      robots: true,
      status: true,
      title: true,
      updatedAt: true,
      updatedContentAt: true,
    },
    where: anyRecord,
  });

  const records: InventoryRecord[] = [];
  for (const doc of cards.docs) {
    records.push({
      collection: 'cards',
      // Адрес выводится ЕДИНСТВЕННЫМ выводом пути из документа: своя склейка
      // «/otkrytki/» + slug была бы вторым правилом об одном и том же адресе.
      path: contentDocumentPath('cards', doc),
      robots: doc.robots,
      status: doc.status,
      title: doc.title,
      updatedAt: doc.updatedAt,
      updatedContentAt: doc.updatedContentAt,
    });
  }
  for (const doc of collections.docs) {
    records.push({
      collection: 'collections',
      nodeKind: doc.nodeKind,
      path: contentDocumentPath('collections', doc),
      robots: doc.robots,
      status: doc.status,
      title: doc.title,
      updatedAt: doc.updatedAt,
      updatedContentAt: doc.updatedContentAt,
    });
  }
  return records;
}

/** Спрашивать ли сайт. Выключается только явным `probe=0` / `probe=false`. */
export function shouldProbeSite(url: string): boolean {
  const value = new URL(url, 'http://placeholder.invalid').searchParams.get('probe');
  return value !== '0' && value !== 'false';
}

export const seoInventoryEndpoint: Endpoint = {
  handler: async (req: PayloadRequest): Promise<Response> => {
    if (!req.user) {
      return Response.json(
        {
          errors: [
            {
              message:
                'Выгрузка доступна только аутентифицированному пользователю. Отчёт перечисляет ' +
                'записи во всех статусах и опрашивает сайт по каждому адресу — анонимный ' +
                'вызов был бы и раскрытием непубличных записей, и рычагом обхода сайта.',
            },
          ],
        },
        { status: 403 },
      );
    }

    const records = await collectInventoryRecords(req);
    const probe = shouldProbeSite(req.url ?? '/') ? fetchProbe() : null;
    const result = await buildInventoryCsv({ probe, records });

    for (const warning of result.warnings) {
      req.payload.logger.warn(`[seo-inventory] ${warning}`);
    }

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${SEO_INVENTORY_FILENAME}"`,
      'Content-Type': 'text/csv; charset=utf-8',
      // Отчёт со списком непубличных записей в индексе не нужен никому.
      'X-Robots-Tag': 'noindex',
    });
    if (result.warnings.length > 0) {
      // Заголовок HTTP допускает только ASCII, поэтому предупреждения кодируются.
      headers.set(SEO_INVENTORY_WARNINGS_HEADER, encodeURIComponent(result.warnings.join(' | ')));
    }
    return new Response(result.csv, { headers, status: 200 });
  },
  method: 'get',
  path: SEO_INVENTORY_PATH,
};
