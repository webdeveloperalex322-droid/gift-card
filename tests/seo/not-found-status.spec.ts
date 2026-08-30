/**
 * Требование (п. 22 + таблица «HTTP-статусы»): несуществующий адрес отдаёт
 * НАСТОЯЩИЙ 404 — не 200 («soft 404») и не редирект на главную. Массовый
 * редирект удалённых страниц на главную запрещён прямо.
 *
 * Что проверяется сейчас: статус, отсутствие `Location` и отсутствие 200 на
 * заведомо несуществующих адресах разной глубины — включая адреса внутри
 * контейнеров `/otkrytki` и `/podborki`, где позже появятся настоящие маршруты.
 * Именно там soft 404 обычно и возникает: шаблон списка отвечает 200 с пустой
 * сеткой.
 *
 * Что НЕ проверяется здесь и указано в отчёте: «страница 404 содержит
 * навигацию» — своя страница 404 создаётся на Э3-11, сейчас отдаётся стандартная
 * страница Astro. Требование не отменено, оно не выполнено и не покрыто.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const MISSING_PATHS: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/takogo-razdela-net-e3-14', note: 'первый уровень' },
  { path: '/otkrytki/takoy-otkrytki-net-e3-14', note: 'адрес карточки в контейнере /otkrytki' },
  {
    path: '/podborki/prazdniki/takogo-prazdnika-net-e3-14',
    note: 'адрес праздничной посадочной в контейнере /podborki',
  },
  {
    path: '/podborki/prazdniki/8-marta/takogo-adresata-net-e3-14',
    note: 'пара «праздник × адресат», которой нет',
  },
];

for (const missing of MISSING_PATHS) {
  test(`настоящий 404 на несуществующем адресе: ${missing.path} (${missing.note})`, async ({
    request,
  }) => {
    const response = await fetchRaw(request, urlFor(target, missing.path));

    expect(
      response.status,
      `Несуществующий адрес обязан отдавать 404. Получено ${String(response.status)}` +
        `${response.location === null ? '' : ` Location: ${response.location}`}. ` +
        'Ответ 200 здесь — soft 404: поисковая система индексирует пустую страницу, ' +
        'а редирект на главную запрещён прямым запретом ТЗ.',
    ).toBe(404);

    expect(
      response.location,
      'У 404 не должно быть Location: массовый редирект удалённых страниц на главную запрещён.',
    ).toBeNull();
  });
}
