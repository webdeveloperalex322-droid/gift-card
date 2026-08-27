/**
 * Требование (п. 22 + раздел «Изображения»): у каждого `<img>` есть `src`,
 * `width`, `height` и `alt`; первое крупное изображение — без `loading="lazy"`,
 * остальные с ним.
 *
 * Что именно проверяется и почему так:
 *
 *   - **`width` и `height` — числа.** Пара нужна не «для порядка»: по ней
 *     браузер резервирует место до загрузки файла, и её отсутствие даёт сдвиг
 *     макета (CLS < 0,1, раздел «Производительность»). Поэтому проверяется не
 *     наличие атрибута, а что в нём положительное число;
 *   - **`alt` присутствует.** Различие «атрибута нет» и «атрибут пуст»
 *     существенно: пустой `alt` — это заявление «изображение декоративное»
 *     (раздел «Изображения»), а отсутствие атрибута — незаполненное поле записи.
 *     Astro печатает пустое значение бескавычно (`<img … alt>`), и разбор
 *     приёмки эти состояния различает (`support/html.ts`, `attributesOf`).
 *     Отдельно требуется НЕПУСТОЙ `alt` у первого крупного изображения:
 *     открытка декоративным элементом не бывает;
 *   - **ровно одно изображение без `lazy`, и оно первое в документе.** Два
 *     неленивых изображения — это два кандидата на LCP, то есть гонка за канал
 *     на первом экране. «Первое в документе» проверяется отдельно: неленивым
 *     оказавшееся третьим изображение означает, что priority уехал не туда;
 *   - **`fetchpriority="high"` — не больше одного на страницу.** Он допустим у
 *     первого крупного изображения (раздел «Изображения»), но у второго
 *     отменяет смысл первого.
 *
 * Страницы без изображений (`images: 'none'` в инвентаре) проверяются обратным
 * утверждением — что `<img>` на них нет. Так spec не превращается в тавтологию:
 * без этого на странице-заглушке он «проходил» бы, не встретив ни одного тега, и
 * зелёный отчёт означал бы «требование выполнено», хотя проверять было нечего.
 * Появление изображения валит spec с требованием объявить страницу в инвентаре.
 *
 * ## Третье состояние: `images: 'data-driven'`
 *
 * Есть страницы, у которых состав изображений определяют ОПУБЛИКОВАННЫЕ ЗАПИСИ, а
 * не маршрут: главная печатает блок свежих открыток, только если открытки есть
 * (`apps/web/src/pages/index.astro` — блок без данных не печатается вовсе). Ни
 * `none`, ни `primary` такой странице не подходят: первое падало бы там, где база
 * наполнена, второе — там, где пуста, причём оба на ВЕРНОМ коде.
 *
 * Поблажкой это не является, потому что в обеих ветвях есть утверждение:
 *
 *   - изображения есть → работает весь контракт `primary` целиком;
 *   - изображений нет → на странице обязано не быть и ПЛИТОК. Плитка без `<img>`
 *     означает, что сетка напечаталась, а изображение потерялось на рендере, —
 *     то есть ровно ту поломку, которую иначе никто бы не заметил. Плитки
 *     считаются по классу `card-grid__item`; это КОНТРАКТ с
 *     `apps/web/src/components/CardGrid.astro`, и переименование класса обязано
 *     валить приёмку, а не тихо выключать проверку.
 *
 * Прогон на пустой выборке помечается аннотацией Playwright: в отчёте видно, что
 * контракт изображений на этой странице проверить было нечем. Молчаливого
 * прохождения не остаётся.
 */

import { expect, test } from '@playwright/test';

import { type ImageTag, imageTags } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Положительное целое в атрибуте размера либо `null`. */
function dimension(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : null;
}

function describe(image: ImageTag): string {
  return image.tag.length > 240 ? `${image.tag.slice(0, 240)}…` : image.tag;
}

/**
 * Сколько плиток сетки напечатал сервер.
 *
 * КОНТРАКТ с `apps/web/src/components/CardGrid.astro`: плитка — `<li>` с классом
 * `card-grid__item`. Считать плитки нужно ровно для одного утверждения — что при
 * отсутствии `<img>` на странице нет и плиток; иначе «сетка есть, изображения
 * пропали» выглядело бы как законная пустая выборка.
 */
function tileCount(html: string): number {
  return (html.match(/class="card-grid__item"/g) ?? []).length;
}

