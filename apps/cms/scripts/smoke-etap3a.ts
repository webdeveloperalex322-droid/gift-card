/**
 * Смоук задачи Э3-03a на ЖИВОЙ базе: зеркало `variants[]` в записи карточки.
 *
 * Зачем он нужен при зелёных юнит-тестах. Юнит-тесты вызывают те же функции и
 * те же хуки, но не проходят через фазы поднятого ядра: доступ к ПОЛЮ (значение
 * снаружи обязано быть срезано молча, а не «применено и не сохранено»),
 * пересинхронизацию зеркала внутри транзакции замены байтов и — главное —
 * АНОНИМНОЕ чтение с `overrideAccess: false`, ради которого зеркало и завелось.
 * Ни то, ни другое конфигурацией не проверяется.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap3a.ts
 *
 * Скрипт публикует карточку (это действие роли `admin`, а не кода: публикует
 * Local API от имени администратора — тем же способом, что смоук Э2) и обязан
 * снять её с публикации в конце. `index,follow` не выставляется нигде: robots
 * остаётся `noindex,follow` по умолчанию, и это проверяется отдельно — правка
 * зеркала не должна давать ни одного пути к индексации без человека.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import { createPngFixture } from '../src/images/png-fixture';
import { finishSmoke } from '../src/scripts/smoke-exit';

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

interface VariantLike {
  readonly byteSize?: number | null;
  readonly format?: string | null;
  readonly height?: number | null;
  readonly key?: string | null;
  readonly width?: number | null;
}

/** Строка в том виде, в каком её обязан увидеть шаблон: четыре поля и ничего лишнего. */
function shapeOf(variants: readonly VariantLike[] | null | undefined): string {
  return JSON.stringify(
    (variants ?? []).map((variant) => ({
      format: variant.format,
      height: variant.height,
      key: variant.key,
      width: variant.width,
    })),
  );
}

function keysOf(variants: readonly VariantLike[] | null | undefined): readonly string[] {
  return (variants ?? []).map((variant) => variant.key ?? '');
}

const FIXTURE_TITLE = 'Смоук Э3-03a зеркало вариантов';

