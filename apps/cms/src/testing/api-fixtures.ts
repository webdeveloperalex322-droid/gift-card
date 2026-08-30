/**
 * Состояние, на котором проверяются права (задачи Э6-01, Э6-02).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Половина негативных сценариев Э6-02 говорит про
 * ОПУБЛИКОВАННУЮ запись: неизменяемый slug, canonical, robots, удаление, замена
 * изображения. Без такой записи каждый из них «проходил» бы по совершенно другой
 * причине — потому что записи нет, — и набор был бы зелёным, ничего не проверяя.
 * Поэтому фикстура доводит карточку и подборку до `published` целиком, через все
 * штатные правила, и падает громко, если хоть один шаг не прошёл.
 *
 * ПОЧЕМУ ФИКСТУРА ХОДИТ ЧЕРЕЗ LOCAL API. Она моделирует СОСТОЯНИЕ, а не право:
 * «в системе есть опубликованная карточка». Все вызовы идут с
 * `overrideAccess: false` и явным пользователем — то есть через тот же access
 * control, что REST и GraphQL, — но без HTTP: проверяется здесь не путь запроса,
 * а то, что состояние достижимо законным образом. Само право проверяют тесты,
 * и они ходят по REST и GraphQL.
 */
import type { Payload, PayloadRequest } from 'payload';

import { createPngFixture } from '../images/png-fixture';
import type { Collection } from '../payload-types';
import { assertRemoved, getTestPayload, removeContent } from './api-harness';

/**
 * Вводный текст подборки в том виде, в каком его хранит richText.
 *
 * Тип возврата взят из СГЕНЕРИРОВАННЫХ типов Payload, а не описан вручную:
 * форма узла lexical принадлежит редактору, и вторая её копия разошлась бы с
 * первой молча.
 */
