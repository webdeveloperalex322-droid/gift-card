/**
 * Прогон живых API-тестов НЕ пишет в контентную базу (решение человека
 * 2026-09-03).
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ЕСТЬ. Требование сформулировано о СОСТОЯНИИ: «фикстуры не
 * публикуют записи в контентную базу и не попадают в sitemap». Механизм,
 * который это обеспечивает, — отдельная база `<контентная>_api_tests`
 * (`apps/cms/src/testing/api-test-database.mjs`). Механизм без проверки
 * состояния — обещание: подмена базы держится на внутреннем устройстве адаптера
 * Postgres, и её поломка выглядела бы как совершенно зелёный прогон, просто
 * выполненный на контентной базе. До 2026-09-03 так и было: набор публиковал
 * записи в рабочую базу, они попадали в живой каталог, и ни один тест не
 * краснел.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, В ПОРЯДКЕ СИЛЫ УТВЕРЖДЕНИЯ:
 *   1. набор подключён не к контентной базе — утверждение о КАЖДОМ файле
 *      набора, потому что базу подменяет один общий харнесс. Не зависит от
 *      порядка файлов;
 *   2. опубликованное состояние во время теста существует по-настоящему — иначе
 *      «в контентной базе чисто» достигалось бы отказом от публикации, то есть
 *      снятием проверок Э6-02, а не защитой базы;
 *   3. в контентной базе нет записей харнесса — ни `published`, ни любых
 *      других;
 *   4. маркер, по которому пункт 3 ищет записи, действительно опознаёт записи
 *      харнесса и не задевает реальный контент. Без этого пункт 3 был бы зелёным
 *      при сломанном условии поиска.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ЛОВИТ, СКАЗАНО ПРЯМО. Пункт 3 читает контентную базу в тот
 * момент, когда выполняется этот файл; порядок файлов внутри проекта `api`
 * задаёт Vitest, и файл, который отработает ПОСЛЕ, теоретически мог бы
 * напачкать. Именно поэтому главным здесь считается пункт 1: он про
 * подключение, общее для всех файлов, а не про момент замера.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PublishedFixture,
  createPublishedFixture,
  removePublishedFixture,
} from '../../apps/cms/src/testing/api-fixtures';
import {
  type TestUser,
  assertNothingPublishedLeft,
  connectedDatabaseName,
  createUserWithKey,
  getTestPayload,
  readStored,
  removeUsers,
  stamp,
} from '../../apps/cms/src/testing/api-harness';
import {
  apiTestDatabaseUrl,
  contentDatabaseUrl,
  databaseNameOf,
} from '../../apps/cms/src/testing/api-test-database.mjs';
import {
  HARNESS_IMAGE_PATTERN,
  HARNESS_SLUG_PATTERN,
  describeResidue,
  findContentDatabaseResidue,
} from '../../apps/cms/src/testing/content-residue';

const RUN = stamp();

let admin: TestUser;
let aiEditor: TestUser;
let fixture: PublishedFixture;

beforeAll(async () => {
  await getTestPayload();
  admin = await createUserWithKey({
    email: `e602-baza-admin-${RUN}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  aiEditor = await createUserWithKey({
    email: `e602-baza-ai-${RUN}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  fixture = await createPublishedFixture({
    adminId: admin.id,
    editorId: aiEditor.id,
    run: RUN,
  });
}, 240_000);

afterAll(async () => {
  await removePublishedFixture(fixture);
  await removeUsers([admin.id, aiEditor.id]);
});

describe('Прогон tests/api не оставляет записей в контентной базе', () => {
  it('набор подключён к отдельной базе, а не к контентной', async () => {
    const content = databaseNameOf(contentDatabaseUrl());
    const test = databaseNameOf(apiTestDatabaseUrl());

    expect(test, 'имя тестовой базы совпало с контентной').not.toBe(content);
    expect(
      await connectedDatabaseName(),
      'Payload прогона подключён не к тестовой базе: фикстура публикует записи ' +
        'по-настоящему, и в контентной базе они попадут в каталог и в sitemap',
    ).toBe(test);
  });

  it('опубликованное состояние во время прогона существует по-настоящему', async () => {
    const card = await readStored('cards', fixture.cardId);
    const node = await readStored('collections', fixture.nodeId);

    // Половина сценариев Э6-02 проверяет поведение ИМЕННО опубликованной
    // записи. Если однажды фикстуру «починят», перестав публиковать, этот
    // ожидание покраснеет раньше, чем те сценарии станут зелёными по чужой
    // причине.
    expect(card.status, 'фикстура перестала публиковать карточку').toBe('published');
    expect(node.status, 'фикстура перестала публиковать подборку').toBe('published');
  });

  it('проверка «после уборки публикаций не осталось» действительно видит публикацию', async () => {
    // Пока фикстура жива, `assertNothingPublishedLeft` ОБЯЗАНА отказать: иначе
    // её зелёный вызов в уборке фикстуры не значил бы ничего — условие поиска
    // могло не совпадать ни с чем, и «публикаций не осталось» было бы верно
    // всегда.
    await expect(assertNothingPublishedLeft()).rejects.toThrow(
      /остались ОПУБЛИКОВАННЫЕ записи/,
    );
  });

  it('в контентной базе нет записей харнесса — ни published, ни черновиков', async () => {
    const residue = await findContentDatabaseResidue();

    expect(
      residue,
      'В контентной базе лежат записи прогонов API-тестов: ' +
        `${describeResidue(residue)}. Опубликованные из них видны в живом каталоге и ` +
        'попадут в sitemap. Разовая уборка: pnpm --filter @otkritka/cms exec payload run ' +
        './scripts/cleanup-api-test-residue.ts -- --apply',
    ).toEqual([]);
  });

  it('маркер записей харнесса опознаёт их и не задевает реальный контент', () => {
    const slug = new RegExp(HARNESS_SLUG_PATTERN);
    const image = new RegExp(HARNESS_IMAGE_PATTERN);

    // Проверка не про регулярное выражение как таковое: она про то, что
    // предыдущее ожидание не зелёное по недосмотру. Условие поиска, которое ни
    // с чем не совпадает, даёт «в базе чисто» при полной базе мусора.
    expect(slug.test(`e602-otkrytka-${RUN}`)).toBe(true);
    expect(slug.test(`e602n-pereezd-${RUN}`)).toBe(true);
    expect(slug.test(`p0-draft-${RUN}`)).toBe(true);
    expect(image.test(`e6-02-izobrazhenie-${RUN}`)).toBe(true);

    // Реальные slug каталога: транслитерация русских названий и даты праздников.
    for (const real of [
      '8-marta',
      'den-rozhdeniya',
      'otkrytka-mame-na-8-marta-s-tyulpanami',
      'prazdniki',
      'e-mail-rassylka',
    ]) {
      expect(slug.test(real), `маркер задел реальный slug ${real}`).toBe(false);
    }
  });
});
