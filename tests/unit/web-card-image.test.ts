/**
 * Разметка изображения открытки: `<picture>`/`<img>` из зеркала производных
 * (задача Э3-04).
 *
 * Норма — ТЗ §6.5 и §10, `CLAUDE.md`, раздел «Изображения»: реальный `src`,
 * обязательные `width` и `height`, `srcset`/`sizes`, первое крупное изображение
 * без `loading="lazy"` (допустим `fetchpriority="high"`), остальные — с ним,
 * `alt` — естественное описание, у декоративных элементов пустой.
 *
 * Проверяется ЧИСТАЯ часть — модель разметки (`apps/web/src/images/card-image.ts`).
 * Компонент `apps/web/src/components/CardImage.astro` поверх неё только печатает
 * атрибуты: каждый атрибут берётся из ОДНОГО поля модели, поэтому «в srcset одно,
 * в width другое» невозможно по построению. Живой серверный рендер собранного
 * сервера проверяется отдельно и не здесь: юнит-тест не поднимает Astro.
 *
 * ## Что здесь закреплено такого, чего нельзя закрепить в `packages/images`
 *
 * Условие C8: дескриптор `w` в `srcset`, атрибут `width` и ширина в ИМЕНИ ФАЙЛА
 * — одно и то же число. Внутри пайплайна такой тест тавтологичен (там ширина
 * приходит одним аргументом и уходит в имя файла), а расходятся эти три числа
 * именно на разметке: в зеркале есть `width` варианта, а ключ файла собран
 * пайплайном раньше. Поэтому фикстуры строят ключи НАСТОЯЩИМ построителем
 * (`buildDerivativeObjectKey` из `@otkritka/images`), а тест разбирает ширину
 * обратно из имени файла и сравнивает все три числа.
 *
 * Хост в фикстуре синтетический — так требует `CLAUDE.md`: значения по умолчанию
 * у `SITE_URL` нет, а сборку абсолютного адреса проверить надо.
 */
import { buildDerivativeObjectKey, FILE_EXTENSION_BY_FORMAT } from '@otkritka/images';
import { MEDIA_ROUTE_PREFIX } from '@otkritka/images/media';
import { describe, expect, it } from 'vitest';

import {
  altText,
  buildPictureModel,
  buildSrcset,
  DECORATIVE_IMAGE,
  describedImage,
  groupVariantsByFormat,
  IMAGE_LAYOUT_SIZES,
  type ImageFormat,
  type ImageVariant,
  pickFallbackVariant,
  variantAbsoluteUrl,
  variantPath,
} from '../../apps/web/src/images/card-image.js';

/** Синтетический хост фикстуры. Дефолта у `SITE_URL` в коде нет и быть не может. */
const ENV = { SITE_URL: 'https://kartinki.test' } as const;

const REVISION = 'a1b2c3d4';
const TITLE = 'Открытка маме на 8 марта с тюльпанами';
const ALT = 'Букет розовых тюльпанов и рукописная надпись «С 8 Марта, мама»';

/**
 * Вариант производной ровно в той форме, в какой его отдаёт зеркало
 * `card.derivative.variants[]`: ключ, формат и ФАКТИЧЕСКИЕ размеры файла.
 *
 * Ключ строится настоящим построителем пайплайна — иначе тест на условие C8
 * сравнивал бы число с числом, которое сам же и вписал в строку.
 */
function variant(format: ImageFormat, width: number, height = width * 2): ImageVariant {
  return {
    key: buildDerivativeObjectKey({
      prefix: 'cards',
      revision: REVISION,
      description: TITLE,
      format,
      width,
    }),
    format,
    width,
    height,
  };
}

/** Полный набор: три формата × пять ширин. */
const FULL_SET: readonly ImageVariant[] = [320, 640, 960, 1280, 1920].flatMap((width) => [
  variant('avif', width),
  variant('webp', width),
  variant('jpeg', width),
]);

/**
 * Исходник шириной 1100 px: апскейла нет, поэтому 1280 и 1920 не создаются.
 * Набор ширин — ПОДМНОЖЕСТВО пяти кандидатов, и разметка обязана это переносить.
 */
const NARROW_SOURCE_SET: readonly ImageVariant[] = [320, 640, 960].flatMap((width) => [
  variant('avif', width),
  variant('webp', width),
  variant('jpeg', width),
]);

/** Ширина из ИМЕНИ ФАЙЛА производной: `...-<ширина>.<расширение>`. */
function widthFromKey(pathOrKey: string): number {
  const match = /-(\d+)\.[a-z0-9]+$/u.exec(pathOrKey);
  if (match?.[1] === undefined) {
    throw new Error(`В имени файла «${pathOrKey}» нет ширины — фикстура собрана неверно.`);
  }
  return Number(match[1]);
}

