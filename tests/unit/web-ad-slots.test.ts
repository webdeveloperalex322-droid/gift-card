/**
 * Рекламные места: что выводится, а что не выводится вовсе (задача Э3-12).
 *
 * Норма: решение Ч-11 (два ряда по три блока: под H1 над сеткой и после
 * пагинации; заглушка, размеры и параметры — из настроек в админке; место
 * резервируется по этим значениям), ТЗ §5.7 («зарезервированные контейнеры
 * фиксированных размеров, реклама не вызывает сдвигов макета, CLS < 0,1; первый
 * экран не занят рекламой полностью; рекламный код загружается отложенно и не
 * блокирует LCP»), ТЗ §10 (резервирование размеров рекламных контейнеров).
 *
 * Правило «выводить или промолчать» живёт в `@otkritka/shared`
 * (`isAdSlotRenderable`, `renderableAdSlots`) и проверяется там же
 * (`tests/unit/site-settings-rules.test.ts`). Здесь проверяется РЯД: сколько
 * блоков он выводит, в каком порядке и чем именно резервирует место.
 */
import { describe, expect, it } from 'vitest';

import { MAX_AD_SLOTS_PER_POSITION } from '@otkritka/shared';

import {
  AD_ROW_LABELS,
  adRow,
  adRowReservedHeight,
  adRows,
} from '../../apps/web/src/seo/ad-slots.js';

const BANNER = { enabled: true, height: 250, position: 'under-h1', width: 300 } as const;

describe('состав ряда рекламных мест', () => {
  it('включённый блок с обоими размерами выводится', () => {
    const row = adRow([BANNER], 'under-h1');

    expect(row).toHaveLength(1);
    expect(row[0]?.width).toBe(300);
    expect(row[0]?.height).toBe(250);
  });

  it('блок без размеров не выводится ВОВСЕ', () => {
    // Иначе шаблон зарезервировал бы нулевое место, реклама подгрузилась бы в
    // него и дала ровно тот сдвиг макета, против которого резервирование и
    // существует (ТЗ §5.7, §10).
    expect(adRow([{ ...BANNER, width: null }], 'under-h1')).toEqual([]);
    expect(adRow([{ ...BANNER, height: null }], 'under-h1')).toEqual([]);
    expect(adRow([{ ...BANNER, height: 0 }], 'under-h1')).toEqual([]);
  });

  it('выключенный блок и блок неизвестной позиции не выводятся', () => {
    expect(adRow([{ ...BANNER, enabled: false }], 'under-h1')).toEqual([]);
    expect(adRow([{ ...BANNER, enabled: null }], 'under-h1')).toEqual([]);
    expect(adRow([{ ...BANNER, position: 'sidebar' }], 'under-h1')).toEqual([]);
  });

  it('ряды не перемешиваются: чужая позиция в ряд не попадает', () => {
    const slots = [BANNER, { ...BANNER, position: 'after-pagination', width: 728, height: 90 }];

    expect(adRow(slots, 'under-h1')).toHaveLength(1);
    expect(adRow(slots, 'after-pagination').map((slot) => slot.width)).toEqual([728]);
  });

  it('в ряду не больше трёх блоков — лишние отбрасываются', () => {
    // Постусловие: CMS не даёт сохранить четвёртый блок в ряду
    // (`validateAdSlotRows`), но шаблон обязан оставаться в рамках Ч-11 и на
    // данных, сохранённых до появления проверки.
    const many = Array.from({ length: 5 }, (_, index) => ({ ...BANNER, width: 300 + index }));
    const row = adRow(many, 'under-h1');

    expect(row).toHaveLength(MAX_AD_SLOTS_PER_POSITION);
    // Отбрасывается ХВОСТ: порядок задаёт редактор, и первые блоки ряда — его выбор.
    expect(row.map((slot) => slot.width)).toEqual([300, 301, 302]);
  });

  it('пустые и отсутствующие настройки дают пустой ряд, а не ошибку', () => {
    expect(adRow(null, 'under-h1')).toEqual([]);
    expect(adRow(undefined, 'after-pagination')).toEqual([]);
    expect(adRow([], 'under-h1')).toEqual([]);
  });
});

describe('резервирование места', () => {
  it('блок резервирует место пропорцией и предельной шириной, а не жёсткой высотой', () => {
    const [slot] = adRow([BANNER], 'under-h1');

    // Пропорция нужна ради узкого экрана: 728×90 в колонку 360 px не помещается,
    // и жёсткая высота дала бы либо обрезку, либо пустую полосу. Пропорция
    // сжимает коробку вместе с шириной, поэтому зарезервированное место
    // совпадает с занятым при любой ширине колонки.
    expect(slot?.aspectRatio).toBe('300 / 250');
    expect(slot?.style).toContain('300px');
    expect(slot?.style).toContain('300 / 250');
  });

  it('высота ряда — это высота самого высокого блока, а не сумма', () => {
    // Ровно поэтому ряд горизонтальный: три блока по 250 px в столбик съели бы
    // 750 px первого экрана, то есть заняли бы его целиком (запрет ТЗ §5.7).
    const row = adRow(
      [BANNER, { ...BANNER, height: 90, width: 728 }, { ...BANNER, height: 100, width: 200 }],
      'under-h1',
    );

    expect(adRowReservedHeight(row)).toBe(250);
  });

  it('у пустого ряда зарезервированной высоты нет', () => {
    expect(adRowReservedHeight([])).toBe(0);
  });

  it('у каждой позиции есть видимая подпись ряда', () => {
    expect(AD_ROW_LABELS['under-h1'].trim()).not.toBe('');
    expect(AD_ROW_LABELS['after-pagination'].trim()).not.toBe('');
  });
});

describe('оба ряда страницы списка', () => {
  it('ряды приходят одним значением и не перемешиваются', () => {
    const rows = adRows([
      BANNER,
      { ...BANNER, position: 'after-pagination', width: 728, height: 90 },
    ]);

    expect(rows.underH1.map((slot) => slot.width)).toEqual([300]);
    expect(rows.afterPagination.map((slot) => slot.width)).toEqual([728]);
  });

  it('незаполненные настройки дают два пустых ряда', () => {
    const rows = adRows(null);

    expect(rows.underH1).toEqual([]);
    expect(rows.afterPagination).toEqual([]);
  });
});
