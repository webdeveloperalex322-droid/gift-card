/**
 * HTTP-примитивы приёмки: один запрос БЕЗ автоматического перехода и подсчёт
 * цепочки переходов.
 *
 * Автоматический переход по редиректу здесь запрещён во всех запросах, и это
 * главное требование к слою: половина проверок п. 22 — про сам ответ (301 или
 * 404, значение `Location`, отсутствие второго шага). Клиент, который тихо
 * следует за редиректом, показывает конечную страницу и скрывает ровно то, что
 * проверяется. Поэтому единственная точка входа — {@link fetchRaw}, и
 * `maxRedirects: 0` задаётся в ней, а не в каждом spec'е.
 */

import type { APIRequestContext } from '@playwright/test';

/** Ответ сервера в виде, пригодном для утверждений: без переходов и без разбора. */
export interface RawResponse {
  /** Абсолютный URL, который запрашивали. */
  readonly requestedUrl: string;
  readonly status: number;
  /** Значение `Location` как его отдал сервер (может быть относительным). */
  readonly location: string | null;
  /** `Location`, приведённый к абсолютному виду, либо `null`. */
  readonly resolvedLocation: string | null;
  readonly contentType: string | null;
  /**
   * Все заголовки ответа, имена в нижнем регистре.
   *
   * Нужны, потому что часть требований — про ЗАГОЛОВОК, а не про тело:
   * `Retry-After` при 503 (таблица «HTTP-статусы»), `Cache-Control` у производных
   * изображений (решение Ч-03), `X-Robots-Tag` у админки и стенда (Ч-18, Ч-22).
   * Отдельного примитива под каждый заголовок здесь нет намеренно: это один и тот
   * же ответ, и spec обязан читать его целиком.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Коды, которые считаются переходом. Ровно они и запрещены в цепочке. */
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

export function isRedirect(status: number): boolean {
  return (REDIRECT_STATUSES as readonly number[]).includes(status);
}

/** Один запрос без перехода по `Location`. */
export async function fetchRaw(
  request: APIRequestContext,
  absoluteUrl: string,
): Promise<RawResponse> {
  const response = await request.fetch(absoluteUrl, {
    maxRedirects: 0,
    failOnStatusCode: false,
    // Приёмка обязана видеть ответ, а не кеш прокси или свой прошлый запрос.
    headers: { 'cache-control': 'no-cache' },
  });
  const headers = response.headers();
  const location = headers['location'] ?? null;

  return {
    requestedUrl: absoluteUrl,
    status: response.status(),
    headers,
    location,
    resolvedLocation: location === null ? null : new URL(location, absoluteUrl).toString(),
    contentType: headers['content-type'] ?? null,
    body: await response.text(),
  };
}

/**
 * Проходит цепочку переходов вручную и возвращает ВСЕ ответы: первый элемент —
 * ответ на запрошенный URL, последний — первый ответ, который переходом не
 * является.
 *
 * Длина цепочки считается по числу элементов со статусом-переходом. Требование
 * «одиночный 301, цепочки запрещены» (`CLAUDE.md`, «Правила URL» и
 * «HTTP-статусы») формулируется как «ровно один такой элемент».
 *
 * @param maxHops страховка от бесконечной петли; превышение — не исключение, а
 *   возвращённая цепочка длиннее допустимой, чтобы spec упал со внятным
 *   сообщением, а не с таймаутом.
 */
export async function followRedirects(
  request: APIRequestContext,
  absoluteUrl: string,
  maxHops = 5,
): Promise<RawResponse[]> {
  const chain: RawResponse[] = [];
  let next = absoluteUrl;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetchRaw(request, next);
    chain.push(response);
    if (!isRedirect(response.status) || response.resolvedLocation === null) {
      return chain;
    }
    next = response.resolvedLocation;
  }

  return chain;
}

/** Число переходов в цепочке. */
export function hopCount(chain: readonly RawResponse[]): number {
  return chain.filter((response) => isRedirect(response.status)).length;
}

/** Компактное описание цепочки для сообщения об ошибке. */
export function describeChain(chain: readonly RawResponse[]): string {
  return chain
    .map(
      (response) =>
        `${response.requestedUrl} -> ${String(response.status)}` +
        (response.location === null ? '' : ` Location: ${response.location}`),
    )
    .join('\n    ');
}
