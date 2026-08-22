/**
 * Смоук задачи Э3-00 на ЖИВОЙ базе (одноразовый скрипт проверки).
 *
 * Зачем он нужен, если есть юнит-тесты: юнит-тесты вызывают те же функции
 * `access`, которые вызывает Payload, но не проверяют, что запрос действительно
 * ПАДАЕТ. Отказ на уровне глобала обязан быть громким (Forbidden), а поля
 * аудита — заполняться сервером и не приниматься извне; и то, и другое живёт в
 * фазах хуков поднятого ядра, а не в конфигурации.
 *
 * Запуск: pnpm --filter @otkritka/cms exec payload run ./scripts/smoke-etap3.ts
 *
 * Скрипт возвращает глобал в исходное ПУСТОЕ состояние и проверяет это отдельно.
 * Это не вежливость: заполненный текст служебной страницы по решению Ч-23 сам
 * открывает её в index,follow и вносит в sitemap — то есть смоук, забывший
 * убраться, опубликовал бы страницу-заглушку.
 */
import { getPayload } from 'payload';

import config from '../src/payload.config';
import {
  aiDisclosureText,
  imageLicenseJsonLd,
  isInfoPageIndexable,
  organizationJsonLd,
  renderableAdSlots,
} from '../src/globals/site-settings-rules';
import {
  adSlotFacts,
  imageLicenseFacts,
  infoPageFacts,
  organizationFacts,
} from '../src/globals/site-settings';

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

async function expectRejected(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    record(name, true, messageOf(error).slice(0, 160));
    return;
  }
  record(name, false, 'операция прошла, хотя должна была быть отклонена');
}

/** Лексический документ с одним абзацем — форма, которую пишет richText. */
function lexical(text: string): {
  root: {
    type: string;
    children: { type: string; version: number; [k: string]: unknown }[];
    direction: 'ltr' | 'rtl' | null;
    format: '';
    indent: number;
    version: number;
  };
} {
  return {
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
          ],
          direction: 'ltr',
          format: '',
          indent: 0,
          textFormat: 0,
          version: 1,
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  };
}

const longText = 'Проект собирает поздравительные открытки и отдаёт их бесплатно. '.repeat(12);

