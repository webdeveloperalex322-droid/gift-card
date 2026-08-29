/**
 * Дашборд SEO-здоровья (задача Э5-04, ТЗ §8.4) — стартовый экран админки.
 *
 * Серверный компонент: данные читаются на сервере тем же access control, что
 * REST и GraphQL, и приходят в HTML готовыми. Клиентского JS здесь нет вовсе, и
 * это не оптимизация — экран, который считает свои числа в браузере, показывал
 * бы их правами браузера, а не правами смотрящего.
 *
 * Вся арифметика — в `./health.ts` и `./collect.ts`, здесь только разметка.
 * Разделение сделано ради тестов: числа дашборда проверяются юнит-тестами, а
 * React-компонент остаётся тем, чем должен быть, — способом их показать.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: ни одной кнопки, меняющей состояние. Ни «опубликовать», ни
 * «закрыть от индексации», ни «перегенерировать карту». Дашборд — это зеркало;
 * решения принимаются в записях, где работают все проверки статусной модели.
 */
// React импортируется ЯВНО, хотя Next.js собирает JSX автоматической
// трансформацией и без него. Причина в другом потребителе: смоук рисует эту же
// разметку через `payload run` (esbuild), а тот берёт `jsx` из tsconfig, где для
// Next стоит `preserve`, и получает классическую трансформацию с обращением к
// `React.createElement`. Без импорта смоук падает с «React is not defined» —
// проверено 2026-08-29.
import React from 'react';
import { createLocalReq, type Payload, type TypedUser } from 'payload';

import { LINK_AUDIT_MAX_CLICKS } from '../audit/link-audit';
import { collectDashboardModel } from './collect';
import type { DashboardModel, RecordRef } from './health';

const COLLECTION_LABELS: Readonly<Record<string, string>> = {
  cards: 'Открытки',
  collections: 'Подборки',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  overdue: 'дедлайн сорван',
  upcoming: 'дедлайн приближается',
};

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  'half-set': 'задана одна граница показа — сезонный блок не покажется',
  inverted: 'границы показа перевёрнуты — это опечатка, а не окно',
};

function moment(value: string | null): string {
  if (value === null) {
    return 'дата неизвестна';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('ru-RU');
}

function label(record: RecordRef): string {
  const title = record.title.trim() === '' ? '(без заголовка)' : record.title;
  return record.path === null ? `${title} — путь не собран` : `${title} — ${record.path}`;
}

function Section(props: { children: React.ReactNode; note?: string; title: string }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '0.25rem' }}>{props.title}</h3>
      {props.note === undefined ? null : (
        <p style={{ margin: '0 0 0.5rem', opacity: 0.75 }}>{props.note}</p>
      )}
      {props.children}
    </section>
  );
}

function Rows(props: { empty: string; items: readonly string[] }) {
  if (props.items.length === 0) {
    return <p style={{ margin: 0 }}>{props.empty}</p>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
      {props.items.map((item, index) => (
        <li key={`${String(index)} ${item}`}>{item}</li>
      ))}
    </ul>
  );
}

