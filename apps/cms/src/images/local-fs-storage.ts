/**
 * Реализация {@link ImageStorage} на локальной файловой системе (задача Э2-04).
 *
 * Решение Ч-03 (2026-08-21): S3 снят с обязательных, до фактического переезда
 * файлы лежат на диске. Условие C4 переформулировано человеком под этот вариант:
 * вместо «раздельные бакеты и запрет листинга» — **раздельные каталоги и
 * оригиналы вне корня раздачи**. Требование ТЗ §6.1/§6.7 («оригиналы недоступны
 * по угадываемому URL») выполняется структурно и без S3:
 *
 *   - публичный корень (`derivativesRoot`) — единственное дерево, которое
 *     `apps/web` отдаёт по `/media/...` (задача Э2-04b). Оригиналов в нём нет;
 *   - корень оригиналов проверяется на вложенность в публичный корень ПРИ
 *     СОЗДАНИИ адаптера. Ошибка развёртывания, при которой оригиналы попали бы
 *     под раздачу, не поднимает CMS вовсе — вместо того чтобы обнаружиться
 *     первым же угаданным URL;
 *   - функции «по публичному пути найти оригинал» нет: имя оригинала —
 *     непредсказуемый идентификатор (`createOpaqueImageStorageId` в
 *     `@otkritka/images`), а связь «карточка → оригинал» живёт в записи CMS.
 *
 * Путь на диске проверяется ДВАЖДЫ: форму ключа — {@link assertStorageKey},
 * результат разрешения — на вложенность в корень. Двойная проверка не
 * избыточность: первая описывает «как выглядит ключ» и может однажды ослабнуть
 * при расширении набора символов, вторая отвечает на единственный важный вопрос
 * «остались ли мы внутри корня».
 */
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type ImageStorage, assertStorageKey } from './storage';

export interface LocalFsImageStorageOptions {
  /** Абсолютный путь к корню ПУБЛИЧНЫХ производных (его отдаёт apps/web по /media). */
  readonly derivativesRoot: string;
  /** Абсолютный путь к корню оригиналов. Обязан лежать ВНЕ корня производных. */
  readonly originalsRoot: string;
}

function assertAbsolute(value: string, name: string): string {
  if (value.trim() === '' || !path.isAbsolute(value)) {
    throw new Error(
      `Корень хранилища ${name} должен быть абсолютным путём, получено «${value}». ` +
        'Относительный путь зависел бы от рабочего каталога процесса, а у CMS их два ' +
        '(next dev и payload run) — файлы разъехались бы по двум деревьям.',
    );
  }
  return path.resolve(value);
}

/** Лежит ли `inner` внутри `outer` (или совпадает с ним). */
function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer + path.sep);
}

export function createLocalFsImageStorage(options: LocalFsImageStorageOptions): ImageStorage {
  const derivativesRoot = assertAbsolute(options.derivativesRoot, 'производных');
  const originalsRoot = assertAbsolute(options.originalsRoot, 'оригиналов');

  if (contains(derivativesRoot, originalsRoot) || contains(originalsRoot, derivativesRoot)) {
    throw new Error(
      `Корень оригиналов «${originalsRoot}» обязан лежать ВНЕ корня производных ` +
        `«${derivativesRoot}» (и наоборот). Это условие C4 в формулировке решения Ч-03: ` +
        'по /media отдаётся весь корень производных, поэтому оригинал, оказавшийся внутри ' +
        'него, доступен по угадываемому URL — а ТЗ §6.1 и §11 требуют обратного. ' +
        'Совпадение каталогов запрещено по той же причине.',
    );
  }

  /** Абсолютный путь объекта с проверкой того, что он остался внутри корня. */
  const resolveInside = (root: string, key: string): string => {
    assertStorageKey(key);
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(
        `Ключ «${key}» выводит за пределы корня хранилища «${root}». Операция отклонена: ` +
          'ключ приходит из данных записи, а данные записи правит внешний клиент.',
      );
    }
    return resolved;
  };

  const put = async (root: string, key: string, data: Buffer): Promise<void> => {
    const target = resolveInside(root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  };

  const exists = async (root: string, key: string): Promise<boolean> => {
    try {
      await access(resolveInside(root, key));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Убирает опустевшие каталоги вверх до корня.
   *
   * Нужно потому, что каталог производной — это сегмент `revision`, то есть хеш
   * содержимого: каждая замена изображения создаёт новый каталог и оставляет
   * прежний пустым. У объектного хранилища такой проблемы нет вовсе (каталогов
   * там нет), у локальной ФС без уборки со временем остаются тысячи пустых
   * папок. Отказ `rmdir` — нормальный конец обхода, а не сбой: значит в каталоге
   * лежит что-то ещё.
   */
  const pruneEmptyDirs = async (root: string, target: string): Promise<void> => {
    let dir = path.dirname(target);
    while (dir.startsWith(root + path.sep)) {
      try {
        await rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  };

  const remove = async (root: string, key: string): Promise<void> => {
    const target = resolveInside(root, key);
    // force: true — отсутствие объекта не ошибка: уборка после замены
    // изображения (Э2-06) идёт по сохранённым ключам и обязана быть
    // повторяемой.
    await rm(target, { force: true });
    await pruneEmptyDirs(root, target);
  };

  return {
    kind: 'local-fs',

    async putDerivative(key, data) {
      await put(derivativesRoot, key, data);
    },

    async putOriginal(key, data) {
      await put(originalsRoot, key, data);
    },

    async readOriginal(key) {
      const target = resolveInside(originalsRoot, key);
      try {
        return await readFile(target);
      } catch (error) {
        throw new Error(
          `Оригинал «${key}» не читается из хранилища: ${error instanceof Error ? error.message : String(error)}. ` +
            'Без оригинала перегенерация производных невозможна — файл восстанавливают из ' +
            'резервной копии, а не пересоздают из производной.',
        );
      }
    },

    async deleteDerivative(key) {
      await remove(derivativesRoot, key);
    },

    async deleteOriginal(key) {
      await remove(originalsRoot, key);
    },

    async hasDerivative(key) {
      return exists(derivativesRoot, key);
    },

    async hasOriginal(key) {
      return exists(originalsRoot, key);
    },
  };
}
