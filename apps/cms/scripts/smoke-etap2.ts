/**
 * Смоук задач Э2-04…Э2-06 на ЖИВОЙ базе (одноразовый скрипт проверки).
 *
 * Зачем он нужен, если есть юнит-тесты: загрузка файла, присвоение суффикса
 * `-N` через реестр, поиск визуальных дублей по статусу и уборка файлов
 * работают только на поднятом ядре Payload — там, где есть фазы хуков,
 * транзакции и access control полей. Конфигурация этого не проверяет.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap2.ts
 *
 * Скрипт удаляет за собой все созданные записи и файлы и не оставляет ни одной
 * опубликованной записи. Строки реестра занятых имён по правилу проекта не
 * удаляются никем — здесь они убираются с `overrideAccess: true` (Local API
 * обходит access control), и это единственное место, где так можно: правило
 * защищает внешний путь, REST и GraphQL.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { getPayload } from 'payload';

import config from '../src/payload.config';
import { createPngFixture } from '../src/images/png-fixture';
import {
  derivativeAbsoluteUrl,
  derivativeCacheHeaders,
  derivativePublicPath,
} from '../src/images/storage';
import { resolveImageStorageRoots } from '../src/images/storage-env';

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

async function expectRejected(
  name: string,
  fragment: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = messageOf(error);
    record(name, message.includes(fragment), message.slice(0, 200));
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

interface VariantLike {
  readonly format?: string | null;
  readonly height?: number | null;
  readonly key?: string | null;
  readonly width?: number | null;
}

function variantsOf(doc: { variants?: VariantLike[] | null }): readonly VariantLike[] {
  return doc.variants ?? [];
}

const FIXTURE_TITLE = 'Смоук открытка маме на 8 марта';

async function main(): Promise<void> {
  const payload = await getPayload({ config });
  const roots = resolveImageStorageRoots(process.env);

  console.log(`\nКорни хранилища:\n  производные: ${roots.derivativesRoot}\n  оригиналы:   ${roots.originalsRoot}\n`);

  const created = {
    cardImages: [] as number[],
    cards: [] as number[],
    collections: [] as number[],
    users: [] as number[],
  };
  const claimedStems: string[] = [];

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

    const service = await payload.create({
      collection: 'users',
      data: {
        email: `smoke2-ai-${String(Date.now())}@otkritka.test`,
        password: `smoke-${String(Date.now())}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Э2-04: загрузка, раскладка файлов, недоступность оригинала        */
    /* --------------------------------------------------------------- */

    const bytesA = createPngFixture({ height: 625, width: 1000 });
    const imageA = await payload.create({
      collection: 'card-images',
      data: { title: FIXTURE_TITLE },
      file: { data: bytesA, mimetype: 'image/png', name: 'IMG_0001.png', size: bytesA.byteLength },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(imageA.id);
    if (typeof imageA.nameStem === 'string') {
      claimedStems.push(imageA.nameStem);
    }

    // Ключ и идентификатор оригинала читает только admin (доступ на уровне поля),
    // поэтому ответ, полученный сервисным аккаунтом, их не содержит. Это и есть
    // первая проверка: ai-editor не узнаёт, где лежит оригинал.
    record(
      'ключ оригинала не виден сервисному аккаунту',
      imageA.originalKey === undefined || imageA.originalKey === null,
      `originalKey у ai-editor=${String(imageA.originalKey)}`,
    );
    const imageAasAdmin = await payload.findByID({
      collection: 'card-images',
      id: imageA.id,
      overrideAccess: false,
      user: admin,
    });

    const variantsA = variantsOf(imageA);
    record(
      'ai-editor загружает изображение: полный набор производных',
      variantsA.length === 9,
      `вариантов ${String(variantsA.length)} (3 формата × ширины 320/640/960; 1280 и 1920 больше исходника)`,
    );
    record('pHash заполнен', /^[0-9a-f]{16}$/.test(imageA.pHash ?? ''), String(imageA.pHash));
    record('revision — короткий хеш байтов', /^[0-9a-f]{8}$/.test(imageA.revision ?? ''), String(imageA.revision));
    record(
      'имя файла на транслите, суффикса у первого нет',
      imageA.nameStem === 'smouk-otkrytka-mame-na-8-marta' && imageA.nameSuffix === null,
      `nameStem=${String(imageA.nameStem)} nameSuffix=${String(imageA.nameSuffix)}`,
    );
    record(
      'filename записи приведён к имени в путях производных',
      imageA.filename === `${String(imageA.nameStem)}.png`,
      String(imageA.filename),
    );

    const firstVariant = variantsA.find((variant) => variant.format === 'webp' && variant.width === 640);
    const firstKey = firstVariant?.key ?? '';
    record(
      'ключ производной: ширина в имени = сохранённая width (условие C8)',
      firstKey.endsWith(`-${String(firstVariant?.width)}.webp`),
      firstKey,
    );
    record(
      'все производные лежат в публичном корне',
      (
        await Promise.all(
          variantsA.map((variant) => exists(path.join(roots.derivativesRoot, variant.key ?? ''))),
        )
      ).every(Boolean),
    );

    const originalKey = imageAasAdmin.originalKey ?? '';
    record('ключ оригинала виден админу', originalKey !== '', originalKey);
    record(
      'оригинал лежит в НЕПУБЛИЧНОМ корне',
      await exists(path.join(roots.originalsRoot, originalKey)),
      originalKey,
    );
    record(
      'оригинала нет в корне раздачи: угадываемый URL не проходит (условие C4)',
      !(await exists(path.join(roots.derivativesRoot, originalKey))),
      `${path.join(roots.derivativesRoot, originalKey)} — отсутствует`,
    );
    record(
      'в пути оригинала нет описательного имени',
      originalKey !== '' && !originalKey.includes(String(imageA.nameStem)),
      originalKey,
    );

    console.log(
      `  публичный путь: ${derivativePublicPath(firstKey)}\n` +
        `  абсолютный:     ${derivativeAbsoluteUrl(firstKey)}\n` +
        `  заголовки:      ${JSON.stringify(derivativeCacheHeaders(firstKey))}`,
    );

    /* --------------------------------------------------------------- */
    /* Э2-05: суффикс -N присваивается один раз и хранится              */
    /* --------------------------------------------------------------- */

    const bytesB = createPngFixture({ height: 625, luminanceShift: 18, width: 1000 });
    const imageB = await payload.create({
      collection: 'card-images',
      data: { title: FIXTURE_TITLE },
      file: { data: bytesB, mimetype: 'image/png', name: 'IMG_0002.png', size: bytesB.byteLength },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(imageB.id);
    if (typeof imageB.nameStem === 'string') {
      claimedStems.push(imageB.nameStem);
    }
    record(
      'второе изображение с тем же названием получает суффикс -2',
      imageB.nameStem === `${String(imageA.nameStem)}-2` && imageB.nameSuffix === 2,
      `nameStem=${String(imageB.nameStem)} nameSuffix=${String(imageB.nameSuffix)}`,
    );

    /* --------------------------------------------------------------- */
    /* Э2-05: перевод в review, показ похожих и блокировка              */
    /* --------------------------------------------------------------- */

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smouk-podborka-etap2',
        status: 'draft',
        title: 'Смоук: подборка этапа 2',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(group.id);

    const cardOne = await payload.create({
      collection: 'cards',
      data: {
        alt: 'Смоук: тюльпаны на открытке',
        caption: 'С 8 Марта!',
        collections: [group.id],
        image: imageA.id,
        robots: 'noindex,follow',
        slug: 'smouk-otkrytka-odin',
        status: 'draft',
        title: 'Смоук: открытка один',
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(cardOne.id);

    record(
      'служебные поля пути зеркалятся в карточку',
      cardOne.pHash === imageA.pHash &&
        cardOne.derivative?.nameStem === imageA.nameStem &&
        cardOne.derivative?.revision === imageA.revision &&
        cardOne.derivative?.keyBase === imageA.keyBase,
      `keyBase=${String(cardOne.derivative?.keyBase)}`,
    );

    const cardOneReview = await payload.update({
      collection: 'cards',
      id: cardOne.id,
      data: { status: 'review' },
      overrideAccess: false,
      user: aiEditor,
    });
    record(
      'укомплектованная карточка уходит в review (изображение обязательно)',
      cardOneReview.status === 'review',
      `status=${String(cardOneReview.status)}`,
    );

    const cardTwo = await payload.create({
      collection: 'cards',
      data: {
        alt: 'Смоук: похожая открытка',
        caption: 'С праздником!',
        collections: [group.id],
        image: imageB.id,
        robots: 'noindex,follow',
        slug: 'smouk-otkrytka-dva',
        status: 'draft',
        title: 'Смоук: открытка два',
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(cardTwo.id);

    const similarShown = cardTwo.visualDuplicate?.similar ?? [];
    record(
      'редактору показаны визуально похожие (published + review)',
      similarShown.length > 0,
      similarShown
        .map((item) => `#${String(typeof item.card === 'object' ? item.card?.id : item.card)}:${String(item.distance)}`)
        .join(', '),
    );

    await expectRejected(
      'перевод в review при похожем изображении заблокирован',
      'визуально похоже',
      () =>
        payload.update({
          collection: 'cards',
          id: cardTwo.id,
          data: { status: 'review' },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const decided = await payload.update({
      collection: 'cards',
      id: cardTwo.id,
      data: { status: 'review', visualDuplicate: { confirm: true, decision: 'unique' } },
      overrideAccess: false,
      user: aiEditor,
    });
    record(
      'после явного решения редактора переход проходит, решение записано',
      decided.status === 'review' &&
        decided.visualDuplicate?.decision === 'unique' &&
        typeof decided.visualDuplicate?.decisionFor === 'string' &&
        decided.visualDuplicate.confirm === false,
      `decisionFor=${String(decided.visualDuplicate?.decisionFor)} confirm сброшен=${String(
        decided.visualDuplicate?.confirm === false,
      )}`,
    );

    const tampered = await payload.update({
      collection: 'cards',
      id: cardTwo.id,
      data: { pHash: '0000000000000000' },
      overrideAccess: false,
      user: aiEditor,
    });
    record(
      'служебный pHash снаружи не пишется: значение не применилось',
      tampered.pHash === imageB.pHash,
      `pHash=${String(tampered.pHash)}`,
    );

    /* --------------------------------------------------------------- */
    /* Э2-06: замена изображения                                       */
    /* --------------------------------------------------------------- */

    // Похожесть симметрична: как только вторая карточка ушла в review, первая
    // тоже видит похожую — поэтому и переход review → published требует решения.
    await expectRejected(
      'публикация при непроверенном визуальном дубле заблокирована',
      'визуально похоже',
      () =>
        payload.update({
          collection: 'cards',
          id: cardOne.id,
          data: { status: 'published' },
          overrideAccess: false,
          user: admin,
        }),
    );

    const publishedOne = await payload.update({
      collection: 'cards',
      id: cardOne.id,
      data: { status: 'published', visualDuplicate: { confirm: true, decision: 'unique' } },
      overrideAccess: false,
      user: admin,
    });
    record('карточка опубликована человеком после явного решения', publishedOne.status === 'published');

    const bytesReplacement = createPngFixture({ composition: 'rings', height: 625, width: 1000 });

    await expectRejected(
      'ai-editor не заменяет байты изображения опубликованной карточки',
      'только человек с ролью admin',
      () =>
        payload.update({
          collection: 'card-images',
          id: imageA.id,
          data: {},
          file: {
            data: bytesReplacement,
            mimetype: 'image/png',
            name: 'IMG_0003.png',
            size: bytesReplacement.byteLength,
          },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    await expectRejected(
      'ai-editor не переставляет изображение опубликованной карточки',
      'admin',
      () =>
        payload.update({
          collection: 'cards',
          id: cardOne.id,
          data: { image: imageB.id },
          overrideAccess: false,
          user: aiEditor,
        }),
    );

    const oldKeys = variantsA.map((variant) => variant.key ?? '');
    const replaced = await payload.update({
      collection: 'card-images',
      id: imageA.id,
      data: {},
      file: {
        data: bytesReplacement,
        mimetype: 'image/png',
        name: 'IMG_0003.png',
        size: bytesReplacement.byteLength,
      },
      overrideAccess: false,
      user: admin,
    });

    const newKeys = variantsOf(replaced).map((variant) => variant.key ?? '');
    record(
      'замена: имя файла прежнее, ревизия новая',
      replaced.nameStem === imageA.nameStem && replaced.revision !== imageA.revision,
      `nameStem=${String(replaced.nameStem)} revision ${String(imageA.revision)} → ${String(replaced.revision)}`,
    );
    record(
      'замена: ни один новый ключ не совпадает со старым',
      newKeys.every((key) => !oldKeys.includes(key)),
      `${String(newKeys[0])}`,
    );
    record(
      'замена: старые файлы удалены, новые записаны',
      (await Promise.all(oldKeys.map((key) => exists(path.join(roots.derivativesRoot, key))))).every(
        (found) => !found,
      ) &&
        (await Promise.all(newKeys.map((key) => exists(path.join(roots.derivativesRoot, key))))).every(
          Boolean,
        ),
    );

    const cardAfterReplace = await payload.findByID({ collection: 'cards', id: cardOne.id });
    record(
      'URL карточки не изменился, зеркало ревизии обновилось после сохранения',
      cardAfterReplace.slug === 'smouk-otkrytka-odin',
      `slug=${String(cardAfterReplace.slug)}`,
    );

    const cardTouched = await payload.update({
      collection: 'cards',
      id: cardOne.id,
      data: { title: 'Смоук: открытка один (заголовок изменён)' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'после замены изображения зеркало ревизии обновилось',
      cardTouched.derivative?.revision === replaced.revision,
      `revision=${String(cardTouched.derivative?.revision)}`,
    );
    record(
      'правка заголовка после публикации не меняет имя файла и путь (условие C1)',
      cardTouched.derivative?.nameStem === imageA.nameStem &&
        cardTouched.derivative?.revision === replaced.revision &&
        cardTouched.slug === 'smouk-otkrytka-odin',
      `nameStem=${String(cardTouched.derivative?.nameStem)} revision=${String(cardTouched.derivative?.revision)}`,
    );

    const unpublished = await payload.update({
      collection: 'cards',
      id: cardOne.id,
      data: {
        status: 'draft',
        // Изображение заменено, поэтому набор похожих (и его отпечаток) другой:
        // прежнее решение устарело — подтверждаем заново.
        visualDuplicate: { confirm: true, decision: 'unique' },
        withdrawal: { mode: '404', redirectTo: null },
      },
      overrideAccess: false,
      user: admin,
    });
    record('карточка снята с публикации: смоук не оставляет published', unpublished.status === 'draft');

    /* --------------------------------------------------------------- */
    /* Э2-05: N не переиспользуется после удаления                      */
    /* --------------------------------------------------------------- */

    await payload.update({
      collection: 'cards',
      id: cardTwo.id,
      data: { status: 'draft' },
      overrideAccess: false,
      user: aiEditor,
    });
    await payload.update({
      collection: 'cards',
      id: cardTwo.id,
      data: { image: null },
      overrideAccess: false,
      user: aiEditor,
    });

    const keysB = variantsOf(imageB).map((variant) => variant.key ?? '');
    await expectRejected('изображение удаляет только человек', 'You are not allowed', () =>
      payload.delete({
        collection: 'card-images',
        id: imageB.id,
        overrideAccess: false,
        user: aiEditor,
      }),
    );

    await payload.delete({
      collection: 'card-images',
      id: imageB.id,
      overrideAccess: false,
      user: admin,
    });
    created.cardImages = created.cardImages.filter((id) => id !== imageB.id);
    record(
      'удаление записи убирает её файлы из хранилища',
      (await Promise.all(keysB.map((key) => exists(path.join(roots.derivativesRoot, key))))).every(
        (found) => !found,
      ),
    );

    const bytesC = createPngFixture({ composition: 'rings', height: 625, luminanceShift: 30, width: 1000 });
    const imageC = await payload.create({
      collection: 'card-images',
      data: { title: FIXTURE_TITLE },
      file: { data: bytesC, mimetype: 'image/png', name: 'IMG_0004.png', size: bytesC.byteLength },
      overrideAccess: false,
      user: admin,
    });
    created.cardImages.push(imageC.id);
    if (typeof imageC.nameStem === 'string') {
      claimedStems.push(imageC.nameStem);
    }
    record(
      'после удаления суффикс -2 НЕ переиспользуется: выдан -3',
      imageC.nameStem === `${String(imageA.nameStem)}-3` && imageC.nameSuffix === 3,
      `nameStem=${String(imageC.nameStem)}`,
    );

    await expectRejected(
      'строку реестра занятых имён не удалить снаружи — даже админу',
      'You are not allowed',
      async () => {
        const claim = await payload.find({
          collection: 'image-name-claims',
          limit: 1,
          where: { stem: { equals: imageC.nameStem } },
        });
        const target = claim.docs[0];
        if (target === undefined) {
          throw new Error('строки реестра нет — это отдельная проблема');
        }
        return payload.delete({
          collection: 'image-name-claims',
          id: target.id,
          overrideAccess: false,
          user: admin,
        });
      },
    );

    /* --------------------------------------------------------------- */
    /* Валидация входа                                                 */
    /* --------------------------------------------------------------- */

    const tiny = createPngFixture({ height: 300, width: 500 });
    await expectRejected('исходник уже 640 px отклоняется', '640', () =>
      payload.create({
        collection: 'card-images',
        data: { title: 'Смоук: мелкий исходник' },
        file: { data: tiny, mimetype: 'image/png', name: 'tiny.png', size: tiny.byteLength },
        overrideAccess: false,
        user: admin,
      }),
    );

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>');
    // Отказ приходит от самого Payload (upload.mimeTypes) ещё до хука: это
    // первая линия проверки типа, и её текст — «поле file недопустимо».
    await expectRejected('вектор не принимается', 'file', () =>
      payload.create({
        collection: 'card-images',
        data: { title: 'Смоук: вектор' },
        file: { data: svg, mimetype: 'image/svg+xml', name: 'vector.svg', size: svg.byteLength },
        overrideAccess: false,
        user: admin,
      }),
    );
  } finally {
    /* --------------------------------------------------------------- */
    /* Уборка                                                          */
    /* --------------------------------------------------------------- */
    for (const id of created.cards) {
      await payload.delete({ collection: 'cards', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: { and: [{ documentCollection: { equals: 'cards' } }, { documentId: { equals: String(id) } }] },
        })
        .catch(() => undefined);
    }
    for (const id of created.cardImages) {
      await payload.delete({ collection: 'card-images', id }).catch(() => undefined);
    }
    for (const id of created.collections) {
      await payload.delete({ collection: 'collections', id }).catch(() => undefined);
      await payload
        .delete({
          collection: 'seo-history',
          where: {
            and: [{ documentCollection: { equals: 'collections' } }, { documentId: { equals: String(id) } }],
          },
        })
        .catch(() => undefined);
    }
    // Реестр занятых имён по правилу проекта не удаляется снаружи; здесь уборка
    // идёт через Local API с overrideAccess, чтобы смоук не оставлял следов.
    for (const stem of claimedStems) {
      await payload
        .delete({ collection: 'image-name-claims', where: { stem: { equals: stem } } })
        .catch(() => undefined);
    }
    await payload
      .delete({ collection: 'redirects', where: { from: { like: 'smouk' } } })
      .catch(() => undefined);
    for (const id of created.users) {
      await payload.delete({ collection: 'users', id }).catch(() => undefined);
    }

    const counts = {
      cardImages: (await payload.count({ collection: 'card-images' })).totalDocs,
      cards: (await payload.count({ collection: 'cards' })).totalDocs,
      claims: (await payload.count({ collection: 'image-name-claims' })).totalDocs,
      collections: (await payload.count({ collection: 'collections' })).totalDocs,
      history: (await payload.count({ collection: 'seo-history' })).totalDocs,
      published: (await payload.count({ collection: 'cards', where: { status: { equals: 'published' } } }))
        .totalDocs,
      redirects: (await payload.count({ collection: 'redirects' })).totalDocs,
    };
    console.log(`\nПосле уборки: ${JSON.stringify(counts)}`);

    const failed = checks.filter((check) => !check.ok);
    console.log(`\nИТОГ: ${String(checks.length - failed.length)}/${String(checks.length)} проверок пройдено`);
    for (const check of failed) {
      console.log(`  ПРОВАЛ: ${check.name} — ${check.detail}`);
    }
  }
}

await main();
