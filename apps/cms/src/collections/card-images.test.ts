/**
 * Коллекции изображений (задача Э2-04): проверяется КОНФИГ, а не Payload.
 *
 * Здесь закрываются те требования, которые иначе держались бы на настройке
 * сервера или на памяти разработчика:
 *   - Payload не хранит и не отдаёт файлы сам (`disableLocalStorage`), а маршрут
 *     файла закрыт ЯВНО. Иначе оригинал был бы доступен по предсказуемому
 *     `/api/card-images/file/<имя>` — прямое нарушение ТЗ §6.1;
 *   - служебные поля пути (ключи, ревизия, имя, суффикс, pHash) снаружи не
 *     пишутся: подмена ключа означала бы подмену публичного URL файла;
 *   - реестр занятых имён не удаляется и не правится никем: иначе суффикс `-N`
 *     вернулся бы в оборот после удаления записи;
 *   - требование «изображение заполнено» перед review включилось само, как
 *     только поле `image` появилось в схеме.
 */
import type { Field } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  adminOnlyAccess,
  adminOnlyFieldAccess,
  authenticatedAccess,
  cardImageFieldAccess,
  contentWriteAccess,
  systemFieldAccess,
} from '../access/policies';
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_UPLOAD_BYTES } from '../images/upload-validation';
import { CardImages } from './card-images';
import { Cards } from './cards';
import { collectFieldNames } from './content-hooks';
import { ImageNameClaims } from './image-name-claims';
import { CARD_REVIEW_REQUIREMENTS, missingReviewFields } from './status-model';

function findField(fields: readonly Field[], name: string): Field {
  const field = fields.find((candidate) => 'name' in candidate && candidate.name === name);
  if (field === undefined) {
    throw new Error(`Поле «${name}» в коллекции не найдено`);
  }
  return field;
}

function accessOf(field: Field): Record<string, unknown> | undefined {
  return 'access' in field ? field.access : undefined;
}

describe('card-images: хранение и отдача файлов', () => {
  it('Payload не пишет файлы на диск: раскладку делает адаптер хранилища', () => {
    // С включённым локальным хранением Payload разложил бы оригинал в staticDir и
    // отдавал бы его по /api/card-images/file/<имя> — то есть по угадываемому URL.
    expect(CardImages.upload).toBeTruthy();
    expect(typeof CardImages.upload === 'object' ? CardImages.upload.disableLocalStorage : undefined).toBe(
      true,
    );
  });

  it('маршрут файла закрыт явно: 404 на любой запрос', async () => {
    const upload = typeof CardImages.upload === 'object' ? CardImages.upload : undefined;
    const handler = upload?.handlers?.[0];
    expect(typeof handler).toBe('function');

    // Тип обработчика Payload требует req; для проверки достаточно того, что
    // ответ не зависит от запроса — оригиналы не отдаются никогда.
    const response = await handler?.(
      {} as unknown as Parameters<NonNullable<typeof handler>>[0],
      {} as unknown as Parameters<NonNullable<typeof handler>>[1],
    );
    expect(response instanceof Response).toBe(true);
    expect(response instanceof Response ? response.status : 0).toBe(404);
  });

  it('тип и размер ограничены теми же значениями, что проверяет хук', () => {
    const upload = typeof CardImages.upload === 'object' ? CardImages.upload : undefined;
    expect(upload?.mimeTypes).toEqual([...ACCEPTED_IMAGE_MIME_TYPES]);
    expect(upload?.filesRequiredOnCreate).toBe(true);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
  });

  it('кроп, фокальная точка и загрузка по URL выключены', () => {
    // Кроп и фокальная точка меняли бы БАЙТЫ оригинала помимо явной замены
    // файла (Э2-06) — то есть создавали второй путь смены URL производных.
    const upload = typeof CardImages.upload === 'object' ? CardImages.upload : undefined;
    expect(upload?.crop).toBe(false);
    expect(upload?.focalPoint).toBe(false);
    expect(upload?.pasteURL).toBe(false);
  });

  it('хуки пайплайна подключены на всех фазах', () => {
    expect(CardImages.hooks?.beforeChange).toHaveLength(1);
    // Три хука в afterChange, и порядок значим: запись подготовленных файлов →
    // пересинхронизация зеркала в карточках (Э3-03a) → уборка прежних файлов.
    // Запись перенесена сюда из beforeChange (находка ревизии от 2026-08-22):
    // до записи документа в публичном пространстве не должно появляться ни
    // одного файла. Пересинхронизация стоит между записью и уборкой: иначе
    // остался бы промежуток, в котором зеркало карточки указывает на уже
    // удалённые объекты.
    //
    // ЗДЕСЬ проверяется только ЧИСЛО: конфиг не знает, что хуки делают.
    // Сам ПОРЯДОК вызовов закрыт протоколом в `../images/upload-hooks.test.ts`
    // («порядок фаз: новые файлы → зеркало → уборка прежних») — иначе
    // перестановка при рефакторинге не уронила бы ни один тест.
    expect(CardImages.hooks?.afterChange).toHaveLength(3);
    expect(CardImages.hooks?.afterDelete).toHaveLength(1);
    // Отказ на удаление изображения, на которое ссылается карточка: связь
    // каскадная на уровне базы, и без этого хука зеркало карточки осталось бы с
    // ключами удалённых файлов (Э3-03a, находка ревизии от 2026-08-22).
    expect(CardImages.hooks?.beforeDelete).toHaveLength(1);
  });
});

