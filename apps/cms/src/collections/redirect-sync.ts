import type { PayloadRequest } from 'payload';

import type { RedirectCode } from './redirects-plan';

/**
 * Приведение таблицы редиректов в соответствие с судьбой URL (задачи Э1-08 и
 * Э1-09): тонкий слой над коллекцией `redirects`.
 *
 * Правила самой таблицы (уникальность `from`, запрет петель, схлопывание
 * цепочек) здесь НЕ повторяются: они живут в `redirects-plan.ts` и применяются
 * хуком коллекции `redirects`. Этот модуль только вызывает штатные операции
 * Payload, поэтому любой созданный им редирект проходит те же проверки, что
 * созданный руками в админке. Второго пути записи в таблицу не существует —
 * иначе схлопывание цепочек можно было бы обойти изнутри.
 *
 * Все операции выполняются с переданным `req`, то есть в ТОЙ ЖЕ транзакции, что
 * и правка записи контента. Это и есть атомарность «смена URL + одиночный 301»:
 * либо переехал путь и появился редирект, либо не произошло ничего. Состояние
 * «URL сменился, редиректа нет» краулер успел бы увидеть, и оно необратимо.
 */

export type RedirectSyncOutcome = 'created' | 'unchanged' | 'updated';

interface RedirectRow {
  readonly code: string;
  readonly id: number | string;
  readonly to?: string | null;
}

async function findRedirectFrom(
  req: PayloadRequest,
  from: string,
): Promise<RedirectRow | undefined> {
  const found = await req.payload.find({
    collection: 'redirects',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { from: { equals: from } },
  });
  return found.docs[0];
}

/**
 * Гарантирует, что со `from` стоит ровно ОДИН редирект с заданной целью.
 *
 * Существующее правило переписывается, а не дублируется: два правила для одного
 * пути делают ответ сайта зависимым от порядка строк, а `from` в коллекции
 * уникален — попытка создать второе завершилась бы отказом посреди операции.
 */
export async function ensureSingleRedirect(args: {
  readonly code: RedirectCode;
  readonly comment: string;
  readonly from: string;
  readonly req: PayloadRequest;
  readonly to: string | null;
}): Promise<RedirectSyncOutcome> {
  const { code, comment, from, req, to } = args;

  const existing = await findRedirectFrom(req, from);

  if (existing === undefined) {
    await req.payload.create({
      collection: 'redirects',
      data: { code, comment, from, to },
      overrideAccess: true,
      req,
    });
    return 'created';
  }

  if (existing.code === code && (existing.to ?? null) === to) {
    return 'unchanged';
  }

  await req.payload.update({
    collection: 'redirects',
    id: existing.id,
    data: { code, comment, to },
    overrideAccess: true,
    req,
  });
  return 'updated';
}

/**
 * Убирает редиректы, ведущие С этого пути.
 *
 * Нужно при публикации и при переезде НА путь, с которого раньше был редирект:
 * страница по такому адресу отдавала бы 200, а middleware всё равно уводило бы
 * с неё запрос по старому правилу. То есть живая страница была бы недостижима, и
 * причина была бы не видна ни в записи, ни в шаблоне.
 *
 * @returns сколько правил снято
 */
export async function releaseRedirectsFrom(args: {
  readonly path: string;
  readonly req: PayloadRequest;
}): Promise<number> {
  const { path, req } = args;

  const existing = await findRedirectFrom(req, path);
  if (existing === undefined) {
    return 0;
  }

  await req.payload.delete({
    collection: 'redirects',
    id: existing.id,
    overrideAccess: true,
    req,
  });

  req.payload.logger.warn(
    `[redirects] Снято правило с «${path}»: по этому пути снова отвечает страница. ` +
      'Редирект с пути живой страницы сделал бы её недостижимой.',
  );

  return 1;
}