/** Разметка модели. Вынесена отдельно, чтобы её можно было отрисовать без базы. */
export function SeoHealthView(props: { model: DashboardModel }) {
  const { model } = props;
  const audit = model.audit;

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>SEO-здоровье</h2>
      {model.scanTruncated ? (
        <p>
          <strong>Внимание:</strong> записей больше, чем прочитано за один заход. Числа ниже —
          нижняя граница, а не итог.
        </p>
      ) : null}

      <Section title="Записи по статусам">
        <Rows
          empty="Записей пока нет."
          items={model.statuses.map(
            (row) =>
              `${COLLECTION_LABELS[row.collection] ?? row.collection}: черновиков ${String(row.draft)}, ` +
              `на проверке ${String(row.review)}, опубликовано ${String(row.published)}` +
              (row.other > 0 ? `, прочее ${String(row.other)}` : '') +
              ` (всего ${String(row.total)})`,
          )}
        />
      </Section>

      <Section
        note="Совпадение нормализованных заголовков и описаний по открыткам и подборкам сразу, среди published и review. Считается по текущим данным."
        title={`Дубли метатегов сейчас: ${String(model.metaKeys.groupCount)}`}
      >
        <Rows
          empty="Совпадений нет."
          items={model.metaKeys.groups.map(
            (duplicate) =>
              `${duplicate.field === 'title' ? 'заголовок' : 'meta description'} «${duplicate.key}» — ` +
              duplicate.records.map((record) => label(record)).join('; '),
          )}
        />
      </Section>

      <Section
        note={
          model.metaSnapshots.count === 0
            ? 'Снимок делается при сохранении записи и верен на момент снимка.'
            : `Снимок верен НА МОМЕНТ ПРОВЕРКИ, а не на сейчас. Самый старый снимок: ${moment(model.metaSnapshots.oldestCheckedAt)}. Подтверждений выдано: ${String(model.metaSnapshots.confirmedCount)}.`
        }
        title={`Записи со снимком конфликта: ${String(model.metaSnapshots.count)}`}
      >
        <Rows
          empty="Снимков с конфликтами нет."
          items={model.metaSnapshots.rows.map(
            (row) =>
              `${label(row)} — совпадений ${String(row.total)}, проверено ${moment(row.checkedAt)}` +
              (row.confirmed ? `, подтверждено (${row.confirmedBy ?? 'автор не записан'})` : ''),
          )}
        />
      </Section>

      <Section
        note={
          model.visual.truncatedCount === 0
            ? 'Похожие ищутся среди published и review по перцептивному хешу.'
            : `У ${String(model.visual.truncatedCount)} записей обход каталога был НЕПОЛНЫМ: «похожих не найдено» у них означает «дальше не искали».`
        }
        title={`Визуальные дубли: ${String(model.visual.withSimilarCount)}`}
      >
        <Rows
          empty="Похожих изображений не найдено."
          items={[
            ...model.visual.rows.map(
              (row) =>
                `${label(row)} — похожих ${String(row.similar)}` +
                (row.closest === null ? '' : `, ближайшее расстояние ${String(row.closest)}`),
            ),
            ...model.visual.truncated.map((row) => `${label(row)} — проверка неполная`),
          ]}
        />
      </Section>

      <Section
        note="Ждут решения человека: опубликовать может только администратор."
        title={`На проверке (review): ${String(model.review.count)}`}
      >
        <Rows empty="Записей на проверке нет." items={model.review.rows.map((row) => label(row))} />
      </Section>

      <Section
        note={`Сорвано: ${String(model.seasonal.overdueCount)}, приближается: ${String(model.seasonal.upcomingCount)}. Готовой считается подборка, дошедшая до review: публикация — отдельное решение человека.`}
        title="Сезонные дедлайны"
      >
        <Rows
          empty="Приближающихся и сорванных дедлайнов нет."
          items={[
            ...model.seasonal.alerts.map(
              (row) =>
                `${label(row)} — ${STATE_LABELS[row.deadline.state] ?? row.deadline.state}, ` +
                `готовность ${moment(row.deadline.readyBy)}` +
                (row.deadline.readyByDerived ? ' (выведена из даты праздника)' : '') +
                (row.deadline.holidayPassed ? '; дата праздника прошла — обновите её в записи' : ''),
            ),
            ...model.seasonal.windowIssues.map(
              (row) =>
                `${label(row)} — ${WINDOW_LABELS[row.deadline.showWindow ?? ''] ?? 'окно показа задано неверно'}`,
            ),
          ]}
        />
      </Section>

      <Section
        note={
          audit === null
            ? model.auditAbsence === 'forbidden'
              ? 'Отчёт закрыт для вашей роли.'
              : 'Проверка ни разу не запускалась. Пустой список сирот здесь означал бы «не проверяли», а не «сирот нет».'
            : `Обход от главной, ${moment(audit.finishedAt)}. ` +
              (audit.reliable
                ? 'Обход дошёл до конца.'
                : 'ВНИМАНИЕ: обход не состоялся или оборван пределом — числам о достижимости верить нельзя.')
        }
        title="Внутренние ссылки"
      >
        {audit === null ? (
          <p style={{ margin: 0 }}>Данных нет.</p>
        ) : (
          <Rows
            empty=""
            items={[
              `Сирот (нет ссылок либо глубже ${String(LINK_AUDIT_MAX_CLICKS)} переходов): ${String(audit.orphans)}`,
              `Битых внутренних ссылок: ${String(audit.broken)}`,
              `Ссылок через редирект: ${String(audit.redirected)}`,
              `Опубликованных записей, чей адрес не отдал 200 (включая не ответившие вовсе): ${String(audit.unhealthy)}`,
              `Адресов, которые не успели спросить: ${String(audit.notMeasured)}`,
            ]}
          />
        )}
      </Section>

      <Section
        note={
          'Отдельной «генерации» карты не существует: она собирается на запросе, файла на диске ' +
          'нет. Поэтому здесь наблюдение, а не дата генерации. Расхождение с формулировкой ' +
          'CLAUDE.md заведено вопросом Э4-04-A.'
        }
        title="Карта сайта: последнее наблюдение"
      >
        {audit === null ? (
          <p style={{ margin: 0 }}>Карту сайта ещё не спрашивали.</p>
        ) : (
          <Rows
            empty=""
            items={[
              `Ответ /sitemap.xml: ${audit.sitemapIndexStatus === null ? 'не ответил' : String(audit.sitemapIndexStatus)}`,
              `Адресов в карте: ${audit.sitemapUrls === null ? 'карта не прочитана' : String(audit.sitemapUrls)}`,
              `Наблюдение сделано: ${moment(audit.finishedAt)}`,
            ]}
          />
        )}
      </Section>

      <Section note="Журнал seo-history: кто и что менял." title="Последние изменения">
        <Rows
          empty={
            model.historyAbsence === 'forbidden'
              ? 'Журнал изменений не отдан вашей роли. Это НЕ «изменений не было»: что менялось, отсюда не видно.'
              : 'Изменений пока нет.'
          }
          items={model.history.map(
            (entry) =>
              `${moment(entry.changedAt)} — ${entry.documentPath ?? 'путь не собран'}: ${entry.field} ` +
              `(${entry.operation}), автор: ${entry.authorRole}`,
          )}
        />
      </Section>
    </div>
  );
}