async function main(): Promise<void> {
  const payload = await getPayload({ config });
  type UserArg = Parameters<typeof payload.updateGlobal>[0]['user'];

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
      email: `smoke3-ai-${String(Date.now())}@otkritka.test`,
      password: `smoke-${String(Date.now())}`,
      role: 'ai-editor',
    },
  });
  const aiEditor = { ...service, collection: 'users' as const };

  try {
    /* --------------------------------------------------------------- */
    /* 1. Чистое состояние: читается публично, все поля пустые          */
    /* --------------------------------------------------------------- */

    const anonymous = await payload.findGlobal({
      slug: 'site-settings',
      overrideAccess: false,
    });
    // Проверяется сам факт чтения без аутентификации: у ни разу не сохранённого
    // глобала Payload не отдаёт ни id, ни полей — это нормальное состояние
    // чистой базы, и шаблон обязан пережить его молчанием, а не ошибкой.
    record('глобал читается без аутентификации (шаблоны Astro)', typeof anonymous === 'object');
    record(
      'на чистой базе блок Organization не выводится',
      organizationJsonLd(organizationFacts(anonymous)) === null,
    );
    record(
      'на чистой базе лицензионный блок не выводится',
      imageLicenseJsonLd(imageLicenseFacts(anonymous)) === null,
    );
    record(
      'на чистой базе служебные страницы остаются noindex (Ч-23)',
      !isInfoPageIndexable(infoPageFacts(anonymous, 'terms')),
    );
    record(
      'на чистой базе рекламных мест нет',
      renderableAdSlots(adSlotFacts(anonymous), 'under-h1').length === 0,
    );

    /* --------------------------------------------------------------- */
    /* 2. Негатив: сервисный аккаунт и аноним настройки не пишут        */
    /* --------------------------------------------------------------- */

    await expectRejected('ai-editor не пишет в настройки (Forbidden)', () =>
      payload.updateGlobal({
        slug: 'site-settings',
        data: { organization: { name: 'Взлом' } },
        overrideAccess: false,
        user: aiEditor as UserArg,
      }),
    );

    await expectRejected('ai-editor не открывает служебную страницу в индекс', () =>
      payload.updateGlobal({
        slug: 'site-settings',
        data: { infoPages: { terms: { title: 'Условия', body: lexical(longText) } } },
        overrideAccess: false,
        user: aiEditor as UserArg,
      }),
    );

    await expectRejected('аноним не пишет в настройки', () =>
      payload.updateGlobal({
        slug: 'site-settings',
        data: { organization: { name: 'Взлом' } },
        overrideAccess: false,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 3. Валидация полей отклоняет абсолютный адрес и лишний блок      */
    /* --------------------------------------------------------------- */

    await expectRejected('абсолютный адрес в лицензионной ссылке отклонён', () =>
      payload.updateGlobal({
        slug: 'site-settings',
        data: { imageLicense: { license: 'https://otkritka.test/usloviya' } },
        overrideAccess: false,
        user: admin as UserArg,
      }),
    );

    await expectRejected('четвёртый блок в ряду рекламы отклонён (Ч-11)', () =>
      payload.updateGlobal({
        slug: 'site-settings',
        data: {
          adSlots: [1, 2, 3, 4].map(() => ({
            position: 'under-h1' as const,
            width: 300,
            height: 250,
            enabled: true,
          })),
        },
        overrideAccess: false,
        user: admin as UserArg,
      }),
    );

    /* --------------------------------------------------------------- */
    /* 4. admin пишет; аудит ставит сервер и не принимает извне         */
    /* --------------------------------------------------------------- */

    const filled = await payload.updateGlobal({
      slug: 'site-settings',
      data: {
        // Попытка подменить аудит: значения обязаны быть срезаны, а не приняты.
        audit: { authorRole: 'ai-editor', changedBy: service.id, viaApiKey: true },
        organization: { name: 'Смоук', logo: '/media/site/logo.svg' },
        imageLicense: {
          creator: 'Смоук',
          creditText: 'смоук',
          copyrightNotice: '© смоук',
          license: '/usloviya',
          acquireLicensePage: '/usloviya',
          aiDisclosure: 'Изображения создаёт нейросеть.',
        },
        infoPages: {
          terms: {
            title: 'Условия использования',
            metaDescription: 'Условия использования открыток',
            body: lexical('Слишком коротко.'),
          },
        },
        adSlots: [{ position: 'under-h1', width: 300, height: 250, enabled: true }],
      },
      overrideAccess: false,
      user: admin as UserArg,
    });

    record('admin пишет настройки', organizationJsonLd(organizationFacts(filled)) !== null);
    record(
      'лицензионный блок собран из заполненных полей',
      imageLicenseJsonLd(imageLicenseFacts(filled)) !== null &&
        aiDisclosureText(imageLicenseFacts(filled)) === 'Изображения создаёт нейросеть.',
    );
    record(
      'рекламное место с размерами выводится',
      renderableAdSlots(adSlotFacts(filled), 'under-h1').length === 1,
    );
    record(
      'автор изменения — admin, подсунутая роль не принята',
      filled.audit?.authorRole === 'admin',
      String(filled.audit?.authorRole),
    );
    record(
      'признак API-ключа поставлен сервером (false), а не принят из данных',
      filled.audit?.viaApiKey === false,
    );
    record(
      'время изменения поставлено сервером',
      typeof filled.audit?.changedAt === 'string' && filled.audit.changedAt !== '',
    );
    const changedBy = filled.audit?.changedBy;
    record(
      'в авторе стоит аккаунт администратора, а не подсунутый сервисный',
      (typeof changedBy === 'number' ? changedBy : changedBy?.id) === adminDoc.id,
    );

    /* --------------------------------------------------------------- */
    /* 5. Ч-23: индексируемость переключает только реальный текст       */
    /* --------------------------------------------------------------- */

    record(
      'короткий текст служебной страницы индексацию не открывает',
      !isInfoPageIndexable(infoPageFacts(filled, 'terms')),
    );

    const withText = await payload.updateGlobal({
      slug: 'site-settings',
      data: { infoPages: { terms: { body: lexical(longText) } } },
      overrideAccess: false,
      user: admin as UserArg,
    });
    record(
      'наполненная страница получает право на index,follow',
      isInfoPageIndexable(infoPageFacts(withText, 'terms')),
    );

    /* --------------------------------------------------------------- */
    /* 6. Публичное чтение не отдаёт группу аудита                      */
    /* --------------------------------------------------------------- */

    const publicRead = await payload.findGlobal({ slug: 'site-settings', overrideAccess: false });
    record(
      'группа audit не отдаётся анонимному читателю',
      publicRead.audit?.authorRole === undefined && publicRead.audit?.changedBy === undefined,
      JSON.stringify(publicRead.audit ?? null),
    );
  } finally {
    /* --------------------------------------------------------------- */
    /* Уборка: глобал возвращается в пустое состояние                   */
    /* --------------------------------------------------------------- */
    const reset = await payload.updateGlobal({
      slug: 'site-settings',
      data: {
        adSlots: [],
        imageLicense: {
          acquireLicensePage: null,
          aiDisclosure: null,
          copyrightNotice: null,
          creator: null,
          creditText: null,
          license: null,
        },
        infoPages: {
          about: { body: null, h1: null, metaDescription: null, title: null },
          contacts: { body: null, h1: null, metaDescription: null, title: null },
          terms: { body: null, h1: null, metaDescription: null, title: null },
        },
        organization: {
          email: null,
          legalName: null,
          logo: null,
          name: null,
          sameAs: [],
          telephone: null,
        },
      },
      overrideAccess: false,
      user: admin as UserArg,
    });

    record(
      'после уборки блок Organization снова не выводится',
      organizationJsonLd(organizationFacts(reset)) === null,
    );
    record(
      'после уборки лицензионный блок снова не выводится',
      imageLicenseJsonLd(imageLicenseFacts(reset)) === null,
    );
    record(
      'после уборки служебные страницы снова noindex и вне sitemap',
      (['about', 'contacts', 'terms'] as const).every(
        (key) => !isInfoPageIndexable(infoPageFacts(reset, key)),
      ),
    );
    record(
      'после уборки рекламных мест нет',
      renderableAdSlots(adSlotFacts(reset), 'under-h1').length === 0,
    );

    await payload.delete({ collection: 'users', id: service.id });
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\nПроверок: ${checks.length}, провалено: ${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