/** Разбор строки `srcset` на пары «путь, дескриптор w». */
function parseSrcset(srcset: string): readonly { path: string; descriptor: number }[] {
  return srcset.split(', ').map((entry) => {
    const match = /^(\S+) (\d+)w$/u.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Запись srcset «${entry}» не имеет вида «<путь> <ширина>w».`);
    }
    return { path: match[1], descriptor: Number(match[2]) };
  });
}

describe('группировка вариантов по формату', () => {
  it('группы идут в порядке предпочтения avif → webp → jpeg независимо от порядка входа', () => {
    const shuffled = [...FULL_SET].reverse();

    expect(groupVariantsByFormat(shuffled).map((group) => group.format)).toEqual([
      'avif',
      'webp',
      'jpeg',
    ]);
  });

  it('внутри группы ширины идут по возрастанию независимо от порядка входа', () => {
    const shuffled = [variant('avif', 960), variant('avif', 320), variant('avif', 640)];

    expect(groupVariantsByFormat(shuffled).at(0)?.variants.map((v) => v.width)).toEqual([
      320, 640, 960,
    ]);
  });

  it('группирует ПО ПОЛЮ format, а не по позиции в массиве', () => {
    const interleaved = [
      variant('jpeg', 320),
      variant('avif', 640),
      variant('jpeg', 960),
      variant('avif', 320),
    ];

    expect(
      groupVariantsByFormat(interleaved).map((group) => [
        group.format,
        group.variants.map((v) => v.width),
      ]),
    ).toEqual([
      ['avif', [320, 640]],
      ['jpeg', [320, 960]],
    ]);
  });

  it('пустых групп не выдаёт: отсутствующий формат просто не появляется', () => {
    expect(groupVariantsByFormat([variant('jpeg', 640)]).map((g) => g.format)).toEqual(['jpeg']);
  });

  it('на пустом наборе групп нет', () => {
    expect(groupVariantsByFormat([])).toEqual([]);
  });

  it('тип источника соответствует формату', () => {
    expect(groupVariantsByFormat(FULL_SET).map((group) => group.type)).toEqual([
      'image/avif',
      'image/webp',
      'image/jpeg',
    ]);
  });

  it('формат вне набора вывода пайплайна отклоняется, а не выпадает молча', () => {
    const alien = { ...variant('webp', 640), format: 'jxl' as ImageFormat };

    expect(() => groupVariantsByFormat([alien])).toThrow(/jxl/);
  });

  it('формат, не совпадающий с расширением ключа, отклоняется', () => {
    const mismatched: ImageVariant = { ...variant('jpeg', 640), format: 'webp' };

    expect(() => groupVariantsByFormat([mismatched])).toThrow(/image\/webp|расширени/i);
  });
});

describe('строка srcset', () => {
  it('дескриптор w равен ФАКТИЧЕСКОЙ ширине варианта, а не ширине из имени файла', () => {
    // Аномалия намеренная: если бы дескриптор собирался из ключа, он был бы 640.
    const anomaly: ImageVariant = { ...variant('jpeg', 640), width: 617, height: 1234 };

    expect(parseSrcset(buildSrcset([anomaly])).at(0)?.descriptor).toBe(617);
  });

  it('путь собирается единственной функцией проекта: /media/<ключ>', () => {
    const only = variant('webp', 640);

    expect(parseSrcset(buildSrcset([only])).at(0)?.path).toBe(
      `${MEDIA_ROUTE_PREFIX}/${only.key}`,
    );
  });

  it('записи идут по возрастанию ширины', () => {
    const jpeg = [variant('jpeg', 960), variant('jpeg', 320), variant('jpeg', 640)];

    expect(parseSrcset(buildSrcset(jpeg)).map((entry) => entry.descriptor)).toEqual([
      320, 640, 960,
    ]);
  });

  it('переносит НЕПОЛНЫЙ набор ширин как есть: 1280 и 1920 не выдумываются', () => {
    const jpeg = NARROW_SOURCE_SET.filter((v) => v.format === 'jpeg');

    expect(parseSrcset(buildSrcset(jpeg)).map((entry) => entry.descriptor)).toEqual([
      320, 640, 960,
    ]);
  });

  it('две производные одной ширины в одном формате отклоняются как неоднозначность', () => {
    const twins = [variant('jpeg', 640), { ...variant('jpeg', 640), key: 'cards/deadbeef/inoe-640.jpg' }];

    expect(() => buildSrcset(twins)).toThrow(/640/);
  });

  it('смешанные форматы в одной строке отклоняются', () => {
    expect(() => buildSrcset([variant('avif', 640), variant('webp', 960)])).toThrow(
      /формат/i,
    );
  });

  it('пустой набор источников отклоняется: srcset без записей не бывает', () => {
    expect(() => buildSrcset([])).toThrow();
  });
});

describe('резервный вариант для <img>', () => {
  it('выбирается ПО ФОРМАТУ jpeg, а не по позиции в массиве', () => {
    // avif стоит последним, jpeg — в середине: позиционный выбор дал бы не jpeg.
    const set = [variant('webp', 1920), variant('jpeg', 640), variant('avif', 1280)];

    expect(pickFallbackVariant(set).format).toBe('jpeg');
  });

  it('берётся самая широкая jpeg', () => {
    expect(pickFallbackVariant(FULL_SET).width).toBe(1920);
  });

  it('на неполном наборе берётся самая широкая из имеющихся', () => {
    expect(pickFallbackVariant(NARROW_SOURCE_SET).width).toBe(960);
  });

  it('набор без jpeg отклоняется: <img> остался бы без src', () => {
    expect(() => pickFallbackVariant([variant('avif', 640), variant('webp', 640)])).toThrow(
      /jpeg/i,
    );
  });
});

describe('alt', () => {
  it('описание попадает в атрибут как есть', () => {
    expect(altText(describedImage(ALT))).toBe(ALT);
  });

  it('декоративный элемент даёт ПУСТОЙ alt, а не отсутствие атрибута', () => {
    expect(altText(DECORATIVE_IMAGE)).toBe('');
  });

  it('пустое описание отклоняется: пустой alt заявляется только явно', () => {
    expect(() => describedImage('')).toThrow(/alt/i);
    expect(() => describedImage('   ')).toThrow(/alt/i);
  });

  it('описание обрезается по краям, но не переписывается', () => {
    expect(altText(describedImage(`  ${ALT}  `))).toBe(ALT);
  });
});

describe('пути производной', () => {
  it('публичный путь — относительный, с префиксом /media', () => {
    const only = variant('avif', 960);

    expect(variantPath(only)).toBe(`${MEDIA_ROUTE_PREFIX}/${only.key}`);
  });

  it('абсолютный адрес собирается из SITE_URL', () => {
    const only = variant('avif', 960);

    expect(variantAbsoluteUrl(only, ENV)).toBe(`${ENV.SITE_URL}${MEDIA_ROUTE_PREFIX}/${only.key}`);
  });

  it('ключ с выходом за пределы пространства отклоняется', () => {
    expect(() => variantPath({ ...variant('jpeg', 640), key: '../originals/tajna.jpg' })).toThrow();
  });
});

describe('модель разметки', () => {
  const full = buildPictureModel({
    variants: FULL_SET,
    alt: describedImage(ALT),
    layout: 'content-width',
    priority: true,
  });

  it('на пустом наборе вариантов модели нет: <picture> не рендерится вовсе', () => {
    expect(
      buildPictureModel({ variants: [], alt: describedImage(ALT), layout: 'grid-tile' }),
    ).toBeNull();
  });

  it('источники идут avif → webp, jpeg остаётся резервным в <img>', () => {
    expect(full?.sources.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
  });

  it('sizes задан и у каждого <source>, и у <img>: наследования между ними нет', () => {
    const sizes = IMAGE_LAYOUT_SIZES['content-width'];

    expect(full?.sources.map((source) => source.sizes)).toEqual([sizes, sizes]);
    expect(full?.img.sizes).toBe(sizes);
  });

  it('src — реальный путь к файлу, srcset у <img> состоит из jpeg', () => {
    expect(full?.img.src.startsWith(`${MEDIA_ROUTE_PREFIX}/`)).toBe(true);
    expect(full?.img.src.endsWith(`.${FILE_EXTENSION_BY_FORMAT.jpeg}`)).toBe(true);

    for (const entry of parseSrcset(full?.img.srcset ?? '')) {
      expect(entry.path.endsWith(`.${FILE_EXTENSION_BY_FORMAT.jpeg}`)).toBe(true);
    }
  });

  it('width и height присутствуют всегда и равны размерам резервного файла', () => {
    const fallback = pickFallbackVariant(FULL_SET);

    expect(full?.img.width).toBe(fallback.width);
    expect(full?.img.height).toBe(fallback.height);

    const narrow = buildPictureModel({
      variants: NARROW_SOURCE_SET,
      alt: describedImage(ALT),
      layout: 'grid-tile',
    });
    const narrowFallback = pickFallbackVariant(NARROW_SOURCE_SET);

    expect(narrow?.img.width).toBe(narrowFallback.width);
    expect(narrow?.img.height).toBe(narrowFallback.height);
  });

  it('только jpeg в наборе — источников нет, разметка остаётся полной', () => {
    const jpegOnly = buildPictureModel({
      variants: FULL_SET.filter((v) => v.format === 'jpeg'),
      alt: describedImage(ALT),
      layout: 'grid-tile',
    });

    expect(jpegOnly?.sources).toEqual([]);
    expect(parseSrcset(jpegOnly?.img.srcset ?? '')).toHaveLength(5);
    expect(jpegOnly?.img.width).toBe(1920);
  });

  it('неполный набор ширин переносится и в источники, и в <img>', () => {
    const narrow = buildPictureModel({
      variants: NARROW_SOURCE_SET,
      alt: describedImage(ALT),
      layout: 'grid-tile',
    });

    for (const source of narrow?.sources ?? []) {
      expect(parseSrcset(source.srcset).map((entry) => entry.descriptor)).toEqual([320, 640, 960]);
    }
    expect(parseSrcset(narrow?.img.srcset ?? '').map((entry) => entry.descriptor)).toEqual([
      320, 640, 960,
    ]);
  });

  it('первое крупное изображение: атрибута loading НЕТ, fetchpriority="high" есть', () => {
    expect(full === null ? null : 'loading' in full.img).toBe(false);
    expect(full?.img.fetchpriority).toBe('high');
  });

  it('по умолчанию (проп не передан) изображение ленивое', () => {
    const model = buildPictureModel({
      variants: FULL_SET,
      alt: describedImage(ALT),
      layout: 'grid-tile',
    });

    expect(model?.img.loading).toBe('lazy');
    expect(model === null ? null : 'fetchpriority' in model.img).toBe(false);
  });

  it('priority: false — то же самое, что и пропуск пропа', () => {
    const model = buildPictureModel({
      variants: FULL_SET,
      alt: describedImage(ALT),
      layout: 'grid-tile',
      priority: false,
    });

    expect(model?.img.loading).toBe('lazy');
  });

  it('декоративное изображение получает пустой alt', () => {
    const model = buildPictureModel({
      variants: FULL_SET,
      alt: DECORATIVE_IMAGE,
      layout: 'grid-tile',
    });

    expect(model?.img.alt).toBe('');
  });
});

describe('условие C8: дескриптор w, атрибут width и ширина в имени файла — одно число', () => {
  it('совпадают в каждой записи srcset каждого источника', () => {
    const model = buildPictureModel({
      variants: FULL_SET,
      alt: describedImage(ALT),
      layout: 'content-width',
      priority: true,
    });

    const srcsets = [...(model?.sources.map((source) => source.srcset) ?? []), model?.img.srcset];
    expect(srcsets).toHaveLength(3);

    for (const srcset of srcsets) {
      for (const entry of parseSrcset(srcset ?? '')) {
        expect(widthFromKey(entry.path), entry.path).toBe(entry.descriptor);
      }
    }
  });

  it('совпадают у атрибута width и имени файла в src', () => {
    const model = buildPictureModel({
      variants: FULL_SET,
      alt: describedImage(ALT),
      layout: 'content-width',
      priority: true,
    });

    expect(widthFromKey(model?.img.src ?? '')).toBe(model?.img.width);
  });

  it('совпадают и на неполном наборе ширин', () => {
    const model = buildPictureModel({
      variants: NARROW_SOURCE_SET,
      alt: describedImage(ALT),
      layout: 'grid-tile',
    });

    expect(widthFromKey(model?.img.src ?? '')).toBe(model?.img.width);
    for (const entry of parseSrcset(model?.img.srcset ?? '')) {
      expect(widthFromKey(entry.path)).toBe(entry.descriptor);
    }
  });
});

describe('sizes — параметр вёрстки', () => {
  it('у каждой роли изображения свой набор', () => {
    expect(Object.keys(IMAGE_LAYOUT_SIZES).sort()).toEqual(['content-width', 'grid-tile']);
  });

  it('последняя запись каждого набора — без медиаусловия', () => {
    for (const [layout, sizes] of Object.entries(IMAGE_LAYOUT_SIZES)) {
      const last = sizes.split(', ').at(-1) ?? '';
      expect(last, layout).not.toContain('(min-width');
      expect(last.length, layout).toBeGreaterThan(0);
    }
  });

  it('ширина колонки контента взята из вёрстки layout: 60rem минус отбивки', () => {
    // Значение обязано соответствовать `--content-max` и padding в BaseLayout.
    expect(IMAGE_LAYOUT_SIZES['content-width']).toBe(
      '(min-width: 60rem) calc(60rem - 2rem), calc(100vw - 2rem)',
    );
  });
});