async function main(): Promise<void> {
  const payload = await getPayload({ config });

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
        email: `smoke3a-ai-${String(Date.now())}@otkritka.test`,
        password: `smoke-${String(Date.now())}`,
        role: 'ai-editor',
      },
    });
    created.users.push(service.id);
    const aiEditor = { ...service, collection: 'users' as const };

    /* --------------------------------------------------------------- */
    /* Загрузка изображения и создание черновика карточки               */
    /* --------------------------------------------------------------- */

    const bytes = createPngFixture({ height: 700, width: 1100 });
    const image = await payload.create({
      collection: 'card-images',
      data: { title: FIXTURE_TITLE },
      file: { data: bytes, mimetype: 'image/png', name: 'IMG_3A01.png', size: bytes.byteLength },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cardImages.push(image.id);
    if (typeof image.nameStem === 'string') {
      claimedStems.push(image.nameStem);
    }

    const group = await payload.create({
      collection: 'collections',
      data: {
        nodeKind: 'group',
        robots: 'noindex,follow',
        slug: 'smouk-e3-03a',
        status: 'draft',
        title: 'Смоук: подборка Э3-03a',
      },
      overrideAccess: false,
      user: admin,
    });
    created.collections.push(group.id);

    const card = await payload.create({
      collection: 'cards',
      data: {
        alt: 'Смоук: зеркало вариантов',
        caption: 'С праздником!',
        collections: [group.id],
        image: image.id,
        // Полнота перед `review` требует description у карточки
        // (`CARD_REVIEW_REQUIREMENTS`, вердикт ревизии Э3-05/Э3-06). Без него
        // смоук обрывался исключением на переходе в `review` — и до правки кода
        // выхода докладывал об этом строкой «8/8 проверок пройдено» и нулём.
        metaDescription:
          'Служебная карточка смоука Э3-03a: проверяется зеркало путей производных в записи.',
        robots: 'noindex,follow',
        slug: 'smouk-zerkalo-variantov',
        status: 'draft',
        title: 'Смоук: зеркало вариантов',
      },
      overrideAccess: false,
      user: aiEditor,
    });
    created.cards.push(card.id);

    record(
      'зеркало заполнено хуком при создании карточки',
      (card.derivative?.variants ?? []).length > 0,
      `вариантов в зеркале ${String((card.derivative?.variants ?? []).length)}, у изображения ` +
        `${String((image.variants ?? []).length)}`,
    );
    record(
      'значения совпадают с card-images.variants[] до единицы (условие C8)',
      shapeOf(card.derivative?.variants) === shapeOf(image.variants),
      shapeOf(card.derivative?.variants).slice(0, 200),
    );
    record(
      'в зеркале нет byteSize: разметка его не использует',
      (card.derivative?.variants ?? []).every(
        (variant) => !Object.hasOwn(variant, 'byteSize'),
      ),
      Object.keys((card.derivative?.variants ?? [])[0] ?? {}).join(', '),
    );

    const sample = (card.derivative?.variants ?? []).find(
      (variant) => variant.format === 'webp' && variant.width === 640,
    );
    record(
      'ширина в ИМЕНИ файла равна сохранённой width: один источник, а не два',
      (sample?.key ?? '').endsWith(`-${String(sample?.width)}.webp`),
      `${String(sample?.key)} → width=${String(sample?.width)} height=${String(sample?.height)}`,
    );

    /* --------------------------------------------------------------- */
    /* Зеркало снаружи не пишется — ни сервисным аккаунтом, ни админом  */
    /* --------------------------------------------------------------- */

    const podmena = [
      { format: 'webp' as const, height: 1, key: 'chuzhoy/kluch/podmena-1.webp', width: 1 },
    ];
    const originalShape = shapeOf(card.derivative?.variants);

    for (const [role, user] of [
      ['ai-editor', aiEditor],
      ['admin', admin],
    ] as const) {
      const tampered = await payload.update({
        collection: 'cards',
        id: card.id,
        data: { derivative: { keyBase: 'chuzhoy/kluch', revision: 'deadbeef', variants: podmena } },
        overrideAccess: false,
        user,
      });
      record(
        `зеркало не принимается снаружи: роль ${role}`,
        shapeOf(tampered.derivative?.variants) === originalShape &&
          tampered.derivative?.keyBase === image.keyBase &&
          tampered.derivative?.revision === image.revision,
        `keyBase=${String(tampered.derivative?.keyBase)} revision=${String(
          tampered.derivative?.revision,
        )}`,
      );
    }

    /* --------------------------------------------------------------- */
    /* Несодержательное сохранение ключи не меняет (условие C1)         */
    /* --------------------------------------------------------------- */

    const renamed = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { title: 'Смоук: зеркало вариантов (заголовок изменён)' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'несодержательное сохранение карточки ключи не меняет (условие C1)',
      shapeOf(renamed.derivative?.variants) === originalShape,
      `ключей ${String(keysOf(renamed.derivative?.variants).length)}, первый ` +
        `${String(keysOf(renamed.derivative?.variants)[0])}`,
    );

    const renamedImage = await payload.update({
      collection: 'card-images',
      id: image.id,
      data: { title: `${FIXTURE_TITLE} (переименовано)` },
      overrideAccess: false,
      user: admin,
    });
    const afterImageRename = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'переименование изображения ключи и зеркало не меняет',
      renamedImage.revision === image.revision &&
        shapeOf(afterImageRename.derivative?.variants) === originalShape,
      `revision=${String(renamedImage.revision)}`,
    );

    /* --------------------------------------------------------------- */
    /* Публикация (действие admin) и АНОНИМНОЕ чтение зеркала           */
    /* --------------------------------------------------------------- */

    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'review' },
      overrideAccess: false,
      user: aiEditor,
    });
    const published = await payload.update({
      collection: 'cards',
      id: card.id,
      data: { status: 'published' },
      overrideAccess: false,
      user: admin,
    });
    record(
      'публикация — действие admin; robots при этом остался noindex,follow',
      published.status === 'published' && published.robots === 'noindex,follow',
      `status=${String(published.status)} robots=${String(published.robots)}`,
    );

    // Ровно так читает публичный рендер: без пользователя и с работающим access
    // control. Дополнительно depth: 0 — как в apps/web/src/data/read-scope.ts.
    const anonymous = await payload.find({
      collection: 'cards',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      where: { slug: { equals: 'smouk-zerkalo-variantov' } },
    });
    const anonymousCard = anonymous.docs[0];
    record(
      'аноним читает зеркало у опубликованной карточки',
      anonymousCard !== undefined &&
        shapeOf(anonymousCard.derivative?.variants) === originalShape,
      `строк у анонима ${String((anonymousCard?.derivative?.variants ?? []).length)}`,
    );

    let imageForbidden = '';
    try {
      await payload.findByID({
        collection: 'card-images',
        id: image.id,
        overrideAccess: false,
      });
    } catch (error) {
      imageForbidden = error instanceof Error ? error.message : String(error);
    }
    record(
      'саму запись изображения аноним по-прежнему НЕ читает: зеркало не расширило поверхность',
      imageForbidden !== '',
      imageForbidden.slice(0, 120),
    );

    /* --------------------------------------------------------------- */
    /* Замена байтов: зеркало обновляется БЕЗ сохранения карточки       */
    /* --------------------------------------------------------------- */

    const replacementBytes = createPngFixture({ composition: 'rings', height: 700, width: 1100 });
    const replaced = await payload.update({
      collection: 'card-images',
      id: image.id,
      data: {},
      file: {
        data: replacementBytes,
        mimetype: 'image/png',
        name: 'IMG_3A02.png',
        size: replacementBytes.byteLength,
      },
      overrideAccess: false,
      user: admin,
    });

    // Карточку НИКТО не сохранял: следующий запрос читает то, что лежит в базе.
    const afterReplace = await payload.findByID({ collection: 'cards', id: card.id });
    const oldKeys = keysOf(image.variants);
    const newKeys = keysOf(afterReplace.derivative?.variants);
    record(
      'замена байтов: зеркало обновилось само, без сохранения карточки (Э2-06)',
      shapeOf(afterReplace.derivative?.variants) === shapeOf(replaced.variants) &&
        newKeys.every((key) => !oldKeys.includes(key)),
      `revision ${String(image.revision)} → ${String(afterReplace.derivative?.revision)}, ` +
        `первый ключ ${String(newKeys[0])}`,
    );
    record(
      'пересинхронизация не тронула ни статус, ни robots, ни URL карточки',
      afterReplace.status === 'published' &&
        afterReplace.robots === 'noindex,follow' &&
        afterReplace.slug === 'smouk-zerkalo-variantov',
      `status=${String(afterReplace.status)} robots=${String(afterReplace.robots)} slug=${String(
        afterReplace.slug,
      )}`,
    );

    const anonymousAfter = await payload.find({
      collection: 'cards',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      where: { slug: { equals: 'smouk-zerkalo-variantov' } },
    });
    record(
      'аноним сразу получает НОВЫЕ ключи: старых файлов уже нет в хранилище',
      shapeOf(anonymousAfter.docs[0]?.derivative?.variants) === shapeOf(replaced.variants),
      `строк ${String((anonymousAfter.docs[0]?.derivative?.variants ?? []).length)}`,
    );

    /* --------------------------------------------------------------- */
    /* Удаление изображения: отказ, пока на него ссылается карточка     */
    /* --------------------------------------------------------------- */

    // Путь удаления — вторая половина той же дыры, что и замена байтов.
    // Связь `cards.image` живёт в `cards_rels` с `onDelete: 'cascade'`, поэтому
    // без отказа в `beforeDelete` поле карточки обнулилось бы МОЛЧА (минуя все
    // хуки карточки), а зеркало путей осталось бы с ключами удалённых файлов:
    // опубликованная страница отдавала бы 200 с `<img src>` в никуда.
    let deleteRefusal = '';
    let deleteRule: unknown = null;
    try {
      await payload.delete({
        collection: 'card-images',
        id: image.id,
        overrideAccess: false,
        user: admin,
      });
    } catch (error) {
      deleteRefusal = error instanceof Error ? error.message : String(error);
      deleteRule = (error as { data?: { rule?: unknown } }).data?.rule ?? null;
    }
    record(
      'удаление изображения ОТКЛОНЕНО: на него ссылается опубликованная карточка',
      deleteRefusal !== '' && deleteRule === 'image-in-use',
      `rule=${String(deleteRule)}; ${deleteRefusal.slice(0, 160)}`,
    );

    const survived = await payload.findByID({ collection: 'card-images', id: image.id });
    const cardAfterRefusal = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'после отказа и запись изображения, и зеркало карточки целы',
      survived.id === image.id &&
        keysOf(cardAfterRefusal.derivative?.variants).length > 0 &&
        cardAfterRefusal.image !== null,
      `вариантов в зеркале ${String((cardAfterRefusal.derivative?.variants ?? []).length)}, ` +
        `image=${String(
          typeof cardAfterRefusal.image === 'object' && cardAfterRefusal.image !== null
            ? cardAfterRefusal.image.id
            : cardAfterRefusal.image,
        )}`,
    );

    /* --------------------------------------------------------------- */
    /* Снятие с публикации: анониму карточки больше нет вовсе           */
    /* --------------------------------------------------------------- */

    await payload.update({
      collection: 'cards',
      id: card.id,
      data: {
        status: 'draft',
        visualDuplicate: { confirm: true, decision: 'unique' },
        withdrawal: { mode: '404', redirectTo: null },
      },
      overrideAccess: false,
      user: admin,
    });

    const anonymousDraft = await payload.find({
      collection: 'cards',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      where: { slug: { equals: 'smouk-zerkalo-variantov' } },
    });
    record(
      'у карточки вне published аноним не получает ни зеркала, ни самой записи',
      anonymousDraft.docs.length === 0,
      `документов у анонима ${String(anonymousDraft.docs.length)}`,
    );

    /* --------------------------------------------------------------- */
    /* Удаление изображения: круг — ВСЕ карточки, не только published    */
    /* --------------------------------------------------------------- */

    let draftRefusalRule: unknown = null;
    try {
      await payload.delete({
        collection: 'card-images',
        id: image.id,
        overrideAccess: false,
        user: admin,
      });
    } catch (error) {
      draftRefusalRule = (error as { data?: { rule?: unknown } }).data?.rule ?? null;
    }
    record(
      'отказ стоит и для черновика: у него зеркало осталось бы таким же мёртвым',
      draftRefusalRule === 'image-in-use',
      `rule=${String(draftRefusalRule)}`,
    );

    // Отвязка — то самое действие, которое отказ и требует от редактора. Делается
    // она уже НЕ на опубликованной странице: карточка снята с публикации выше,
    // поэтому опубликованный URL ни на миг не остаётся без изображения.
    await payload.update({
      collection: 'cards',
      id: card.id,
      data: { image: null },
      overrideAccess: false,
      user: admin,
    });
    const unlinked = await payload.findByID({ collection: 'cards', id: card.id });
    record(
      'после отвязки зеркало карточки опустело: мёртвых ключей не осталось',
      (unlinked.derivative?.variants ?? []).length === 0 && unlinked.derivative?.revision === null,
      `вариантов ${String((unlinked.derivative?.variants ?? []).length)}, revision=${String(
        unlinked.derivative?.revision,
      )}`,
    );

    let deletedAfterUnlink = false;
    try {
      await payload.delete({
        collection: 'card-images',
        id: image.id,
        overrideAccess: false,
        user: admin,
      });
      deletedAfterUnlink = true;
      created.cardImages = created.cardImages.filter((id) => id !== image.id);
    } catch (error) {
      console.log(
        `  отказ после отвязки: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    record(
      'после отвязки удаление проходит — отказ не превратился в тупик',
      deletedAfterUnlink,
      `запись #${String(image.id)} удалена`,
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
          where: {
            and: [
              { documentCollection: { equals: 'cards' } },
              { documentId: { equals: String(id) } },
            ],
          },
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
            and: [
              { documentCollection: { equals: 'collections' } },
              { documentId: { equals: String(id) } },
            ],
          },
        })
        .catch(() => undefined);
    }
    // Реестр занятых имён снаружи не удаляется никем; здесь уборка идёт через
    // Local API с overrideAccess, чтобы смоук не оставлял следов.
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
      published: (
        await payload.count({ collection: 'cards', where: { status: { equals: 'published' } } })
      ).totalDocs,
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

// Код выхода выставляет `finishSmoke`, а не `process.exitCode`: `payload run`
// после скрипта безусловно делает `process.exit(0)` (`payload/dist/bin/index.js`)
// и выставленное поле затирает — красный смоук выходил бы нулём. Решение о коде
// вынесено ЗА `main` намеренно: вызов изнутри `finally` при исключении,
// оборвавшем смоук, вышел бы нулём и съел саму ошибку.
try {
  await main();
} catch (error) {
  console.error('\nСмоук оборван ошибкой:', error);
  await finishSmoke(1);
}

await finishSmoke(checks.filter((check) => !check.ok).length);
