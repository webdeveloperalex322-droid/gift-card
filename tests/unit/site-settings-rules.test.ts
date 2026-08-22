/**
 * Правила настроек сайта (задача Э3-00): предикаты «выводить или промолчать».
 *
 * Негативные проверки здесь важнее позитивных. Каждое из четырёх решений
 * человека — Ч-17 (Organization), Ч-10 (лицензия), Ч-19/Ч-23 (служебные
 * страницы), Ч-11 (рекламные места) — формулирует одно и то же требование:
 * НЕзаполненное поле обязано давать молчание, а не правдоподобную заглушку.
 * Значит проверять нужно прежде всего пустой и полупустой вход: именно на нём
 * рождается фиктивная разметка, запрещённая п. 23 ТЗ.
 *
 * Тестируются чистые функции без Payload и без базы: ровно они — единственная
 * трактовка этих решений и для `apps/cms`, и для `apps/web`. Модуль живёт в
 * `packages/shared`, поэтому и тест лежит здесь: юнит-тесты общих пакетов
 * собраны в `tests/unit/` (composite-проект `tests/tsconfig.json`), а рядом с
 * кодом тесты держит только `apps/cms`, который в этот проект не входит.
 */
import { describe, expect, it } from 'vitest';

import {
  AD_SLOT_POSITIONS,
  INFO_PAGE_INDEXING_FIELD,
  INFO_PAGE_KEYS,
  INFO_PAGE_MIN_TEXT_LENGTH,
  INFO_PAGE_PATHS,
  type InfoPageFacts,
  MAX_AD_SLOTS_PER_POSITION,
  SITE_SETTINGS_SLUG,
  aiDisclosureText,
  imageLicenseGaps,
  imageLicenseJsonLd,
  infoPageIndexation,
  isAdSlotRenderable,
  isImageLicenseComplete,
  isInfoPageIndexable,
  isOrganizationJsonLdRendered,
  isReservedPath,
  organizationJsonLd,
  organizationJsonLdGaps,
  renderableAdSlots,
  richTextPlainText,
  validateAdSlotRows,
  validateSiteRootPath,
} from '@otkritka/shared';

