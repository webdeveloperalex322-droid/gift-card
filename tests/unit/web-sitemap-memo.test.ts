/**
 * Общая память процесса под карту сайта (правка по вердикту `reviewer` от
 * 2026-08-28 к задаче Э4-04).
 *
 * Что доказывается: один проход краулера по четырём файлам карты сайта
 * (`/sitemap.xml`, `-sections`, `-cards-N`, `-images-N`) обходит каталог ОДИН
 * раз, а не четыре. До правки каждый маршрут звал `buildSitemapModel`
 * независимо, общей памяти не было, и повторный запрос — адреса публичные,
 * названы в `robots.txt`, авторизации и ограничения частоты у них нет — стоил
 * ещё одного полного обхода.
 *
 * Срок памяти равен `max-age` заголовка `Cache-Control` тех же файлов и берётся
 * из той же константы: окно устаревания у карты сайта уже объявлено этим
 * заголовком, поэтому память на тот же срок его не расширяет. Вторая константа
 * срока запрещена — она разошлась бы с заголовком молча.
 *
 * Тест ЧИСТЫЙ: ни базы, ни таймеров реального времени — часы подставляются.
 */
import { describe, expect, it } from 'vitest';

import { createSitemapMemo } from '../../apps/web/src/seo/sitemap-memo.js';
import { SITEMAP_CACHE_CONTROL, SITEMAP_CACHE_SECONDS } from '../../apps/web/src/seo/sitemap.js';

/** Часы, которыми управляет тест: срок памяти проверяется, а не пережидается. */
function clock(): { now: () => number; advance: (seconds: number) => void } {
  let value = 1_000_000;
  return {
    advance: (seconds: number): void => {
      value += seconds * 1000;
    },
    now: (): number => value,
  };
}

describe('срок памяти и срок кеша — одно значение', () => {
  it('Cache-Control файлов карты сайта собран из того же числа секунд', () => {
    expect(SITEMAP_CACHE_CONTROL).toBe(`public, max-age=${String(SITEMAP_CACHE_SECONDS)}`);
  });

  it('срок положителен и не бесконечен: карта сайта обязана обновляться', () => {
    expect(SITEMAP_CACHE_SECONDS).toBeGreaterThan(0);
    expect(SITEMAP_CACHE_SECONDS).toBeLessThanOrEqual(3600);
  });
});

describe('один проход каталога на все файлы карты сайта', () => {
  it('четыре последовательных запроса читают каталог один раз', async () => {
    const time = clock();
    let builds = 0;
    const memo = createSitemapMemo<string>(SITEMAP_CACHE_SECONDS, time.now);
    const load = (): Promise<string> => {
      builds += 1;
      return Promise.resolve(`модель №${String(builds)}`);
    };

    const results: string[] = [];
    // Порядок обхода краулера: индекс, разделы, карточки, изображения.
    for (let index = 0; index < 4; index += 1) {
      results.push(await memo.get('http://otkritka.test', load));
    }

    expect(builds).toBe(1);
    expect(results).toEqual(Array.from({ length: 4 }, () => 'модель №1'));
  });

  it('четыре ОДНОВРЕМЕННЫХ запроса тоже читают каталог один раз', async () => {
    // Ровно этот случай и есть усиление нагрузки: четыре адреса запрашиваются
    // параллельно, и без общей памяти каждый начинал бы свой обход.
    const time = clock();
    let builds = 0;
    const memo = createSitemapMemo<string>(SITEMAP_CACHE_SECONDS, time.now);
    const load = async (): Promise<string> => {
      builds += 1;
      await Promise.resolve();
      return 'модель';
    };

    const results = await Promise.all([
      memo.get('http://otkritka.test', load),
      memo.get('http://otkritka.test', load),
      memo.get('http://otkritka.test', load),
      memo.get('http://otkritka.test', load),
    ]);

    expect(builds).toBe(1);
    expect(results).toEqual(['модель', 'модель', 'модель', 'модель']);
  });
});

describe('память не переживает свой срок', () => {
  it('после истечения срока каталог читается заново', async () => {
    const time = clock();
    let builds = 0;
    const memo = createSitemapMemo<string>(SITEMAP_CACHE_SECONDS, time.now);
    const load = (): Promise<string> => {
      builds += 1;
      return Promise.resolve(`модель №${String(builds)}`);
    };

    expect(await memo.get('one', load)).toBe('модель №1');
    time.advance(SITEMAP_CACHE_SECONDS - 1);
    expect(await memo.get('one', load)).toBe('модель №1');

    time.advance(2);
    expect(await memo.get('one', load)).toBe('модель №2');
    expect(builds).toBe(2);
  });

  it('другой хост — другая модель: абсолютные адреса собираются из SITE_URL', async () => {
    const time = clock();
    let builds = 0;
    const memo = createSitemapMemo<string>(SITEMAP_CACHE_SECONDS, time.now);
    const load = (): Promise<string> => {
      builds += 1;
      return Promise.resolve(`модель №${String(builds)}`);
    };

    expect(await memo.get('http://otkritka.test', load)).toBe('модель №1');
    expect(await memo.get('http://drugoy.test', load)).toBe('модель №2');
    // Память односекционная: возврат к прежнему ключу строит модель заново, а не
    // достаёт устаревшую. Ключей на сайте один, поэтому цена нулевая, а
    // неограниченного роста памяти по ключу нет.
    expect(await memo.get('http://otkritka.test', load)).toBe('модель №3');
  });

  it('отказ не запоминается: следующий запрос пробует снова', async () => {
    // Иначе одна недоступность базы закрывала бы карту сайта на весь срок
    // памяти, причём с ответом «ошибка», а не «пусто».
    const time = clock();
    let attempts = 0;
    const memo = createSitemapMemo<string>(SITEMAP_CACHE_SECONDS, time.now);
    const load = (): Promise<string> => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('база недоступна'))
        : Promise.resolve('модель');
    };

    await expect(memo.get('one', load)).rejects.toThrow('база недоступна');
    expect(await memo.get('one', load)).toBe('модель');
    expect(attempts).toBe(2);
  });
});
