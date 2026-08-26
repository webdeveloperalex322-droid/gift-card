/**
 * Страница карточки: разметка `WebPage` + `ImageObject`, заголовок записи,
 * ссылки «поделиться» и канонический путь (задача Э3-05).
 *
 * Норма — ТЗ §5.4 (состав разметки), `CLAUDE.md`, раздел «Структурированные
 * данные» («разметка соответствует видимому содержимому; фиктивные отзывы,
 * рейтинги и авторы запрещены»), решение Ч-10 (лицензионные поля — целиком или
 * никак; указание на ИИ — видимой подписью, а не свойством разметки).
 *
 * Проверяется ЧИСТАЯ часть. Шаблон `apps/web/src/pages/otkrytki/[slug].astro`
 * поверх неё только печатает разметку и вызывает эти же функции, а чтение записи
 * лежит в `apps/web/src/data/page-data.ts` и проверяется рядом с ним
 * (`page-data.test.ts`) — там нужны сгенерированные типы Payload.
 *
 * Хост в фикстуре синтетический: значения по умолчанию у `SITE_URL` в коде нет и
 * быть не может, а сборку абсолютного адреса проверить надо.
 */
import { describe, expect, it } from 'vitest';

import {
  type CardImageFacts,
  type CardPageJsonLdInput,
  cardPageJsonLd,
} from '../../apps/web/src/seo/card-page.js';
import { recordHeading } from '../../apps/web/src/seo/headings.js';
import { jsonLdScriptText } from '../../apps/web/src/seo/json-ld.js';
import { SHARE_SERVICES, shareTargets } from '../../apps/web/src/seo/share.js';
import { canonicalPathFor, canonicalUrlFor } from '../../apps/web/src/routing/canonical.js';

const ENV = { SITE_URL: 'https://otkrytki.test' } as const;

const HEADING = 'Открытка маме на 8 Марта с тюльпанами';
const ALT = 'Букет розовых тюльпанов и рукописная надпись «С 8 Марта, мама»';

/** Резервная производная — ровно та, что стоит в `<img src>`. */
const FALLBACK = {
  key: 'cards/a1b2c3d4/otkrytka-mame-na-8-marta-1280.jpg',
  format: 'jpeg' as const,
  width: 1280,
  height: 1600,
};

const IMAGE: CardImageFacts = {
  variant: FALLBACK,
  name: HEADING,
  description: ALT,
  caption: 'С 8 Марта, мама!',
};

const LICENSE = {
  creator: 'Проект «Открытки»',
  creditText: 'Изображение проекта «Открытки», создано нейросетью',
  copyrightNotice: '© Проект «Открытки»',
  license: '/usloviya',
  acquireLicensePage: '/usloviya',
} as const;

const INPUT: CardPageJsonLdInput = {
  canonicalPath: '/otkrytki/otkrytka-mame-na-8-marta',
  heading: HEADING,
  description: 'Открытка маме на 8 Марта: тюльпаны и тёплое поздравление.',
  image: IMAGE,
  license: null,
};

function graphOf(input: CardPageJsonLdInput): {
  page: ReturnType<typeof cardPageJsonLd>['@graph'][0];
  image: ReturnType<typeof cardPageJsonLd>['@graph'][1];
} {
  const [page, image] = cardPageJsonLd(input, ENV)['@graph'];
  return { image, page };
}

describe('заголовок записи', () => {
  it('H1 сильнее title, а пустой H1 означает «совпадает с title»', () => {
    expect(recordHeading({ title: 'Заголовок для title', h1: 'Заголовок для H1' })).toBe(
      'Заголовок для H1',
    );
    expect(recordHeading({ title: 'Только title' })).toBe('Только title');
    expect(recordHeading({ title: 'Только title', h1: null })).toBe('Только title');
    expect(recordHeading({ title: 'Только title', h1: '   ' })).toBe('Только title');
  });

  it('пустые оба поля — отказ, а не пустой H1', () => {
    // Пустой `<h1></h1>` выглядит исправной разметкой и проваливает п. 22.2
    // молча; отказ показывает причину сразу.
    expect(() => recordHeading({ title: '  ', h1: '' })).toThrow(/H1/);
  });
});