/** Лексический документ с заданным текстом — форма, которую пишет richText. */
function richText(...paragraphs: readonly string[]): unknown {
  return {
    root: {
      type: 'root',
      children: paragraphs.map((text) => ({
        type: 'paragraph',
        children: [{ type: 'text', text, version: 1 }],
        version: 1,
      })),
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  };
}

const longText = 'Проект собирает поздравительные открытки. '.repeat(20);

describe('слаг глобала', () => {
  it('объявлен один раз и совпадает с адресом REST/GraphQL', () => {
    // apps/web читает глобал по этому же значению: второй литерал в шаблоне
    // означал бы, что переименование глобала ломает страницу молча.
    expect(SITE_SETTINGS_SLUG).toBe('site-settings');
  });
});

describe('Ч-17: JSON-LD Organization выводится только по заполненным данным', () => {
  it('пустой глобал — блока нет, а не блок с пустыми значениями', () => {
    expect(isOrganizationJsonLdRendered({})).toBe(false);
    expect(organizationJsonLd({})).toBeNull();
    expect(organizationJsonLdGaps({})).toEqual(['name', 'logo']);
  });

  it('пробелы — это пусто: заглушка из пробелов блок не открывает', () => {
    expect(isOrganizationJsonLdRendered({ name: '   ', logo: '\t' })).toBe(false);
  });

  it('без логотипа блок молчит и называет причину', () => {
    expect(organizationJsonLdGaps({ name: 'Открытки' })).toEqual(['logo']);
    expect(organizationJsonLd({ name: 'Открытки' })).toBeNull();
  });

  it('заполненный минимум даёт блок; незаполненные поля в него не попадают', () => {
    const jsonLd = organizationJsonLd({ name: 'Открытки', logo: '/media/site/logo.svg' });
    // Ключей email/telephone/legalName/sameAs нет вовсе — ни пустыми строками,
    // ни пустым массивом: пустое свойство в разметке и есть то фиктивное
    // значение, которое запрещает п. 23 ТЗ.
    expect(jsonLd).toEqual({ logo: '/media/site/logo.svg', name: 'Открытки' });
  });

  it('необязательные поля добавляются по одному, по факту заполнения', () => {
    const jsonLd = organizationJsonLd({
      name: '  Открытки  ',
      logo: '/media/site/logo.svg',
      legalName: 'ООО «Открытки»',
      email: '',
      telephone: '+7 000 000-00-00',
      sameAs: [{ url: 'https://vk.com/otkritka' }, { url: '  ' }, null],
    });
    expect(jsonLd).toEqual({
      legalName: 'ООО «Открытки»',
      logo: '/media/site/logo.svg',
      name: 'Открытки',
      sameAs: ['https://vk.com/otkritka'],
      telephone: '+7 000 000-00-00',
    });
  });
});

describe('Ч-10: лицензионные поля карточки', () => {
  const complete = {
    creator: 'Проект «Открытки»',
    creditText: 'otkritka',
    copyrightNotice: '© Проект «Открытки»',
    license: '/usloviya',
    acquireLicensePage: '/usloviya',
  } as const;

  it('пустой глобал — блока ImageObject-лицензии нет', () => {
    expect(isImageLicenseComplete({})).toBe(false);
    expect(imageLicenseJsonLd({})).toBeNull();
    expect(imageLicenseGaps({})).toEqual([
      'creator',
      'creditText',
      'copyrightNotice',
      'license',
      'acquireLicensePage',
    ]);
  });

  it('одного незаполненного поля достаточно, чтобы блок промолчал', () => {
    // Частично заполненная лицензия хуже отсутствующей: она выглядит
    // юридически значимой, не будучи ею.
    expect(imageLicenseGaps({ ...complete, copyrightNotice: '  ' })).toEqual(['copyrightNotice']);
    expect(imageLicenseJsonLd({ ...complete, license: null })).toBeNull();
  });

  it('полный набор даёт блок с обрезанными значениями', () => {
    expect(imageLicenseJsonLd({ ...complete, creator: ' Проект «Открытки» ' })).toEqual({
      acquireLicensePage: '/usloviya',
      copyrightNotice: '© Проект «Открытки»',
      creator: 'Проект «Открытки»',
      creditText: 'otkritka',
      license: '/usloviya',
    });
  });

  it('указание на генерацию ИИ — отдельный видимый текст, не часть JSON-LD', () => {
    expect(aiDisclosureText({})).toBeNull();
    expect(aiDisclosureText({ aiDisclosure: '   ' })).toBeNull();
    expect(aiDisclosureText({ aiDisclosure: ' Изображение создано нейросетью. ' })).toBe(
      'Изображение создано нейросетью.',
    );
    const jsonLd = imageLicenseJsonLd({ ...complete, aiDisclosure: 'Создано нейросетью' });
    expect(jsonLd === null ? [] : Object.keys(jsonLd)).not.toContain('aiDisclosure');
  });
});

describe('richTextPlainText: сколько на странице реального текста', () => {
  it('пустой и не-лексический вход дают пустую строку', () => {
    expect(richTextPlainText(undefined)).toBe('');
    expect(richTextPlainText(null)).toBe('');
    expect(richTextPlainText('строка вместо документа')).toBe('');
    expect(richTextPlainText(richText(''))).toBe('');
  });

  it('текст собирается из вложенных узлов и схлопывает пробелы', () => {
    expect(richTextPlainText(richText('О проекте.', '  Мы собираем   открытки.'))).toBe(
      'О проекте. Мы собираем открытки.',
    );
  });
});

describe('Ч-19 и Ч-23: индексируемость служебной страницы — решение плюс наполненность', () => {
  /** Полностью наполненная страница БЕЗ решения человека об индексации. */
  const filledContent = {
    title: 'Условия использования',
    h1: 'Условия использования',
    metaDescription: 'Как можно использовать открытки проекта',
    body: richText(longText),
  } as const;

  it('пути страниц совпадают с реестром зарезервированных маршрутов', () => {
    // Реестр в packages/shared — единственный машинный источник путей. Эта
    // проверка связывает две записи об одном факте: расхождение обязано падать
    // тестом, а не жить как страница без маршрута.
    for (const key of INFO_PAGE_KEYS) {
      expect(isReservedPath(INFO_PAGE_PATHS[key], { PAYLOAD_ADMIN_PATH: '/admin' })).toBe(true);
    }
    expect(Object.values(INFO_PAGE_PATHS)).toEqual(['/o-proekte', '/usloviya', '/kontakty']);
  });

  it('пустая страница остаётся noindex и вне sitemap', () => {
    expect(isInfoPageIndexable({})).toBe(false);
    expect(infoPageIndexation({})).toEqual({
      approved: false,
      gaps: ['title', 'metaDescription', 'body'],
      indexable: false,
      textLength: 0,
    });
  });

  it('ГЛАВНОЕ: наполненный текст без решения человека индексацию НЕ открывает', () => {
    // Ровно та дыра, которую нашёл reviewer: право на index,follow вычислялось
    // из длины текста, поэтому любой пишущий под admin — скрипт, миграция,
    // будущая обёртка MCP — открывал страницу в индекс, не принимая такого
    // решения. Переключение index/noindex — осознанное действие человека
    // (п. 7.1 и п. 23 ТЗ), поэтому нужен ОТДЕЛЬНЫЙ выключатель.
    const result = infoPageIndexation(filledContent);
    expect(result.approved).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.indexable).toBe(false);
    expect(isInfoPageIndexable(filledContent)).toBe(false);
  });

  it('включённый выключатель на пустой странице тоже не открывает индексацию', () => {
    // Вторая половина конъюнкции: решение человека не отменяет п. 5.1 —
    // страница-заглушка в индекс не идёт, даже если выключатель включён.
    const result = infoPageIndexation({ [INFO_PAGE_INDEXING_FIELD]: true });
    expect(result.approved).toBe(true);
    expect(result.gaps).toEqual(['title', 'metaDescription', 'body']);
    expect(result.indexable).toBe(false);
  });

  it('включённый выключатель при коротком тексте не открывает индексацию', () => {
    const stub = {
      [INFO_PAGE_INDEXING_FIELD]: true,
      title: 'Условия использования',
      metaDescription: 'Условия использования открыток',
      body: richText('Текст будет позже.'),
    };
    const result = infoPageIndexation(stub);
    expect(result.approved).toBe(true);
    expect(result.indexable).toBe(false);
    expect(result.gaps).toEqual(['body']);
    expect(result.textLength).toBeLessThan(INFO_PAGE_MIN_TEXT_LENGTH);
  });

  it('только конъюнкция «решение + наполненность» даёт право на index,follow', () => {
    const filled = { ...filledContent, [INFO_PAGE_INDEXING_FIELD]: true };
    expect(isInfoPageIndexable(filled)).toBe(true);
    expect(infoPageIndexation(filled)).toEqual({
      approved: true,
      gaps: [],
      indexable: true,
      textLength: richTextPlainText(filledContent.body).length,
    });
  });

  it('выключатель включается только значением true, а не «похожим на да»', () => {
    // Строка «true», единица и объект приходят из REST-ответа и из форм; любое
    // из них, принятое за согласие, вернуло бы вычисление права коду. Приведение
    // типа здесь намеренное: проверяется поведение на данных, форма которых
    // типом не гарантирована.
    const withSwitch = (value: unknown): InfoPageFacts =>
      ({ ...filledContent, [INFO_PAGE_INDEXING_FIELD]: value }) as InfoPageFacts;
    for (const value of ['true', 1, {}, 'да', null, undefined, 0, '']) {
      expect(infoPageIndexation(withSwitch(value)).indexable).toBe(false);
    }
  });

  it('h1 не требуется: пустой H1 равен title — правило контентных коллекций', () => {
    expect(
      isInfoPageIndexable({
        [INFO_PAGE_INDEXING_FIELD]: true,
        title: 'Контакты',
        metaDescription: 'Как связаться с проектом',
        body: richText(longText),
      }),
    ).toBe(true);
  });

  it('title без текста индексацию не открывает даже при заполненном description', () => {
    expect(
      isInfoPageIndexable({
        [INFO_PAGE_INDEXING_FIELD]: true,
        title: 'Контакты',
        metaDescription: 'Как связаться',
        body: richText(''),
      }),
    ).toBe(false);
  });
});

