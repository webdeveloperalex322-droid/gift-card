/**
 * Смоук слоя доступа к данным apps/web на ЖИВОЙ базе (задача Э3-02).
 *
 * ## Что здесь проверяется и почему только здесь
 *
 * Юнит-тесты (`apps/web/src/data/data-access.test.ts`) доказывают, что запросы
 * уходят с `overrideAccess` в значении false и без пользователя. Они НЕ
 * доказывают главного: что Payload при таких параметрах действительно не отдаёт
 * `draft` и `review`. Это свойство фаз access control поднятого ядра, и проверить
 * его можно только на настоящей базе — поштучно, подбором параметров и прямым
 * обращением по идентификатору.
 *
 * Запуск (tsx-загрузчик приходит вместе с CLI Payload):
 *
 *   pnpm --filter @otkritka/cms exec payload run ../web/scripts/smoke-data.ts
 *
 * ## Про то, что смоук ПУБЛИКУЕТ записи
 *
 * Публикует — иначе «черновик не отдаётся» ничего не значит: надо показать, что
 * опубликованная запись при тех же параметрах отдаётся. Публикация выполняется
 * от лица администратора из базы, ровно как в смоуках `apps/cms`, и относится к
 * временным записям с префиксом `smoke-e3-02-`, которые скрипт удаляет за собой
 * в `finally` и проверяет отдельной строкой отчёта. Граница автоматизации из
 * CLAUDE.md этим не сдвигается: продуктовый код не публикует ничего, публикация
 * живёт в одноразовом скрипте проверки на локальной базе разработчика. Незакрытая
 * уборка здесь означала бы опубликованную заглушку в каталоге, поэтому итог
 * уборки печатается числами.
 *
 * ## Фикстура изображения
 *
 * Берётся из соседнего приложения относительным путём
 * (`apps/cms/src/images/png-fixture.ts`) намеренно: это тестовая фикстура, и
 * выносить её в публичный контракт пакета `@otkritka/cms` ради смоука нельзя, а
 * второй PNG-кодировщик в репозитории — это второй ответ на один вопрос.
 * Изображение нужно потому, что карточку без изображения нельзя перевести даже в
 * `review` (CARD_REVIEW_REQUIREMENTS).
 */

import { existsSync } from 'node:fs';
import { inspect } from 'node:util';
import path from 'node:path';

import type { Payload } from 'payload';

import type { Collection } from '@otkritka/cms/types';

import { createPngFixture } from '../../cms/src/images/png-fixture.js';
import {
  findCardBySlug,
  findCollectionById,
  findCollectionByPath,
  listChildCollections,
  listCollectionCards,
  listRecentCards,
  listRelatedCollections,
  listSeasonalCollections,
  payloadClient,
  readSiteSettings,
  relationIds,
} from '../src/data/index.js';

interface Check {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ detail, name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Итог уборки. Считается один раз, читается на верхнем уровне. */
interface CleanupOutcome {
  /** Опубликованных записей после уборки не осталось. */
  readonly clean: boolean;
}

let outcomeValue: CleanupOutcome | null = null;

/**
 * Чтение итога ФУНКЦИЕЙ: присваивание живёт внутри вложенной функции, и анализ
 * потока управления TypeScript на верхнем уровне модуля сузил бы переменную до
 * `never` после проверки на `null`.
 */
function readOutcome(): CleanupOutcome | null {
  return outcomeValue;
}

/**
 * Ждёт, пока stdout уйдёт в дескриптор: `process.exit` очередь вывода не
 * дожидается, а перехваченный stdout на Windows — конвейер, и теряются именно
 * последние строки.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write('', () => {
      resolve();
    });
  });
}

/**
 * Минимальный валидный lexical-документ: вводный текст подборки.
 *
 * Тип берётся из СГЕНЕРИРОВАННЫХ типов Payload, а не описывается вручную: у
 * lexical-узла обязательны `direction`, `format`, `indent` и `version`, и
 * «примерно похожая» структура просто не сохранится.
 */
const RICH_TEXT: NonNullable<Collection['intro']> = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Смоук Э3-02',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
};

/** День внутри окна показа сезонной подборки. Фиксированный: тест не зависит от «сегодня». */
const SEASONAL_DAY = new Date('2026-03-01T12:00:00.000Z');

