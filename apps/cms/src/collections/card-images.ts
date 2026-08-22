import type { CollectionConfig, Field } from 'payload';

import {
  adminOnlyAccess,
  adminOnlyFieldAccess,
  authenticatedAccess,
  contentWriteAccess,
  systemFieldAccess,
} from '../access/policies';
import { OUTPUT_FORMATS } from '@otkritka/images';
import { cardImageUploadHooks } from '../images/upload-hooks';
import { ACCEPTED_IMAGE_MIME_TYPES } from '../images/upload-validation';

/**
 * Изображения открыток (задача Э2-04) — коллекция с `upload`, которую ждало поле
 * `image` в `cards`.
 *
 * ГЛАВНОЕ РЕШЕНИЕ КОЛЛЕКЦИИ: `disableLocalStorage: true`. Собственный механизм
 * Payload сохранил бы файл в каталог `staticDir` и отдавал бы его по
 * `/api/card-images/file/<имя>` — то есть оригинал стал бы доступен по
 * предсказуемому URL, что прямо запрещено ТЗ §6.1 и §11. Вместо этого файлы
 * пишет адаптер хранилища (`../images/local-fs-storage.ts`): производные — в
 * публичное пространство, которое `apps/web` отдаёт по `/media/...` (Э2-04b),
 * оригинал — в каталог ВНЕ этого пространства, под непредсказуемым именем.
 *
 * Маршрут файла Payload при этом остаётся зарегистрированным, поэтому он
 * закрывается ЯВНО (`upload.handlers`): запрос отдаёт 404, а не «случайно не
 * находит файл». Разница принципиальна — второе перестало бы работать от одной
 * правки конфигурации.
 *
 * ЧТО ЛЕЖИТ В ЗАПИСИ. Всё, из чего собираются публичные адреса файлов:
 * `nameStem` (имя, занятое один раз), `nameSuffix` (число `N`), `revision`
 * (короткий хеш байтов), `keyBase` и `variants` с ключом, форматом и
 * ФАКТИЧЕСКИМИ размерами каждого файла. Это данные, а не вычислимая функция
 * настроек: пересчёт ключа из заголовка, лимита длины имени или набора ширин дал
 * бы другой путь при том же содержимом (условия C1, C8).
 *
 * Чего здесь НЕТ: `alt` и подписи. Они принадлежат карточке (ТЗ §8.1): одно и то
 * же изображение в разных контекстах описывается по-разному, а alt — часть
 * страницы, а не файла.
 */

/** Формат производной: набор закрыт набором вывода пайплайна. */
const formatOptions = OUTPUT_FORMATS.map((format) => ({ label: format, value: format }));

const systemAccess = { create: systemFieldAccess, update: systemFieldAccess } as const;

/**
 * Отказ на маршрут файла Payload.
 *
 * Возвращается 404, а не 403: существование объекта по этому адресу подтверждать
 * незачем. Оригиналы не отдаются вообще, производные отдаёт `apps/web` по
 * `/media/...` из ключей, сохранённых в записи.
 */
function refuseFileRoute(): Response {
  return Response.json(
    {
      errors: [
        {
          message:
            'Файлы этой коллекции не отдаются через API Payload. Производные доступны по ' +
            'публичным путям /media/... из поля variants; оригиналы не отдаются никогда ' +
            '(ТЗ §6.1).',
        },
      ],
    },
    { status: 404 },
  );
}