for (const page of ACCEPTANCE_PAGES) {
  test(`изображения: атрибуты и первый экран — ${page.path} (${page.task})`, async ({
    request,
  }, testInfo) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const images = imageTags(response.body);

    if (page.images === 'data-driven' && images.length === 0) {
      expect(
        tileCount(response.body),
        `На странице ${page.path} напечатаны плитки сетки, но ни одного <img> в ответе нет. ` +
          'Либо изображение потерялось на рендере плитки, либо оно дорисовывается JS (прямой ' +
          'запрет п. 23 ТЗ). Пустая выборка выглядит иначе: нет ни плиток, ни изображений.',
      ).toBe(0);
      testInfo.annotations.push({
        type: 'проверено нечем',
        description:
          `Страница ${page.path} объявлена как images: data-driven, и в этом прогоне сетка ` +
          'пуста — опубликованных открыток в базе нет. Контракт изображений (src, width, ' +
          'height, alt, единственное неленивое) на ней НЕ проверен: проверять было нечего. ' +
          'Полную силу утверждение получает на наполненном каталоге (Э3-13).',
      });
      return;
    }

    if (page.images === 'none') {
      expect(
        images.map(describe),
        `Инвентарь приёмки объявляет страницу ${page.path} без изображений, а в ответе они ` +
          'есть. Это не обязательно ошибка шаблона — но проверка контракта изображений ' +
          '(src/width/height/alt, единственное неленивое) для этой страницы ВЫКЛЮЧЕНА, пока ' +
          'она объявлена как `images: none`. Объявите её `images: primary` в ' +
          'tests/seo/support/pages.ts тем же коммитом, которым добавили изображение.',
      ).toEqual([]);
      return;
    }

    expect(
      images.length,
      `Инвентарь объявляет у ${page.path} первое крупное изображение, а в ответе сервера нет ` +
        'ни одного <img>. Либо изображение дорисовывается JS (прямой запрет п. 23 ТЗ), либо ' +
        'объявление устарело.',
    ).toBeGreaterThan(0);

    const withoutSrc = images.filter((image) => (image.src ?? '').trim() === '');
    expect(
      withoutSrc.map(describe),
      'У <img> обязан быть реальный src: изображение без него грузит только скрипт.',
    ).toEqual([]);

    const withoutSize = images.filter(
      (image) => dimension(image.width) === null || dimension(image.height) === null,
    );
    expect(
      withoutSize.map(describe),
      'У <img> обязательны width и height положительными числами: по ним резервируется место, ' +
        'и без них первый экран даёт сдвиг макета (CLS).',
    ).toEqual([]);

    const withoutAlt = images.filter((image) => image.alt === null);
    expect(
      withoutAlt.map(describe),
      'У <img> обязан быть атрибут alt. Пустой alt — законное заявление «изображение ' +
        'декоративное»; ОТСУТСТВИЕ атрибута — незаполненное описание в записи.',
    ).toEqual([]);

    // Позиции, а не сами теги: две плитки одной открытки дают ОДИНАКОВЫЕ строки
    // тега, и сравнение по строке склеило бы их в одну.
    const positions = images.map((image, index) => ({ image, index }));
    const eager = positions.filter(
      (entry) => (entry.image.loading ?? '').trim().toLowerCase() !== 'lazy',
    );
    expect(
      eager.map((entry) => describe(entry.image)),
      'Первое крупное изображение на странице ровно одно. Два изображения без ' +
        'loading="lazy" — два кандидата на LCP, то есть гонка за канал на первом экране.',
    ).toHaveLength(1);

    expect(
      eager[0]?.index,
      'Неленивым обязано быть ПЕРВОЕ изображение в документе. Если неленивое стоит ниже, ' +
        'значит priority передан не тому изображению, а верхнее грузится лениво на первом ' +
        'экране.',
    ).toBe(0);

    expect(
      (eager[0]?.image.alt ?? '').trim().length,
      'У первого крупного изображения alt обязан быть НЕПУСТЫМ: открытка декоративным ' +
        'элементом не бывает, а пустой alt заявляет обратное.',
    ).toBeGreaterThan(0);

    const highPriority = positions.filter((entry) => entry.image.fetchpriority === 'high');
    expect(
      highPriority.map((entry) => describe(entry.image)).slice(1),
      'fetchpriority="high" допустим у первого крупного изображения и только у него: у ' +
        'второго он отменяет смысл первого.',
    ).toEqual([]);
    if (highPriority.length === 1) {
      expect(
        highPriority[0]?.index,
        'fetchpriority="high" стоит не у первого крупного изображения.',
      ).toBe(0);
    }

    const wrongLazy = positions
      .filter((entry) => entry.index !== 0)
      .filter((entry) => (entry.image.loading ?? '').trim().toLowerCase() !== 'lazy');
    expect(
      wrongLazy.map((entry) => describe(entry.image)),
      'Все изображения, кроме первого крупного, обязаны иметь loading="lazy".',
    ).toEqual([]);
  });
}