describe('Ч-11: рекламное место выводится только с известными размерами', () => {
  const slot = { position: 'under-h1', width: 300, height: 250, enabled: true } as const;

  it('позиции — ровно два ряда решения Ч-11', () => {
    expect(AD_SLOT_POSITIONS).toEqual(['under-h1', 'after-pagination']);
    expect(MAX_AD_SLOTS_PER_POSITION).toBe(3);
  });

  it('незаполненные размеры — не выводить: иначе шаблон резервирует нулевое место', () => {
    expect(isAdSlotRenderable({ ...slot, width: null })).toBe(false);
    expect(isAdSlotRenderable({ ...slot, height: 0 })).toBe(false);
    expect(isAdSlotRenderable({ position: 'under-h1', enabled: true })).toBe(false);
  });

  it('выключенный блок не выводится', () => {
    expect(isAdSlotRenderable({ ...slot, enabled: false })).toBe(false);
    expect(isAdSlotRenderable({ ...slot, enabled: null })).toBe(false);
  });

  it('неизвестная позиция не выводится', () => {
    expect(isAdSlotRenderable({ ...slot, position: 'sidebar' })).toBe(false);
  });

  it('дробные и отрицательные размеры отклоняются', () => {
    expect(isAdSlotRenderable({ ...slot, width: 300.5 })).toBe(false);
    expect(isAdSlotRenderable({ ...slot, height: -250 })).toBe(false);
  });

  it('заполненный включённый блок выводится', () => {
    expect(isAdSlotRenderable(slot)).toBe(true);
  });

  it('выборка по позиции сохраняет порядок и отбрасывает невыводимые', () => {
    const rows = [
      { position: 'under-h1', width: 300, height: 250, enabled: true },
      { position: 'under-h1', width: 300, height: 250, enabled: false },
      { position: 'after-pagination', width: 728, height: 90, enabled: true },
      { position: 'under-h1', width: 240, height: 400, enabled: true },
    ];
    expect(renderableAdSlots(rows, 'under-h1')).toEqual([
      { height: 250, position: 'under-h1', width: 300 },
      { height: 400, position: 'under-h1', width: 240 },
    ]);
    expect(renderableAdSlots(null, 'under-h1')).toEqual([]);
  });

  it('в ряду не больше трёх блоков (Ч-11), иначе отказ с текстом', () => {
    const row = Array.from({ length: 4 }, () => ({ ...slot }));
    expect(validateAdSlotRows(row)).toEqual(expect.any(String));
    expect(validateAdSlotRows(Array.from({ length: 3 }, () => ({ ...slot })))).toBe(true);
    expect(validateAdSlotRows(undefined)).toBe(true);
  });
});

describe('путь от корня сайта в полях глобала', () => {
  it('пусто — норма: это и есть состояние «человек не заполнил»', () => {
    expect(validateSiteRootPath(undefined)).toBe(true);
    expect(validateSiteRootPath('')).toBe(true);
    expect(validateSiteRootPath('   ')).toBe(true);
  });

  it('абсолютный адрес отклоняется: хост подставляет единственный хелпер', () => {
    expect(validateSiteRootPath('https://otkritka.test/usloviya')).toEqual(expect.any(String));
    expect(validateSiteRootPath('//otkritka.test/usloviya')).toEqual(expect.any(String));
  });

  it('путь с параметрами отклоняется', () => {
    expect(validateSiteRootPath('/usloviya?utm=1')).toEqual(expect.any(String));
  });

  it('путь от корня принимается — и для страницы, и для файла', () => {
    expect(validateSiteRootPath('/usloviya')).toBe(true);
    expect(validateSiteRootPath('/media/site/logo.svg')).toBe(true);
  });
});