/**
 * Что показывается вместо дашборда, когда сбор не состоялся.
 *
 * Отдельный блок, а не пустое место: экран, который молча исчез, читается как
 * «показывать нечего», то есть как «всё хорошо». Причина печатается прямо на
 * экране — админка это внутренний интерфейс за авторизацией, и текст ошибки в
 * ней стоит дешевле, чем поход в журнал сервера за тем же самым.
 */
export function SeoHealthFailure(props: { reason: string }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2>SEO-здоровье</h2>
      <p>
        <strong>Сводка не собралась.</strong> Это отказ СБОРА, а не результат
        проверки: считать, что нарушений нет, по этому экрану сейчас нельзя.
      </p>
      <p style={{ opacity: 0.75 }}>Причина: {props.reason}</p>
    </div>
  );
}

/**
 * Точка входа для `admin.components.beforeDashboard`.
 *
 * `req` собирается из пользователя, открывшего экран: все запросы пойдут его
 * правами.
 *
 * Весь сбор обёрнут в `try`, и обещание «ошибка сбора не роняет админку» держит
 * именно он. До ревизии 2026-08-29 обещание стояло в этом комментарии, а
 * обёртки не было: падение чтения записей уносило весь стартовый экран, потому
 * что `beforeDashboard`-компонент рисуется на сервере вместе с ним. Отдельные
 * блоки при этом продолжают отвечать за себя сами (`collectAudit`,
 * `collectHistory` возвращают причину отсутствия), а здесь — последняя сеть.
 */
export async function SeoHealth(props: { payload: Payload; user?: TypedUser }) {
  try {
    const req = await createLocalReq(
      props.user === undefined ? {} : { user: props.user },
      props.payload,
    );
    const model = await collectDashboardModel({ payload: props.payload, req });
    return <SeoHealthView model={model} />;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    props.payload.logger.error(`[seo-health] Дашборд не собрался: ${reason}`);
    return <SeoHealthFailure reason={reason} />;
  }
}

export default SeoHealth;
