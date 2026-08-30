/**
 * Изображение карточки из записи CMS (задача Э3-04): адаптеры «запись → модель
 * разметки».
 *
 * Правила самой разметки (порядок форматов, дескриптор `w`, резервный файл,
 * `sizes`, дефолт ленивой загрузки, условие C8) проверяются отдельно и без CMS —
 * `tests/unit/web-card-image.test.ts`. Здесь проверяется то, что относится к
 * ЗАПИСИ:
 *
 *   - источники берутся ТОЛЬКО из зеркала `derivative.variants[]`, и оба
 *     опциональных уровня переживают отсутствие;
 *   - `alt` берётся из поля записи, а пустое поле даёт ОТКАЗ с указанием slug, а
 *     не пустой `alt` и не подстановку заголовка;
 *   - при отсутствии производных модель равна `null` и `alt` при этом НЕ
 *     проверяется: сообщение обязано называть настоящую причину.
 *
 * Файл лежит рядом с исходниками по той же причине, что `./breadcrumbs.test.ts`:
 * модуль импортирует сгенерированные типы Payload, а composite-проект
 * `apps/web/tsconfig.node.json` файл `.ts` чужого пакета принять не может.
 *
 * Фикстуры описаны `Pick`-типами модуля: полный объект `Card` здесь был бы шумом
 * и начал бы требовать правки при каждом новом поле схемы.
 */
import { describe, expect, it } from 'vitest';

import {
  type CardImageSource,
  cardImageAlt,
  cardImageVariants,
  cardPictureModel,
} from './card-image.js';

const ALT = 'Букет розовых тюльпанов и рукописная надпись «С 8 Марта, мама»';

/** Зеркало в том виде, в каком его отдаёт карточка: группы по формату. */
const VARIANTS = [
  { key: 'cards/a1b2c3d4/otkrytka-mame-320.avif', format: 'avif' as const, width: 320, height: 640 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.avif', format: 'avif' as const, width: 640, height: 1280 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-320.webp', format: 'webp' as const, width: 320, height: 640 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.webp', format: 'webp' as const, width: 640, height: 1280 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-320.jpg', format: 'jpeg' as const, width: 320, height: 640 },
  { key: 'cards/a1b2c3d4/otkrytka-mame-640.jpg', format: 'jpeg' as const, width: 640, height: 1280 },
];

const CARD: CardImageSource = {
  slug: 'otkrytka-mame-na-8-marta',
  alt: ALT,
  derivative: { variants: VARIANTS },
};

describe('источники из зеркала', () => {
  it('берутся из derivative.variants[] как есть', () => {
    expect(cardImageVariants(CARD)).toEqual(VARIANTS);
  });

  it('отсутствующая группа derivative даёт пустой набор, а не отказ', () => {
    expect(cardImageVariants({})).toEqual([]);
  });

  it('пустой и отсутствующий variants[] дают пустой набор', () => {
    expect(cardImageVariants({ derivative: {} })).toEqual([]);
    expect(cardImageVariants({ derivative: { variants: null } })).toEqual([]);
    expect(cardImageVariants({ derivative: { variants: [] } })).toEqual([]);
  });
});

describe('alt из записи', () => {
  it('описание переносится как есть', () => {
    expect(cardImageAlt(CARD)).toEqual({ kind: 'described', text: ALT });
  });

  it('пустое поле — отказ с указанием карточки, а не пустой alt', () => {
    expect(() => cardImageAlt({ slug: 'bez-alt', alt: '' })).toThrow(/bez-alt/);
    expect(() => cardImageAlt({ slug: 'bez-alt', alt: null })).toThrow(/alt/i);
    expect(() => cardImageAlt({ slug: 'bez-alt' })).toThrow(/alt/i);
  });

  it('пробелы описанием не считаются', () => {
    expect(() => cardImageAlt({ slug: 'probely', alt: '   ' })).toThrow(/probely/);
  });
});

describe('модель разметки карточки', () => {
  it('собирается из одной записи: источники и alt', () => {
    const model = cardPictureModel({ card: CARD, layout: 'grid-tile' });

    expect(model?.img.alt).toBe(ALT);
    expect(model?.sources.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
    expect(model?.img.src).toBe('/media/cards/a1b2c3d4/otkrytka-mame-640.jpg');
    expect(model?.img.width).toBe(640);
    expect(model?.img.height).toBe(1280);
  });

  it('без производных модели нет — и alt при этом не проверяется', () => {
    const draft: CardImageSource = { slug: 'bez-izobrazheniya', alt: '' };

    expect(cardPictureModel({ card: draft, layout: 'content-width' })).toBeNull();
  });

  it('роль вёрстки доходит до sizes', () => {
    const tile = cardPictureModel({ card: CARD, layout: 'grid-tile' });
    const content = cardPictureModel({ card: CARD, layout: 'content-width' });

    expect(tile?.img.sizes).not.toBe(content?.img.sizes);
  });

  it('по умолчанию изображение ленивое, priority снимает loading', () => {
    const lazy = cardPictureModel({ card: CARD, layout: 'grid-tile' });
    const first = cardPictureModel({ card: CARD, layout: 'content-width', priority: true });

    expect(lazy?.img.loading).toBe('lazy');
    expect(first === null ? null : 'loading' in first.img).toBe(false);
    expect(first?.img.fetchpriority).toBe('high');
  });

  it('пропущенный priority равен undefined и трактуется как «не первое»', () => {
    const model = cardPictureModel({ card: CARD, layout: 'grid-tile', priority: undefined });

    expect(model?.img.loading).toBe('lazy');
  });
});