const cardImageFields: Field[] = [
  {
    name: 'title',
    type: 'text',
    required: true,
    admin: {
      description:
        'Описательное название изображения — из него один раз строится ИМЯ ФАЙЛА на ' +
        'транслите (например «Открытка маме на 8 марта с тюльпанами» → ' +
        'otkrytka-mame-na-8-marta-s-tyulpanami). После первой загрузки правка этого поля ' +
        'имя файла и пути производных НЕ меняет: URL файла постоянен (ТЗ §6.3).',
    },
  },
  {
    name: 'pHash',
    type: 'text',
    index: true,
    access: systemAccess,
    admin: {
      description:
        'Перцептивный хеш изображения (@otkritka/images). Снаружи не пишется: иначе поиск ' +
        'визуальных дублей обходился бы подстановкой чужого значения.',
      readOnly: true,
    },
  },
  {
    name: 'nameStem',
    type: 'text',
    unique: true,
    index: true,
    access: systemAccess,
    admin: {
      description:
        'Имя файла на транслите вместе с суффиксом -N, занятое ОДИН раз при загрузке ' +
        '(реестр image-name-claims). При замене изображения остаётся прежним — меняется ' +
        'только revision.',
      readOnly: true,
    },
  },
  {
    name: 'nameSuffix',
    type: 'number',
    min: 2,
    access: systemAccess,
    admin: {
      description:
        'Число N в суффиксе -N. Пусто у первого имени. После удаления записи номер не ' +
        'переиспользуется: реестр занятых имён строк не теряет.',
      readOnly: true,
    },
  },
  {
    name: 'revision',
    type: 'text',
    access: systemAccess,
    admin: {
      description:
        'Короткий хеш БАЙТОВ оригинала (Ч-28). Меняется только при замене изображения — ' +
        'тогда меняются URL всех производных при неизменном URL карточки (ТЗ §6.7). ' +
        'Сохранение записи ревизию не трогает (условие C2).',
      readOnly: true,
    },
  },
  {
    name: 'keyBase',
    type: 'text',
    access: systemAccess,
    admin: {
      description:
        'Общая часть ключей производных: <префикс>/<revision>/<имя>. Хранится, а не ' +
        'пересчитывается (условие C1).',
      readOnly: true,
    },
  },
  {
    name: 'storageId',
    type: 'text',
    unique: true,
    access: { ...systemAccess, read: adminOnlyFieldAccess },
    admin: {
      description:
        'Непредсказуемый идентификатор оригинала (128 бит). Читается только админом: ' +
        'публиковать его незачем, а оригинал по нему не отдаётся вовсе.',
      readOnly: true,
    },
  },
  {
    name: 'originalKey',
    type: 'text',
    access: { ...systemAccess, read: adminOnlyFieldAccess },
    admin: {
      description:
        'Ключ оригинала в НЕПУБЛИЧНОМ пространстве хранилища. Из публичного пути ' +
        'производной не выводится и по HTTP не отдаётся.',
      readOnly: true,
    },
  },
  {
    name: 'variants',
    type: 'array',
    access: systemAccess,
    admin: {
      description:
        'Производные: ключ, формат и ФАКТИЧЕСКИЕ размеры каждого файла. Из этого поля ' +
        'apps/web берёт и путь, и дескриптор w в srcset, и атрибуты width/height — из ' +
        'одного места (условие C8), а не пересчитывает из настроек.',
      readOnly: true,
    },
    fields: [
      { name: 'key', type: 'text', required: true },
      { name: 'format', type: 'select', options: formatOptions, required: true },
      { name: 'width', type: 'number', required: true },
      { name: 'height', type: 'number', required: true },
      { name: 'byteSize', type: 'number', required: true },
    ],
  },
  {
    name: 'source',
    type: 'group',
    label: 'Исходник (служебное)',
    access: systemAccess,
    admin: {
      description:
        'Что было на входе, по метаданным: размеры ПОСЛЕ применения EXIF Orientation и ' +
        'значение самого тега. Нужны для разбора «почему производных меньше, чем ширин».',
      readOnly: true,
    },
    fields: [
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      { name: 'format', type: 'text' },
      { name: 'exifOrientation', type: 'number' },
    ],
  },
];

export const CardImages: CollectionConfig = {
  slug: 'card-images',
  labels: {
    singular: 'Изображение открытки',
    plural: 'Изображения открыток',
  },
  admin: {
    defaultColumns: ['title', 'nameStem', 'revision', 'updatedAt'],
    description:
      'Файлы открыток. При загрузке считаются производные AVIF/WebP/JPEG и перцептивный ' +
      'хеш; оригинал сохраняется вне публичного пространства. Имя файла и его URL ' +
      'постоянны: правка названия их не меняет.',
    useAsTitle: 'title',
  },
  access: {
    // Загружать изображения вправе и сервисный аккаунт (граница автоматизации из
    // CLAUDE.md): агент готовит контент, но не публикует его.
    create: contentWriteAccess,
    // Удаляет только человек: файл может стоять на опубликованной странице, а
    // URL файла постоянен — удаление это решение, а не уборка.
    delete: adminOnlyAccess,
    // Метаданные изображения — часть чернового контента, поэтому анонимно не
    // читаются: иначе по API можно было бы перечислить производные ещё не
    // опубликованных открыток. Публичный рендер (этап 3) обращается к Payload
    // серверной стороной.
    read: authenticatedAccess,
    update: contentWriteAccess,
  },
  hooks: cardImageUploadHooks(),
  upload: {
    // Payload не хранит и не отдаёт файлы: раскладку делает адаптер хранилища.
    disableLocalStorage: true,
    // Обрезка и фокальная точка выключены: они меняли бы БАЙТЫ оригинала уже
    // после расчёта ревизии редактором и создавали второй путь изменения
    // изображения помимо явной замены файла (Э2-06).
    crop: false,
    focalPoint: false,
    // Первая линия проверки типа: до хука и до чтения байтов.
    mimeTypes: [...ACCEPTED_IMAGE_MIME_TYPES],
    filesRequiredOnCreate: true,
    // Маршрут файла закрыт явно — см. докстринг коллекции.
    handlers: [refuseFileRoute],
    // Загрузка по URL выключена: сервер не должен ходить за файлами на чужие
    // хосты по данным из запроса.
    pasteURL: false,
  },
  fields: cardImageFields,
};