describe('card-images: права', () => {
  it('загружает и правит admin и ai-editor, удаляет только человек', () => {
    expect(CardImages.access?.create).toBe(contentWriteAccess);
    expect(CardImages.access?.update).toBe(contentWriteAccess);
    expect(CardImages.access?.delete).toBe(adminOnlyAccess);
  });

  it('анонимного чтения метаданных нет: это часть чернового контента', () => {
    expect(CardImages.access?.read).toBe(authenticatedAccess);
  });

  it('служебные поля пути снаружи не пишутся', () => {
    for (const name of [
      'pHash',
      'nameStem',
      'nameSuffix',
      'revision',
      'keyBase',
      'storageId',
      'originalKey',
      'variants',
      'source',
    ]) {
      const access = accessOf(findField(CardImages.fields, name));
      expect(access?.create, `${name}.create`).toBe(systemFieldAccess);
      expect(access?.update, `${name}.update`).toBe(systemFieldAccess);
    }
  });

  it('идентификатор и ключ оригинала читает только admin', () => {
    for (const name of ['storageId', 'originalKey']) {
      expect(accessOf(findField(CardImages.fields, name))?.read, name).toBe(adminOnlyFieldAccess);
    }
  });

  it('имя файла уникально в пределах коллекции', () => {
    const nameStem = findField(CardImages.fields, 'nameStem');
    expect('unique' in nameStem ? nameStem.unique : undefined).toBe(true);
  });
});

describe('image-name-claims: реестр занятых имён', () => {
  it('не создаётся, не правится и не удаляется снаружи — включая admin', () => {
    // Удаление строки означало бы освобождение номера -N, то есть выдачу уже
    // использованного пути другому изображению.
    expect(ImageNameClaims.access?.create?.({} as never)).toBe(false);
    expect(ImageNameClaims.access?.update?.({} as never)).toBe(false);
    expect(ImageNameClaims.access?.delete?.({} as never)).toBe(false);
  });

  it('stem уникален и проиндексирован: уникальность держит база, а не запрос', () => {
    const stem = findField(ImageNameClaims.fields, 'stem');
    expect('unique' in stem ? stem.unique : undefined).toBe(true);
    expect('index' in stem ? stem.index : undefined).toBe(true);
    expect('required' in stem ? stem.required : undefined).toBe(true);
  });
});

describe('cards: поле image', () => {
  it('связано с коллекцией загрузки card-images', () => {
    const image = findField(Cards.fields, 'image');
    expect(image.type).toBe('upload');
    expect('relationTo' in image ? image.relationTo : undefined).toBe('card-images');
  });

  it('после первой публикации меняется только admin', () => {
    const access = accessOf(findField(Cards.fields, 'image'));
    expect(access?.create).toBe(cardImageFieldAccess);
    expect(access?.update).toBe(cardImageFieldAccess);
  });

  it('требование «изображение заполнено» перед review включилось само', () => {
    const missing = missingReviewFields({
      data: {
        alt: 'alt',
        caption: 'подпись',
        collections: [1],
        metaDescription: 'Описание для выдачи',
        title: 'Заголовок',
      },
      knownFields: collectFieldNames(Cards.fields),
      requirements: CARD_REVIEW_REQUIREMENTS,
    });
    expect(missing.map((item) => item.field)).toEqual(['image']);
  });

  it('решение о визуальном дубле хранится в записи и снаружи не подделывается', () => {
    const gate = findField(Cards.fields, 'visualDuplicate');
    const inner = 'fields' in gate ? gate.fields : [];

    // Список похожих и отпечаток решения ставит хук: иначе «уникально» можно
    // было бы выдать сразу для любого набора.
    for (const name of ['similar', 'decisionFor', 'decidedAt']) {
      const access = accessOf(findField(inner, name));
      expect(access?.create, `${name}.create`).toBe(systemFieldAccess);
      expect(access?.update, `${name}.update`).toBe(systemFieldAccess);
    }

    // А решение и подтверждение редактор ставит сам.
    expect(accessOf(findField(inner, 'decision'))).toBeUndefined();
    expect(accessOf(findField(inner, 'confirm'))).toBeUndefined();
  });

  it('хуки изображения добавлены к общим, а не заменяют их', () => {
    // Правила статусной модели обязаны остаться первыми: отказ по правам должен
    // звучать раньше отказа «есть похожее изображение».
    //
    // Четыре хука beforeValidate: привязка подборок в пакете (Э5-06 — идёт
    // ПЕРВОЙ, потому что переписывает значение связи, и правила ниже обязаны
    // видеть итоговый список), правила статусной модели, проверка дублей
    // метатегов (Э5-01, общая фабрика) и зеркало изображения с калиткой
    // визуальных дублей. Число проверяется не ради числа: пропавший хук — это
    // тихо отключённая калитка, а порядок задаёт, какой отказ услышит редактор.
    expect(Cards.hooks?.beforeValidate).toHaveLength(4);
    expect(Cards.hooks?.beforeChange).toHaveLength(2);
    // Два: правила статусной модели на сырых данных плюс громкий отказ на
    // попытку сменить изображение публиковавшейся карточки.
    expect(Cards.hooks?.beforeOperation).toHaveLength(2);
    expect(Cards.hooks?.afterChange).toHaveLength(2);
  });
});