export function lexical(text: string): NonNullable<Collection['intro']> {
  return {
    root: {
      children: [
        { children: [{ text, type: 'text', version: 1 }], type: 'paragraph', version: 1 },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  };
}

export interface PublishedFixture {
  /**
   * Администратор, от чьего имени фикстура публиковала записи.
   *
   * Хранится в фикстуре, потому что нужен УБОРКЕ: снятие с публикации — решение
   * о судьбе URL, и правило «только admin» живёт в хуке `beforeOperation`, то
   * есть выполняется и при `overrideAccess: true`. Уборка без пользователя
   * отклонялась этим правилом; пока её ошибки глушились, это было незаметно, а
   * опубликованные записи прогона оставались в базе.
   */
  readonly adminId: number;
  /** Карточка в статусе `published`. */
  readonly cardId: number;
  /** Изображение карточки. */
  readonly imageId: number;
  /** Второе изображение: им проверяется запрет замены файла у опубликованной карточки. */
  readonly otherImageId: number;
  /** Третье изображение — у карточки в `review`. */
  readonly reviewImageId: number;
  /** Подборка-повод в статусе `published` (в ней лежит карточка). */
  readonly nodeId: number;
  /** Группирующий узел — родитель подборки. */
  readonly groupId: number;
  /** Второй группирующий узел: им проверяется запрет смены parent после публикации. */
  readonly otherGroupId: number;
  /**
   * Карточка в статусе `review` — та, у которой публикация ЗАКОННА по модели
   * переходов и упирается ровно в роль.
   *
   * Без неё «сервисный аккаунт не публикует» доказывалось бы черновиком, а его
   * останавливает другое правило — `forbidden-transition`: `draft → published`
   * не предусмотрен моделью ни для кого, включая администратора. Зелёный тест
   * держался бы на запрете перескока, а не на границе автоматизации, и снятие
   * проверки роли он бы не заметил.
   */
  readonly reviewCardId: number;
  /** Подборка в статусе `review` — по той же причине. */
  readonly reviewNodeId: number;
}

type Actor = PayloadRequest['user'];

async function asDoc(payload: Payload, id: number | string): Promise<Actor> {
  const doc = await payload.findByID({ collection: 'users', id, overrideAccess: true });
  return { ...doc, collection: 'users' } as unknown as Actor;
}

/** Пользователь Local API по идентификатору. */
export async function actorFor(id: number | string): Promise<Actor> {
  return asDoc(await getTestPayload(), id);
}

async function uploadImage(args: {
  readonly actor: Actor;
  readonly composition: 'grid' | 'rings' | 'stripes';
  readonly payload: Payload;
  readonly title: string;
  readonly name: string;
}): Promise<number> {
  const bytes = createPngFixture({ composition: args.composition, height: 700, width: 1100 });
  const created = await args.payload.create({
    collection: 'card-images',
    data: { title: args.title },
    file: {
      data: bytes,
      mimetype: 'image/png',
      name: `${args.name}.png`,
      size: bytes.byteLength,
    },
    overrideAccess: false,
    user: args.actor,
  });
  return created.id;
}

/**
 * Доводит карточку и подборку до `published`.
 *
 * Порядок не переставляется: узел без опубликованного содержания опубликовать
 * нельзя (`empty-for-publish`), поэтому сначала карточка, потом подборка.
 */
export async function createPublishedFixture(args: {
  readonly adminId: number;
  readonly editorId: number;
  readonly run: string;
}): Promise<PublishedFixture> {
  const payload = await getTestPayload();
  const admin = await asDoc(payload, args.adminId);
  const editor = await asDoc(payload, args.editorId);
  const { run } = args;

  const group = await payload.create({
    collection: 'collections',
    data: {
      nodeKind: 'group',
      robots: 'noindex,follow',
      slug: `e602-gruppa-${run}`,
      status: 'draft',
      title: `Э6-02: группа ${run}`,
    },
    overrideAccess: false,
    user: admin,
  });

  const otherGroup = await payload.create({
    collection: 'collections',
    data: {
      nodeKind: 'group',
      robots: 'noindex,follow',
      slug: `e602-gruppa-vtoraya-${run}`,
      status: 'draft',
      title: `Э6-02: вторая группа ${run}`,
    },
    overrideAccess: false,
    user: admin,
  });

  const node = await payload.create({
    collection: 'collections',
    data: {
      intro: lexical(`Вводный текст подборки Э6-02 ${run}: своим текстом и без шаблона.`),
      metaDescription: `Э6-02: описание подборки ${run}`,
      nodeKind: 'occasion',
      parent: group.id,
      related: [group.id],
      responsibleEditor: args.adminId,
      robots: 'noindex,follow',
      slug: `e602-povod-${run}`,
      status: 'draft',
      title: `Э6-02: подборка ${run}`,
    },
    overrideAccess: false,
    user: admin,
  });

  const imageId = await uploadImage({
    actor: editor,
    composition: 'rings',
    name: `e602-osnovnoe-${run}`,
    payload,
    title: `Э6-02: изображение ${run}`,
  });
  const otherImageId = await uploadImage({
    actor: editor,
    composition: 'grid',
    name: `e602-zamena-${run}`,
    payload,
    title: `Э6-02: изображение замены ${run}`,
  });

  const card = await payload.create({
    collection: 'cards',
    data: {
      alt: `Открытка Э6-02 ${run}: кольца на светлом фоне`,
      caption: `Подпись открытки Э6-02 ${run}`,
      collections: [node.id],
      image: imageId,
      metaDescription: `Э6-02: описание открытки ${run}`,
      robots: 'noindex,follow',
      slug: `e602-otkrytka-${run}`,
      status: 'draft',
      title: `Э6-02: открытка ${run}`,
    },
    overrideAccess: false,
    user: editor,
  });

  // Решение о визуальных дублях принимается ДО перевода в review: порог
  // похожести только подсказывает, а решение принимает редактор — и сервисному
  // аккаунту это доступно (ТЗ §9).
  await payload.update({
    collection: 'cards',
    id: card.id,
    data: { visualDuplicate: { confirm: true, decision: 'unique' } },
    overrideAccess: false,
    user: editor,
  });
  await payload.update({
    collection: 'cards',
    id: card.id,
    data: { status: 'review' },
    overrideAccess: false,
    user: editor,
  });
  const publishedCard = await payload.update({
    collection: 'cards',
    id: card.id,
    data: { status: 'published' },
    overrideAccess: false,
    user: admin,
  });
  if (publishedCard.status !== 'published') {
    throw new Error('Фикстура Э6-02: карточка не опубликовалась, дальнейшие проверки бессмысленны.');
  }

  await payload.update({
    collection: 'collections',
    id: node.id,
    data: { status: 'review' },
    overrideAccess: false,
    user: editor,
  });
  const publishedNode = await payload.update({
    collection: 'collections',
    id: node.id,
    data: { status: 'published' },
    overrideAccess: false,
    user: admin,
  });
  if (publishedNode.status !== 'published') {
    throw new Error('Фикстура Э6-02: подборка не опубликовалась.');
  }

  /* --------------------------------------------------------------- */
  /* Записи в `review`: на них проверяется именно граница автоматизации */
  /* --------------------------------------------------------------- */

  const reviewImageId = await uploadImage({
    actor: editor,
    composition: 'stripes',
    name: `e602-review-${run}`,
    payload,
    title: `Э6-02: изображение записи на проверке ${run}`,
  });

  const reviewCard = await payload.create({
    collection: 'cards',
    data: {
      alt: `Открытка на проверке Э6-02 ${run}: диагональные полосы`,
      caption: `Подпись открытки на проверке Э6-02 ${run}`,
      collections: [node.id],
      image: reviewImageId,
      metaDescription: `Э6-02: описание открытки на проверке ${run}`,
      robots: 'noindex,follow',
      slug: `e602-otkrytka-na-proverke-${run}`,
      status: 'draft',
      title: `Э6-02: открытка на проверке ${run}`,
    },
    overrideAccess: false,
    user: editor,
  });
  await payload.update({
    collection: 'cards',
    id: reviewCard.id,
    data: { visualDuplicate: { confirm: true, decision: 'unique' } },
    overrideAccess: false,
    user: editor,
  });
  const reviewedCard = await payload.update({
    collection: 'cards',
    id: reviewCard.id,
    data: { status: 'review' },
    overrideAccess: false,
    user: editor,
  });
  if (reviewedCard.status !== 'review') {
    throw new Error('Фикстура Э6-02: карточка не дошла до review.');
  }

  const reviewNode = await payload.create({
    collection: 'collections',
    data: {
      intro: lexical(`Вводный текст подборки на проверке Э6-02 ${run}: свой, не шаблонный.`),
      metaDescription: `Э6-02: описание подборки на проверке ${run}`,
      nodeKind: 'group',
      related: [group.id],
      responsibleEditor: args.adminId,
      robots: 'noindex,follow',
      slug: `e602-gruppa-na-proverke-${run}`,
      status: 'draft',
      title: `Э6-02: подборка на проверке ${run}`,
    },
    overrideAccess: false,
    user: admin,
  });
  const reviewedNode = await payload.update({
    collection: 'collections',
    id: reviewNode.id,
    data: { status: 'review' },
    overrideAccess: false,
    user: editor,
  });
  if (reviewedNode.status !== 'review') {
    throw new Error('Фикстура Э6-02: подборка не дошла до review.');
  }

  return {
    adminId: args.adminId,
    cardId: card.id,
    groupId: group.id,
    imageId,
    nodeId: node.id,
    otherGroupId: otherGroup.id,
    otherImageId,
    reviewCardId: reviewCard.id,
    reviewImageId,
    reviewNodeId: reviewNode.id,
  };
}

/**
 * Убирает за собой всё созданное фикстурой.
 *
 * Опубликованные записи сначала снимаются с публикации С РЕШЕНИЕМ о судьбе URL
 * (иначе снятие отклонит статусная модель), причём решением `404` — временный
 * тестовый путь никуда не переезжал, и 301 на что-нибудь был бы враньём в карте
 * переносов. Записи `seo-history` и созданные редиректы удаляются отдельно:
 * иначе после прогона в базе оставался бы журнал по несуществующим записям.
 *
 * УБОРКА ПАДАЕТ ГРОМКО. Раньше каждый её шаг был обёрнут в `.catch(() =>
 * undefined)`, и сорванный прогон молча оставлял в рабочей базе ОПУБЛИКОВАННУЮ
 * запись — то есть страницу, которая попадёт в sitemap и в индекс. Проверка
 * состояния «после» ({@link assertRemoved}) добавлена рядом с удалением по той
 * же причине: удаление может «пройти», а запись остаться.
 */
export async function removePublishedFixture(fixture: PublishedFixture): Promise<void> {
  const payload = await getTestPayload();
  // Снятие с публикации выполняется ОТ ИМЕНИ АДМИНИСТРАТОРА, а не правами
  // системы: правило «снять может только admin» живёт в хуке `beforeOperation`,
  // а хуки выполняются и при `overrideAccess: true`. Это не обход проверки —
  // фикстура моделирует ровно то действие, которым запись снимает человек.
  const admin = await asDoc(payload, fixture.adminId);

  // Снятие выполняется ТОЛЬКО для реально опубликованной записи: повторное
  // `draft → draft` статусная модель отклонит, и уборка упала бы там, где
  // убирать уже нечего. Чтение состояния здесь — не перестраховка, а условие
  // корректности шага.
  const withdraw = async (collection: 'cards' | 'collections', id: number): Promise<void> => {
    const stored = await payload
      .findByID({ collection, depth: 0, disableErrors: true, id, overrideAccess: true })
      .catch(() => null);
    if (stored === null || stored.status !== 'published') {
      return;
    }
    await payload.update({
      collection,
      id,
      data: { status: 'draft', withdrawal: { mode: '404', redirectTo: null } },
      overrideAccess: false,
      user: admin,
    });
  };

  await withdraw('collections', fixture.nodeId);
  await withdraw('cards', fixture.cardId);

  await removeContent('cards', [fixture.cardId, fixture.reviewCardId]);
  // Порядок создания: группа → узел, поэтому уборка идёт в обратном (см.
  // `removeContent`): подборка с потомками не удаляется вовсе.
  await removeContent('collections', [
    fixture.groupId,
    fixture.otherGroupId,
    fixture.reviewNodeId,
    fixture.nodeId,
  ]);
  await removeContent('card-images', [
    fixture.imageId,
    fixture.otherImageId,
    fixture.reviewImageId,
  ]);

  await assertRemoved('cards', [fixture.cardId, fixture.reviewCardId]);
  await assertRemoved('collections', [
    fixture.groupId,
    fixture.otherGroupId,
    fixture.reviewNodeId,
    fixture.nodeId,
  ]);
  await assertRemoved('card-images', [
    fixture.imageId,
    fixture.otherImageId,
    fixture.reviewImageId,
  ]);
}
