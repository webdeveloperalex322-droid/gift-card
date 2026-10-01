/**
 * Требование (решение Ч-05 и решение задачи Э3-07): адресом страницы списка
 * является ТОЛЬКО канонический номер от 2. Всё остальное — `0`, ведущий нуль,
 * знак, дробь, слово, номер за пределами списка, второй уровень пагинации — не
 * адрес и отвечает 404.
 *
 * Почему именно 404, а не редирект на базовый URL: неканонических записей номера
 * бесконечно много (`/page/01`, `/page/001`, `/page/0001`), и 301 с каждой из них
 * означал бы, что краулер получил повод обойти их все, а сайт — что у него
 * бесконечное семейство «существующих» адресов. И не 200 с пустой сеткой: пустая
 * страница не отдаёт 200 (ТЗ §5.3).
 *
 * `/page/1` не входит в матрицу неканонических номеров: его отдельный
 * условный контракт «301 только на базу с 200, иначе 404» проверяет
 * `pagination-page-one-conditional.spec.ts`.
 *
 * Проверяемые здесь адреса от базы НЕ зависят: форма номера разбирается ДО
 * запроса к базе, а номер за пределами списка отвечает 404 и на пустом, и на
 * наполненном каталоге.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const NOT_ADDRESSES: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/otkrytki/page/0', note: 'нулевая страница' },
  { path: '/otkrytki/page/01', note: 'ведущий нуль — второй адрес первой страницы' },
  { path: '/otkrytki/page/-1', note: 'знак' },
  { path: '/otkrytki/page/1.5', note: 'дробь' },
  { path: '/otkrytki/page/dva', note: 'слово вместо номера' },
  { path: '/otkrytki/page/999999999999', note: 'номер за пределами списка' },
  { path: '/otkrytki/page', note: 'сегмент пагинации без номера' },
  { path: '/otkrytki/page/2/page/2', note: 'второй уровень пагинации' },
  { path: '/otkrytki/page/%31', note: 'процентно-кодированный псевдоним номера' },
];

for (const address of NOT_ADDRESSES) {
  test(`не адрес страницы — 404: ${address.path} (${address.note})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, address.path));

    expect(
      response.status,
      `«${address.path}» адресом страницы списка не является и обязан отдавать 404, получено ` +
        `${String(response.status)}. Ответ 200 означал бы пустую страницу с полноценным ` +
        'статусом, а 301 — что бесконечное множество неканонических номеров ведёт в один ' +
        'адрес, и краулер получил повод обойти их все.',
    ).toBe(404);

    expect(
      response.location,
      `У «${address.path}» не должно быть Location: редирект здесь создаёт семейство адресов, ` +
        'каждый из которых «почти существует».',
    ).toBeNull();
  });
}