describe('канонический путь записи', () => {
  it('пустое поле canonical означает self-canonical', () => {
    expect(canonicalPathFor(null, '/otkrytki/8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalPathFor('', '/otkrytki/8-marta')).toBe('/otkrytki/8-marta');
    expect(canonicalPathFor('   ', '/otkrytki/8-marta')).toBe('/otkrytki/8-marta');
  });

  it('переопределение администратора действует и приводится к канонической форме', () => {
    // Поле, которое шаблон не читает, делает решение администратора молча
    // недействующим: в админке значение есть, в разметке его нет.
    expect(canonicalPathFor('/podborki/prazdniki/8-marta/', '/otkrytki/8-marta')).toBe(
      '/podborki/prazdniki/8-marta',
    );
  });

  it('абсолютный адрес в поле отклоняется, а не превращается в путь', () => {
    // canonicalizePath сам по себе схлопнул бы чужой хост в правдоподобный путь
    // `/https:/chuzhoy.test/x` — то есть в canonical на несуществующую страницу.
    expect(() => canonicalPathFor('https://chuzhoy.test/x', '/otkrytki/8-marta')).toThrow(
      /SITE_URL/,
    );
    expect(() => canonicalPathFor('//chuzhoy.test/x', '/otkrytki/8-marta')).toThrow(/SITE_URL/);
  });

  it('сборка абсолютного canonical тоже отклоняет чужой хост, а не схлопывает его', () => {
    // Найдено этой задачей: до неё `canonicalUrlFor` отдавал
    // `https://otkrytki.test/https:/chuzhoy.test/x` — правдоподобный canonical на
    // несуществующую страницу СВОЕГО хоста. `buildAbsoluteUrl` такой вход
    // отвергает, но до него он не доходил: `canonicalizePath` успевал сделать его
    // безобидным с виду.
    expect(() => canonicalUrlFor('https://chuzhoy.test/x', ENV)).toThrow(/SITE_URL/);
    expect(() => canonicalUrlFor('//chuzhoy.test/x', ENV)).toThrow(/SITE_URL/);
    expect(canonicalUrlFor('/otkrytki/8-marta/', ENV)).toBe(`${ENV.SITE_URL}/otkrytki/8-marta`);
  });
});

describe('разметка страницы карточки', () => {
  it('в графе ровно два узла: WebPage и ImageObject', () => {
    const jsonLd = cardPageJsonLd(INPUT, ENV);

    expect(jsonLd['@context']).toBe('https://schema.org');
    expect(jsonLd['@graph'].map((node) => node['@type'])).toEqual(['WebPage', 'ImageObject']);
  });

  it('url страницы абсолютный и совпадает с каноническим путём', () => {
    const { page } = graphOf(INPUT);

    expect(page.url).toBe(`${ENV.SITE_URL}/otkrytki/otkrytka-mame-na-8-marta`);
  });

  it('contentUrl указывает на ТОТ файл, который страница показывает', () => {
    // Резервная производная одна и та же в `<img src>`, в кнопке «Скачать» и
    // здесь: иначе разметка описывает файл, которого на странице нет.
    const { image, page } = graphOf(INPUT);

    expect(image.contentUrl).toBe(`${ENV.SITE_URL}/media/${FALLBACK.key}`);
    expect(image.width).toBe(FALLBACK.width);
    expect(image.height).toBe(FALLBACK.height);
    expect(page.primaryImageOfPage['@id']).toBe(image['@id']);
    expect(image['@id']).toBe(image.contentUrl);
  });

  it('видимые значения переносятся как есть: заголовок, описание, подпись', () => {
    const { image, page } = graphOf(INPUT);

    expect(page.name).toBe(HEADING);
    expect(page.description).toBe(INPUT.description);
    expect(image.name).toBe(HEADING);
    expect(image.description).toBe(ALT);
    expect(image.caption).toBe('С 8 Марта, мама!');
  });

  it('незаполненные необязательные значения не дают пустых свойств', () => {
    const { image, page } = graphOf({
      ...INPUT,
      description: '   ',
      image: { ...IMAGE, caption: null },
    });

    expect('description' in page).toBe(false);
    expect('caption' in image).toBe(false);
  });

  it('пустое обязательное значение — отказ, а не пустое свойство', () => {
    expect(() => cardPageJsonLd({ ...INPUT, heading: ' ' }, ENV)).toThrow(/WebPage.name/);
    expect(() =>
      cardPageJsonLd({ ...INPUT, image: { ...IMAGE, description: '' } }, ENV),
    ).toThrow(/ImageObject.description/);
  });
});

describe('лицензионная часть ImageObject (решение Ч-10)', () => {
  it('при незаполненном глобале лицензионных свойств нет ВОВСЕ', () => {
    const { image } = graphOf({ ...INPUT, license: null });

    for (const property of [
      'creator',
      'creditText',
      'copyrightNotice',
      'license',
      'acquireLicensePage',
    ]) {
      expect(property in image).toBe(false);
    }
  });

  it('заполненный набор выводится целиком, а пути становятся абсолютными', () => {
    const { image } = graphOf({ ...INPUT, license: LICENSE });

    expect(image.creator).toBe(LICENSE.creator);
    expect(image.creditText).toBe(LICENSE.creditText);
    expect(image.copyrightNotice).toBe(LICENSE.copyrightNotice);
    expect(image.license).toBe(`${ENV.SITE_URL}/usloviya`);
    expect(image.acquireLicensePage).toBe(`${ENV.SITE_URL}/usloviya`);
  });

  it('свойства с придуманным смыслом в разметке отсутствуют', () => {
    // Указание на генерацию ИИ выводится видимой подписью (Ч-10): свойства с
    // таким смыслом в schema.org нет. Фиктивных авторов, отзывов и рейтингов
    // тоже нет — прямой запрет п. 23.10.
    const text = jsonLdScriptText(cardPageJsonLd({ ...INPUT, license: LICENSE }, ENV));

    for (const forbidden of ['aiDisclosure', 'aggregateRating', 'review', 'author', 'ratingValue']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('текст блока ld+json', () => {
  it('распарсенный результат тождественно равен объекту', () => {
    const jsonLd = cardPageJsonLd(INPUT, ENV);

    expect(JSON.parse(jsonLdScriptText(jsonLd))).toEqual(jsonLd);
  });

  it('последовательность </script> в тексте записи тег не закрывает', () => {
    const text = jsonLdScriptText(
      cardPageJsonLd(
        { ...INPUT, heading: 'Открытка </script><script>alert(1)</script>' },
        ENV,
      ),
    );

    expect(text).not.toContain('</script>');
    expect(text).not.toContain('<script');
  });
});

describe('ссылки «поделиться» (ТЗ §5.4)', () => {
  const PAGE_URL = `${ENV.SITE_URL}/otkrytki/otkrytka-mame-na-8-marta`;

  it('четыре сервиса из ТЗ, в порядке из ТЗ', () => {
    const targets = shareTargets({ title: HEADING, url: PAGE_URL });

    expect(targets.map((target) => target.service)).toEqual([...SHARE_SERVICES]);
    expect(targets.map((target) => target.service)).toEqual([
      'whatsapp',
      'telegram',
      'vk',
      'odnoklassniki',
    ]);
  });

  it('каждая ссылка — абсолютный адрес share-эндпоинта, без ключей и SDK', () => {
    for (const target of shareTargets({ title: HEADING, url: PAGE_URL })) {
      expect(target.href.startsWith('https://')).toBe(true);
      expect(target.label.length).toBeGreaterThan(0);
    }
  });

  it('адрес и заголовок кодируются: «&» в заголовке не ломает второй параметр', () => {
    const targets = shareTargets({ title: 'Открытка «мама & дочь»', url: `${PAGE_URL}` });
    const telegram = targets.find((target) => target.service === 'telegram');

    expect(telegram?.href).toContain(`url=${encodeURIComponent(PAGE_URL)}`);
    expect(telegram?.href).toContain(encodeURIComponent('мама & дочь'));
    expect(telegram?.href).not.toContain('мама & дочь');
  });

  it('относительный путь и пустой заголовок отклоняются', () => {
    // Относительный путь сервис открыл бы на СВОЁМ хосте, а пустой заголовок
    // превратил бы сообщение в один адрес.
    expect(() => shareTargets({ title: HEADING, url: '/otkrytki/8-marta' })).toThrow(/SITE_URL/);
    expect(() => shareTargets({ title: '  ', url: PAGE_URL })).toThrow(/аголовок/);
  });
});