async function main(): Promise<void> {
  // ТОТ ЖЕ экземпляр Payload, которым читает продуктовый слой: два экземпляра
  // означали бы два пула подключений и, что важнее, проверку не того кода.
  const payload: Payload = await payloadClient();

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
  };
  const claimedStems: string[] = [];

  /**
   * Уборка выполняется ровно один раз — из `finally` штатного пути ИЛИ из
   * обработчика сигнала. Обещание запоминается ДО разрешения: сигнал посреди
   * штатной уборки ждёт её же.
   */
  let cleanupStarted: Promise<CleanupOutcome> | null = null;
  const cleanupOnce = (): Promise<CleanupOutcome> => {
    cleanupStarted ??= runCleanup();
    return cleanupStarted;
  };

  /**
   * УБОРКА ПО СИГНАЛУ. `finally` при `Ctrl+C` не исполняется, а смоук ПУБЛИКУЕТ
   * фикстуры: прерванный прогон оставлял бы их на локальном сайте.
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    void (async (): Promise<void> => {
      console.log(`\nПрогон прерван сигналом ${signal}: выполняется уборка, дождитесь её конца.`);
      await cleanupOnce();
      await flushStdout();
      process.exit(1);
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, onSignal);
  }

  try {
    const admins = await payload.find({
      collection: 'users',
      limit: 1,
      where: { role: { equals: 'admin' } },
    });
    const adminDoc = admins.docs[0];
    if (adminDoc === undefined) {
      throw new Error('В базе нет администратора: запустите CMS один раз, чтобы создался первый.');
    }
    const admin = { ...adminDoc, collection: 'users' as const };
    const asAdmin = { overrideAccess: false as const, user: admin };

    const uploadImage = async (title: string, composition: 'grid' | 'rings'): Promise<number> => {
      const bytes = createPngFixture({ composition, height: 500, width: 800 });
      const image = await payload.create({
        collection: 'card-images',
        data: { title },
        file: {
          data: bytes,
          mimetype: 'image/png',
          name: `${composition}.png`,
          size: bytes.byteLength,
        },
        ...asAdmin,
      });
      created.cardImages.push(image.id);
      if (typeof image.nameStem === 'string') {
        claimedStems.push(image.nameStem);
      }
      return image.id;
    };

    /* ---------------------------------------------------------------- */
    /* Подборки: группа (published) → повод (published), плюс draft и    */
    /* review под той же группой                                        */
    /* ---------------------------------------------------------------- */

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smoke-e3-02-gruppa',
        status: 'draft',
        title: 'Смоук Э3-02: группа',
      },
      ...asAdmin,
    });
    created.collections.push(group.id);

    const makeNode = async (args: {
      readonly slug: string;
      readonly title: string;
      readonly seasonal?: boolean;
    }): Promise<number> => {
      const node = await payload.create({
        collection: 'collections',
        data: {
          intro: RICH_TEXT,
          metaDescription: `Смоук Э3-02: ${args.title}`,
          nodeKind: 'occasion',
          parent: group.id,
          related: [group.id],
          responsibleEditor: admin.id,
          robots: 'noindex,follow',
          ...(args.seasonal === true
            ? {
                seasonal: {
                  holidayDate: '2026-03-08T00:00:00.000Z',
                  showFrom: '2026-02-01T00:00:00.000Z',
                  showUntil: '2026-03-09T00:00:00.000Z',
                },
              }
            : {}),
          slug: args.slug,
          status: 'draft',
          title: args.title,
        },
        ...asAdmin,
      });
      created.collections.push(node.id);
      return node.id;
    };

    const publish = async (
      collection: 'cards' | 'collections',
      id: number,
    ): Promise<void> => {
      await payload.update({ collection, id, data: { status: 'review' }, ...asAdmin });
      await payload.update({ collection, id, data: { status: 'published' }, ...asAdmin });
    };

    const publishedNodeId = await makeNode({
      seasonal: true,
      slug: 'smoke-e3-02-published',
      title: 'Смоук Э3-02: опубликованный узел',
    });
    const reviewNodeId = await makeNode({
      slug: 'smoke-e3-02-review',
      title: 'Смоук Э3-02: узел в review',
    });
    const draftNodeId = await makeNode({
      seasonal: true,
      slug: 'smoke-e3-02-draft',
      title: 'Смоук Э3-02: узел в draft',
    });

    // Полнота группы доводится СРАЗУ, а публикация — позже: перед `review` у
    // подборки обязаны быть вводный текст, description, перелинковка и
    // ответственный редактор.
    await payload.update({
      collection: 'collections',
      id: group.id,
      data: {
        intro: RICH_TEXT,
        metaDescription: 'Смоук Э3-02: группа',
        related: [publishedNodeId],
        responsibleEditor: admin.id,
      },
      ...asAdmin,
    });
    await payload.update({
      collection: 'collections',
      id: reviewNodeId,
      data: { status: 'review' },
      ...asAdmin,
    });

    /* ---------------------------------------------------------------- */
    /* Карточки: published, review, draft                               */
    /* ---------------------------------------------------------------- */

    const makeCard = async (args: {
      readonly composition?: 'grid' | 'rings';
      readonly slug: string;
      readonly title: string;
    }): Promise<number> => {
      const imageId =
        args.composition === undefined ? undefined : await uploadImage(args.title, args.composition);
      const card = await payload.create({
        collection: 'cards',
        data: {
          alt: `Смоук Э3-02: ${args.title}`,
          caption: 'Подпись смоука',
          collections: [publishedNodeId],
          ...(imageId === undefined ? {} : { image: imageId }),
          robots: 'noindex,follow',
          slug: args.slug,
          status: 'draft',
          title: args.title,
        },
        ...asAdmin,
      });
      created.cards.push(card.id);
      return card.id;
    };

    const publishedCardId = await makeCard({
      composition: 'grid',
      slug: 'smoke-e3-02-otkrytka-published',
      title: 'Смоук Э3-02: опубликованная открытка',
    });
    const reviewCardId = await makeCard({
      composition: 'rings',
      slug: 'smoke-e3-02-otkrytka-review',
      title: 'Смоук Э3-02: открытка в review',
    });
    const draftCardId = await makeCard({
      slug: 'smoke-e3-02-otkrytka-draft',
      title: 'Смоук Э3-02: открытка в draft',
    });

    await publish('cards', publishedCardId);
    await payload.update({
      collection: 'cards',
      id: reviewCardId,
      data: { status: 'review' },
      ...asAdmin,
    });

    /* ---------------------------------------------------------------- */
    /* Публикация узлов — ПОСЛЕ открыток, снизу вверх                   */
    /* ---------------------------------------------------------------- */
    //
    // ПОРЯДОК ЗНАЧИМ, и раньше он был обратным — из-за чего смоук был красным.
    // CMS отказывает в публикации узла, у которого нет ни одной опубликованной
    // открытки и ни одного опубликованного дочернего узла
    // (`assertNotEmptyForPublish`, отказ `empty-for-publish`): опубликованный
    // пустой узел отдавал бы 404 при статусе «опубликовано». Отсюда единственный
    // допустимый порядок: сначала открытки, потом узел, к которому они привязаны,
    // и только потом его родитель — у него содержание это дочерний узел. Тот же
    // порядок в `smoke-pages.ts` и `smoke-home-search.ts`.
    await publish('collections', publishedNodeId);
    await publish('collections', group.id);

    /* ---------------------------------------------------------------- */
    /* 1. Положительный путь: опубликованное читается                   */
    /* ---------------------------------------------------------------- */

    const publishedCard = await findCardBySlug('smoke-e3-02-otkrytka-published');
    record(
      'опубликованная карточка читается по slug',
      publishedCard?.id === publishedCardId,
      `id=${String(publishedCard?.id)}`,
    );

    const publishedNode = await findCollectionByPath('/podborki/smoke-e3-02-gruppa/smoke-e3-02-published');
    record(
      'опубликованная подборка читается по итоговому пути',
      publishedNode?.id === publishedNodeId,
      `path=${String(publishedNode?.path)}`,
    );

    const cardsPage = await listCollectionCards({ collectionId: publishedNodeId, page: 1 });
    record(
      'список карточек подборки содержит только опубликованную',
      cardsPage.cards.length === 1 && cardsPage.cards[0]?.id === publishedCardId,
      `всего=${String(cardsPage.totalCards)} страниц=${String(cardsPage.pageCount)}`,
    );

    const children = await listChildCollections(group.id);
    record(
      'дети группы — только опубликованный узел',
      children.length === 1 && children[0]?.id === publishedNodeId,
      `детей=${String(children.length)}`,
    );

    const parent = await findCollectionById(relationIds([publishedNode?.parent]).at(0) ?? null);
    record('родитель узла читается', parent?.id === group.id, `id=${String(parent?.id)}`);

    const related = await listRelatedCollections(relationIds(publishedNode?.related));
    record(
      'смежные подборки читаются',
      related.length === 1 && related[0]?.id === group.id,
      `смежных=${String(related.length)}`,
    );

    const recent = await listRecentCards(10);
    record(
      'свежие карточки: есть опубликованная, нет черновиков',
      recent.some((card) => card.id === publishedCardId) &&
        !recent.some((card) => card.id === draftCardId || card.id === reviewCardId),
      `получено=${String(recent.length)}`,
    );

    const seasonal = await listSeasonalCollections(SEASONAL_DAY);
    record(
      'сезонный блок: опубликованный узел в окне показа',
      seasonal.some((node) => node.id === publishedNodeId),
      `узлов=${String(seasonal.length)}`,
    );
    record(
      'сезонный блок не показывает черновик, попадающий в окно',
      !seasonal.some((node) => node.id === draftNodeId),
    );

    const settings = await readSiteSettings();
    record(
      'глобал настроек читается анонимно',
      typeof settings === 'object' && settings !== null,
      `id=${String(settings.id)}`,
    );
    record(
      'группа аудита анонимному читателю не отдаётся',
      Object.keys(settings.audit ?? {}).length === 0,
      JSON.stringify(settings.audit ?? {}),
    );

    /* ---------------------------------------------------------------- */
    /* 2. Негативный путь: draft и review публично не существуют        */
    /* ---------------------------------------------------------------- */

    record('карточка в draft по slug не отдаётся', (await findCardBySlug('smoke-e3-02-otkrytka-draft')) === null);
    record('карточка в review по slug не отдаётся', (await findCardBySlug('smoke-e3-02-otkrytka-review')) === null);
    record(
      'подборка в draft по пути не отдаётся',
      (await findCollectionByPath('/podborki/smoke-e3-02-gruppa/smoke-e3-02-draft')) === null,
    );
    record(
      'подборка в review по пути не отдаётся',
      (await findCollectionByPath('/podborki/smoke-e3-02-gruppa/smoke-e3-02-review')) === null,
    );

    // Подбор параметров: прямой запрос по идентификатору, запрос по статусу,
    // draft-режим версий. Ни один не должен вернуть запись.
    const byId = await payload.find({
      collection: 'cards',
      depth: 0,
      overrideAccess: false,
      where: { id: { equals: draftCardId } },
    });
    record('прямой запрос по id черновика — пусто', byId.totalDocs === 0, `docs=${String(byId.totalDocs)}`);

    const byStatus = await payload.find({
      collection: 'cards',
      depth: 0,
      overrideAccess: false,
      where: { status: { in: ['draft', 'review'] } },
    });
    record(
      'запрос «дай мне черновики» — пусто',
      byStatus.totalDocs === 0,
      `docs=${String(byStatus.totalDocs)}`,
    );

    const byIdDirect = await payload.findByID({
      collection: 'cards',
      id: draftCardId,
      depth: 0,
      disableErrors: true,
      overrideAccess: false,
    });
    record('findByID по черновику — null', byIdDirect === null, JSON.stringify(byIdDirect)?.slice(0, 60) ?? 'null');

    const withDraftFlag = await (
      payload.find as unknown as (args: Record<string, unknown>) => Promise<{ totalDocs: number }>
    )({
      collection: 'cards',
      depth: 0,
      draft: true,
      overrideAccess: false,
      where: { slug: { equals: 'smoke-e3-02-otkrytka-draft' } },
    });
    record(
      'параметр draft=true черновик не открывает',
      withDraftFlag.totalDocs === 0,
      `docs=${String(withDraftFlag.totalDocs)}`,
    );

    /* ---------------------------------------------------------------- */
    /* 3. Метаданные изображений анонимно недостижимы (блокер Э3-05…09) */
    /* ---------------------------------------------------------------- */

    let imagesRefusal = '';
    try {
      const images = await payload.find({
        collection: 'card-images',
        depth: 0,
        overrideAccess: false,
      });
      imagesRefusal = `НЕ отказано: docs=${String(images.totalDocs)}`;
    } catch (error) {
      // Имя ошибки значимо: `Forbidden` — это отказ access control, а не сбой.
      // Сравнение по ТЕКСТУ сообщения было бы неверным: в нём нет слова
      // «Forbidden» вовсе (первая версия этой проверки на этом и ошиблась).
      imagesRefusal = `${error instanceof Error ? error.name : 'не Error'}: ${messageOf(error)}`;
    }
    record(
      'card-images анонимно не читается (блокер для srcset, см. отчёт Э3-02)',
      imagesRefusal.startsWith('Forbidden'),
      imagesRefusal,
    );

    /* ---------------------------------------------------------------- */
    /* 4. Ключ производной из записи указывает на существующий файл      */
    /* ---------------------------------------------------------------- */

    const derivativesRoot = (process.env.IMAGE_STORAGE_DERIVATIVES_ROOT ?? '').trim();
    const imageId = created.cardImages[0];
    if (derivativesRoot !== '' && imageId !== undefined) {
      const image = await payload.findByID({ collection: 'card-images', id: imageId, depth: 0 });
      const key = image.variants?.[0]?.key ?? '';
      const root = path.isAbsolute(derivativesRoot)
        ? derivativesRoot
        : path.resolve(process.cwd(), '..', '..', derivativesRoot);
      record(
        'ключ variants[].key указывает на существующий файл под корнем производных',
        key !== '' && existsSync(path.join(root, ...key.split('/'))),
        `key=${key}`,
      );
    }
  } finally {
    await cleanupOnce();
  }

  /**
   * Уборка: ни записей, ни публикаций. Кода выхода НЕ ставит — его считает
   * верхний уровень файла, где виден и результат уборки, и исключение.
   */
  async function runCleanup(): Promise<CleanupOutcome> {
    const payloadForCleanup = await payloadClient();
    for (const id of created.cards) {
      await payloadForCleanup.delete({ collection: 'cards', id }).catch(() => undefined);
      await payloadForCleanup
        .delete({
          collection: 'seo-history',
          where: {
            and: [{ documentCollection: { equals: 'cards' } }, { documentId: { equals: String(id) } }],
          },
        })
        .catch(() => undefined);
    }
    for (const id of [...created.collections].reverse()) {
      await payloadForCleanup.delete({ collection: 'collections', id }).catch(() => undefined);
      await payloadForCleanup
        .delete({
          collection: 'seo-history',
          where: {
            and: [
              { documentCollection: { equals: 'collections' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    for (const id of created.cardImages) {
      await payloadForCleanup.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    for (const stem of claimedStems) {
      await payloadForCleanup
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }

    const cards = await payloadForCleanup.count({ collection: 'cards' });
    const collections = await payloadForCleanup.count({ collection: 'collections' });
    const images = await payloadForCleanup.count({ collection: 'card-images' });
    const claims = await payloadForCleanup.count({ collection: 'image-name-claims' });
    const history = await payloadForCleanup.count({ collection: 'seo-history' });
    const published = await payloadForCleanup.count({
      collection: 'cards',
      where: { status: { equals: 'published' } },
    });
    const publishedNodes = await payloadForCleanup.count({
      collection: 'collections',
      where: { status: { equals: 'published' } },
    });
    console.log(
      `\nПосле уборки: cards=${String(cards.totalDocs)} collections=${String(collections.totalDocs)} ` +
        `card-images=${String(images.totalDocs)} image-name-claims=${String(claims.totalDocs)} ` +
        `seo-history=${String(history.totalDocs)} published=${String(published.totalDocs)}/${String(publishedNodes.totalDocs)}`,
    );

    outcomeValue = { clean: published.totalDocs === 0 && publishedNodes.totalDocs === 0 };
    return outcomeValue;
  }
}

/* ------------------------------------------------------------------ */
/* Верхний уровень: итог и код выхода                                 */
/* ------------------------------------------------------------------ */
//
// КОД ВЫХОДА СЧИТАЕТСЯ ЗДЕСЬ, а не в `finally`: выход из `finally` при исключении
// в полёте гасит саму ошибку, и красный смоук докладывает «не сошлись числа»
// вместо настоящей причины.
//
// `process.exit`, а не `process.exitCode`: смоук запускается через `payload run`,
// а тот в конце делает `process.exit(0)` безусловно и выставленный код затирает.

/**
 * Текст непойманного исключения для итоговой строки.
 *
 * Не шаблонная подстановка значения: у объекта, не являющегося `Error`,
 * стандартное приведение к строке даёт «[object Object]», то есть скрывает
 * причину падения ровно в тот момент, когда она нужнее всего.
 */
function describeCrash(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : inspect(error, { depth: 3 });
}

let crashed: unknown = null;
try {
  await main();
} catch (error) {
  crashed = error;
}

const failed = checks.filter((check) => !check.ok);
console.log(`\nПроверок: ${String(checks.length)}, провалено: ${String(failed.length)}`);
for (const check of failed) {
  console.log(`  - ${check.name}${check.detail === '' ? '' : ` (${check.detail})`}`);
}
if (crashed !== null) {
  console.error(
    `\nСмоук прерван ошибкой:\n${describeCrash(crashed)}`,
  );
}

const outcome = readOutcome();
if (outcome === null) {
  console.error(
    '\nУборка не выполнялась вовсе: в базе могли остаться ОПУБЛИКОВАННЫЕ фикстуры смоука. ' +
      'Проверьте записи с префиксом «smoke-e3-02».',
  );
}

const ok = crashed === null && outcome !== null && outcome.clean && failed.length === 0;
await flushStdout();
process.exit(ok ? 0 : 1);
