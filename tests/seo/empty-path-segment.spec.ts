/**
 * Требование («Правила URL»): у одного материала один путь, цепочек редиректов
 * нет. Отсюда — поведение на путях с ПУСТЫМ сегментом (`/otkrytki//8-marta`):
 * такой адрес не должен отдавать 200, иначе у страницы появляется второй адрес,
 * который никто не собирался создавать; и не должен давать цепочку.
 *
 * Spec намеренно требует не конкретный код, а два свойства: «не 200» и «не
 * больше одного перехода». Выбор между 404 и одиночным 301 — решение владельца
 * слоя (в `apps/web/src/routing/` оно принято в пользу 404 и там же обосновано:
 * Astro уже отдал 301 на форму без завершающего слеша, поэтому наш редирект на
 * схлопнутую форму стал бы вторым шагом). Аудитор проверяет требование, а не
 * реализацию: иначе осознанная смена решения ломала бы приёмку на верном коде.
 *
 * Отдельная строка — корень с двойным слешем (`//`). Он опасен не дублем, а
 * открытым редиректом: путь, начинающийся с `//`, браузер читает как адрес
 * ЧУЖОГО хоста, если такой путь попадёт в `Location`.
 */

import { expect, test } from '@playwright/test';

import { describeChain, followRedirects, hopCount } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const CASES: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/otkrytki//8-marta', note: 'пустой сегмент в середине пути карточки' },
  { path: '/podborki//prazdniki///8-marta/', note: 'несколько пустых сегментов и слеш в хвосте' },
];

for (const emptySegment of CASES) {
  test(`пустой сегмент не создаёт второго адреса: ${emptySegment.path} (${emptySegment.note})`, async ({
    request,
  }) => {
    const chain = await followRedirects(request, urlFor(target, emptySegment.path));
    const first = chain[0];
    const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

    // Проверяется ПЕРВЫЙ ответ: одиночный 301 в схлопнутую каноническую форму —
    // допустимая реализация, и 200 на канонической форме в конце такой цепочки
    // нарушением не является. Нарушение — 200 по самому адресу с пустым
    // сегментом: тогда у материала появляется второй адрес.
    expect(
      first?.status,
      `Адрес с пустым сегментом не должен отдавать страницу: это второй адрес одного ` +
        `материала.${context}`,
    ).not.toBe(200);
    expect(
      hopCount(chain),
      `Переходов не больше одного: цепочки редиректов запрещены.${context}`,
    ).toBeLessThanOrEqual(1);
  });
}

test('корень с двойным слешем: одиночный 301 на свой же хост, без открытого редиректа', async ({
  request,
}) => {
  const chain = await followRedirects(request, urlFor(target, '//'));
  const first = chain[0];
  const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

  expect(hopCount(chain), `Переход обязан быть один.${context}`).toBeLessThanOrEqual(1);

  if (first !== undefined && first.resolvedLocation !== null) {
    expect(
      new URL(first.resolvedLocation).origin,
      `Location обязан остаться на нашем хосте. Путь, начинающийся с «//», браузер читает ` +
        `как адрес чужого хоста — это открытый редирект.${context}`,
    ).toBe(target.origin);
  }

  expect(
    first === undefined || first.status === 200,
    `«//» не должен отдавать главную вторым адресом: либо одиночный 301 на «/», либо 404.` +
      context,
  ).toBe(false);
});
