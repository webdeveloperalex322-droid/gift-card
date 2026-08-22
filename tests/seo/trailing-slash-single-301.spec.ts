/**
 * Требование (решение Ч-21 + «HTTP-статусы»): канонический вид маршрута
 * страницы — БЕЗ завершающего слеша; обращение со слешем отдаёт ОДИНОЧНЫЙ 301 на
 * форму без слеша. Цепочки редиректов запрещены.
 *
 * Проверяется три вещи, и каждая — отдельным утверждением, чтобы падение
 * называло нарушение:
 *   1. статус ровно 301 (не 302 и не 308: 302 оставляет обе формы живыми в
 *      глазах поисковой системы, то есть дубль);
 *   2. `Location` ведёт точно в каноническую форму, вместе с query-строкой:
 *      потерянные параметры — это потерянный переход, а не косметика;
 *   3. переход ровно один — цель редиректа сама не отвечает 3xx.
 *
 * Про статус ЦЕЛИ: 200 здесь не проверяется и проверяться не может.
 * Контентных маршрутов ещё нет (`/otkrytki`, `/podborki` — задачи Э3-05…Э3-11,
 * массовое создание URL до готовности контента запрещено п. 23 ТЗ), поэтому по
 * каноническому адресу сервер честно отвечает 404. Проверяемое здесь требование
 * — отсутствие ВТОРОГО перехода; статус 200 на этих адресах проверит spec тех
 * задач, когда страницы появятся.
 */

import { expect, test } from '@playwright/test';

import { describeChain, followRedirects, hopCount, isRedirect } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

interface SlashCase {
  /** Запрашиваемый путь вместе с query, если она есть. */
  readonly requested: string;
  /** Ожидаемое значение `Location`, приведённое к абсолютному виду. */
  readonly expectedTarget: string;
  readonly note: string;
}

const CASES: readonly SlashCase[] = [
  {
    requested: '/otkrytki/8-marta/',
    expectedTarget: '/otkrytki/8-marta',
    note: 'маршрут карточки',
  },
  {
    requested: '/podborki/prazdniki/8-marta/',
    expectedTarget: '/podborki/prazdniki/8-marta',
    note: 'праздничная посадочная в контейнере /podborki',
  },
  {
    requested: '/podborki/prazdniki/8-marta/mame/',
    expectedTarget: '/podborki/prazdniki/8-marta/mame',
    note: 'пара «праздник × адресат» (порядок сегментов «повод → уточнение»)',
  },
  {
    requested: '/podborki/adresaty/mame/page/2/',
    expectedTarget: '/podborki/adresaty/mame/page/2',
    note: 'пагинация сегментом пути',
  },
  {
    requested: '/otkrytki//',
    expectedTarget: '/otkrytki',
    note: 'повторный слеш в хвосте — один переход сразу в каноническую форму, а не два',
  },
  {
    requested: '/otkrytki/8-marta/?utm_source=test&from=vk',
    expectedTarget: '/otkrytki/8-marta?utm_source=test&from=vk',
    note: 'query сохраняется при нормализации пути',
  },
];

for (const slashCase of CASES) {
  test(`одиночный 301 без цепочки: ${slashCase.requested} (${slashCase.note})`, async ({
    request,
  }) => {
    const chain = await followRedirects(request, urlFor(target, slashCase.requested));
    const first = chain[0];
    const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

    expect(first, 'Ответа на запрос нет вовсе.').toBeDefined();
    expect(
      first?.status,
      `Обращение со завершающим слешем обязано давать ровно 301 (решение Ч-21).${context}`,
    ).toBe(301);
    expect(
      first?.resolvedLocation,
      `Location обязан указывать точно в каноническую форму.${context}`,
    ).toBe(urlFor(target, slashCase.expectedTarget));
    expect(
      hopCount(chain),
      `Переход обязан быть один. Цепочка редиректов запрещена («Правила URL»).${context}`,
    ).toBe(1);

    const last = chain[chain.length - 1];
    expect(
      last === undefined ? true : isRedirect(last.status),
      `Цель редиректа сама отвечает переходом — это цепочка.${context}`,
    ).toBe(false);
  });
}

test('корень сайта — единственный адрес со слешем, и он не редиректит', async ({ request }) => {
  const chain = await followRedirects(request, urlFor(target, '/'));

  expect(
    hopCount(chain),
    `Корень обязан отдавать страницу, а не переход.\n  Цепочка:\n    ${describeChain(chain)}`,
  ).toBe(0);
  expect(chain[0]?.status, 'Корень обязан отдавать 200.').toBe(200);
});
