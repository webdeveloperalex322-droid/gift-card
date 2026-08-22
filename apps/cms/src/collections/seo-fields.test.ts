/**
 * Валидаторы SEO-полей (задачи Э1-04 и, повторно, Э1-05).
 *
 * Два правила здесь стоят дороже остальных:
 *   - `index,follow` невозможен вне статуса `published` — иначе черновик
 *     попадает в индекс, а это ровно то, от чего страхует статусная модель;
 *   - canonical задаётся путём, а не абсолютным URL — иначе в поле появляется
 *     второй источник хоста помимо `SITE_URL`, и после переезда домена
 *     canonical указывает на старый.
 */
import { describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import { DEFAULT_ROBOTS } from '../seo/robots';
import { DEFAULT_STATUS, validateCanonicalOverride, validateRobotsForStatus } from './seo-fields';

const admin = { role: ROLES.admin };
const aiEditor = { role: ROLES.aiEditor };

describe('дефолты новой записи', () => {
  it('draft и noindex,follow', () => {
    expect(DEFAULT_STATUS).toBe('draft');
    expect(DEFAULT_ROBOTS).toBe('noindex,follow');
  });
});

describe('validateRobotsForStatus', () => {
  it('index,follow разрешён администратору для published', () => {
    expect(validateRobotsForStatus('index,follow', { status: 'published', user: admin })).toBe(true);
  });

  it('index,follow отклонён для draft и review — даже администратору', () => {
    expect(validateRobotsForStatus('index,follow', { status: 'draft', user: admin })).toEqual(
      expect.any(String),
    );
    expect(validateRobotsForStatus('index,follow', { status: 'review', user: admin })).toEqual(
      expect.any(String),
    );
  });

  it('index,follow отклонён сервисному аккаунту в любом статусе', () => {
    expect(validateRobotsForStatus('index,follow', { status: 'published', user: aiEditor })).toEqual(
      expect.any(String),
    );
  });

  it('noindex-директивы допустимы всегда', () => {
    expect(validateRobotsForStatus('noindex,follow', { status: 'draft', user: aiEditor })).toBe(
      true,
    );
    expect(
      validateRobotsForStatus('noindex,nofollow', { status: 'published', user: admin }),
    ).toBe(true);
  });

  it('значение вне набора и пустое значение отклоняются', () => {
    expect(validateRobotsForStatus('index', { status: 'published', user: admin })).toEqual(
      expect.any(String),
    );
    expect(validateRobotsForStatus('all', { status: 'published', user: admin })).toEqual(
      expect.any(String),
    );
    expect(validateRobotsForStatus(undefined, { status: 'draft', user: admin })).toEqual(
      expect.any(String),
    );
  });

  it('статус, которого нет, не даёт открыть индексацию', () => {
    expect(validateRobotsForStatus('index,follow', { status: undefined, user: admin })).toEqual(
      expect.any(String),
    );
  });
});

describe('validateCanonicalOverride', () => {
  it('пусто — норма: canonical у записи self', () => {
    expect(validateCanonicalOverride(undefined)).toBe(true);
    expect(validateCanonicalOverride(null)).toBe(true);
    expect(validateCanonicalOverride('')).toBe(true);
    expect(validateCanonicalOverride('   ')).toBe(true);
  });

  it('путь от корня принимается', () => {
    expect(validateCanonicalOverride('/otkrytki/otkrytka-mame')).toBe(true);
    expect(validateCanonicalOverride('/podborki/prazdniki/8-marta')).toBe(true);
  });

  it('абсолютный URL отклоняется: хост собирается из SITE_URL', () => {
    expect(validateCanonicalOverride('https://otkritka.test/otkrytki/x')).toEqual(
      expect.any(String),
    );
    expect(validateCanonicalOverride('//otkritka.test/otkrytki/x')).toEqual(expect.any(String));
  });

  it('параметры и фрагмент отклоняются: это не канонический путь', () => {
    expect(validateCanonicalOverride('/otkrytki/x?utm_source=vk')).toEqual(expect.any(String));
    expect(validateCanonicalOverride('/otkrytki/x#top')).toEqual(expect.any(String));
  });
});
