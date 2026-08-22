/**
 * Отдача производных по `/media/<ключ>` в apps/web (задача Э2-04b) — правила,
 * которые можно проверить без поднятого сервера.
 *
 * Живые проверки (заголовки настоящего ответа, отсутствие листинга, обход
 * каталога через настоящий HTTP) делает смоук `apps/web/scripts/smoke-media.mjs`:
 * ответы сервера тестом файловой системы не проверяются. Здесь — решение по пути
 * и выбор корня отдачи, то есть то, что определяет, какой файл вообще будет
 * прочитан.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { derivativeCacheHeaders, IMMUTABLE_CACHE_CONTROL } from '@otkritka/images/media';

import {
  decideMediaRequest,
  MEDIA_ROOT_ENV_KEY,
  resolveMediaRoot,
} from '../../apps/web/src/server/media-files.js';

const KEY = 'cards/a1b2c3d4/otkrytka-mame-na-8-marta-640.webp';

describe('решение по пути /media', () => {
  it('адрес производной превращается в чтение файла с заголовками из общего пакета', () => {
    const decision = decideMediaRequest(`/media/${KEY}`);
    expect(decision.action).toBe('file');
    if (decision.action !== 'file') {
      return;
    }
    expect(decision.key).toBe(KEY);
    // Заголовки НЕ переписаны здесь: сравнение идёт с функцией контракта, а не
    // со строкой. Два написания Cache-Control расходятся молча, а кеш выдан на
    // год (immutable).
    expect(decision.headers).toEqual(derivativeCacheHeaders(KEY));
    expect(decision.headers['Cache-Control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(decision.headers['Content-Type']).toBe('image/webp');
  });

  it('чужой путь этот слой не трогает', () => {
    // «not-media» означает «решает кто-то другой»: страницы, robots.txt,
    // sitemap.xml и статика сборки отдаются прежним порядком.
    for (const pathname of ['/', '/otkrytki/8-marta', '/robots.txt', '/_astro/x.css']) {
      expect(decideMediaRequest(pathname).action).toBe('not-media');
    }
  });

  it('сам каталог /media не отдаётся и листинга не порождает', () => {
    // `/media` — маршрут страницы, поэтому сюда он приходит как «не наш»: файла
    // с таким именем в сборке нет, и ответ будет 404 от приложения. Важно
    // другое: этот слой на нём НЕ обращается к файловой системе вовсе, поэтому
    // ни списка, ни индексного файла отдать не может.
    expect(decideMediaRequest('/media').action).toBe('not-media');
    // `/media/` до этого слоя не доходит (одиночный 301 на /media), но решение
    // обязано быть определено и здесь.
    expect(decideMediaRequest('/media/').action).toBe('not-found');
  });

  it('обход каталога и любая непринятая форма ключа — 404, а не чтение файла', () => {
    const refused = [
      '/media/../uploads/originals/deadbeef.jpg',
      '/media/cards/../../uploads/originals/deadbeef.jpg',
      '/media/..%2Fuploads%2Foriginals%2Fdeadbeef.jpg',
      '/media/cards\\a1b2c3d4\\otkrytka-640.webp',
      '/media/C:/Windows/win.ini',
      '/media/cards',
      '/media/cards/a1b2c3d4',
      '/media/cards/a1b2c3d4/Otkrytka-640.WEBP',
      '/media/cards/a1b2c3d4/otkrytka-640.exe',
    ];
    for (const pathname of refused) {
      expect(decideMediaRequest(pathname).action, pathname).toBe('not-found');
    }
  });

  it('расширение вне набора вывода пайплайна файлом не считается', () => {
    // Форма ключа его пропускает (буквы и цифры), а набор форматов — нет.
    // Отдавать «что нашлось» из публичного корня нельзя: в нём лежат только
    // файлы пайплайна, и всё прочее там означает ошибку, а не новый тип файла.
    expect(decideMediaRequest('/media/cards/a1b2c3d4/otkrytka-640.txt').action).toBe('not-found');
  });
});

describe('корень отдачи производных', () => {
  // Абсолютный путь фикстуры зависит от платформы: на Windows `/repo` — это
  // корень ТЕКУЩЕГО диска, то есть значение не абсолютное в смысле `path`.
  const workspace = process.platform === 'win32' ? 'C:\\repo' : '/repo';

  it('относительное значение разрешается от корня монорепозитория', () => {
    // Ровно то же правило, что у apps/cms (`src/images/storage-env.ts`):
    // рабочий каталог процесса у web и cms разный, а дерево файлов одно.
    expect(resolveMediaRoot({ [MEDIA_ROOT_ENV_KEY]: 'media' }, workspace)).toBe(
      join(workspace, 'media'),
    );
  });

  it('абсолютное значение берётся как есть', () => {
    const absolute = process.platform === 'win32' ? 'C:\\srv\\media' : '/srv/media';
    expect(resolveMediaRoot({ [MEDIA_ROOT_ENV_KEY]: absolute }, workspace)).toBe(absolute);
  });

  it('незаданное значение валит отдачу с внятной ошибкой, а не подставляет каталог', () => {
    // Дефолта нет намеренно (условие C4 решения Ч-03): подставленный корень
    // означал бы либо битые изображения, либо оригиналы под раздачей.
    expect(() => resolveMediaRoot({}, workspace)).toThrow(new RegExp(MEDIA_ROOT_ENV_KEY));
    expect(() => resolveMediaRoot({ [MEDIA_ROOT_ENV_KEY]: '   ' }, workspace)).toThrow(
      new RegExp(MEDIA_ROOT_ENV_KEY),
    );
  });
});
