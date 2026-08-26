/**
 * Вводный текст подборки: разбор lexical-документа (задача Э3-06).
 *
 * Норма — ТЗ §5.3 (у подборки есть содержательный вводный текст), `CLAUDE.md`,
 * раздел «Рендеринг»: основной текст присутствует в HTML-ответе сервера, ровно
 * один `<h1>` на страницу, навигация только `<a href>`.
 *
 * Проверяется ЧИСТЫЙ разбор (`apps/web/src/seo/rich-text.ts`). Печать элементов
 * — компоненты `RichText.astro` и `TextRun.astro`: они берут теги и текст из
 * этого результата и ничего не решают сами, а экранирование текста выполняет
 * шаблонизатор (`set:html` в этом пути не участвует).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DECLINED_TEXT_FORMAT_BITS,
  richTextBlocks,
  TEXT_FORMAT_BITS,
} from '../../apps/web/src/seo/rich-text.js';

/** Текстовый узел lexical: формат — битовая маска. */
function text(value: string, format = 0): Record<string, unknown> {
  return { type: 'text', text: value, format, detail: 0, mode: 'normal', style: '', version: 1 };
}

function doc(...children: Record<string, unknown>[]): Record<string, unknown> {
  return {
    root: {
      type: 'root',
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  };
}

function paragraph(...children: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'paragraph', children, direction: 'ltr', format: '', indent: 0, version: 1 };
}

describe('блоки вводного текста', () => {
  it('абзацы приходят в порядке документа', () => {
    const blocks = richTextBlocks(
      doc(paragraph(text('Первый абзац.')), paragraph(text('Второй абзац.'))),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: 'paragraph', runs: [expect.objectContaining({ text: 'Первый абзац.' })] });
    expect(blocks[1]?.kind).toBe('paragraph');
  });

  it('пустой, отсутствующий и мусорный документ дают пустой список, а не отказ', () => {
    expect(richTextBlocks(null)).toEqual([]);
    expect(richTextBlocks(undefined)).toEqual([]);
    expect(richTextBlocks('строка')).toEqual([]);
    expect(richTextBlocks(doc())).toEqual([]);
    expect(richTextBlocks(doc(paragraph()))).toEqual([]);
    expect(richTextBlocks(doc(paragraph(text('   '))))).toEqual([]);
  });

  it('заголовок внутри текста НИКОГДА не даёт второй H1', () => {
    // Единственный H1 страницы — заголовок записи. Уровень 1 из вводного текста
    // понижается, иначе на странице оказалось бы два H1 (провал п. 22.2).
    const blocks = richTextBlocks(
      doc(
        { type: 'heading', tag: 'h1', children: [text('Из h1')], version: 1 },
        { type: 'heading', tag: 'h2', children: [text('Из h2')], version: 1 },
        { type: 'heading', tag: 'h3', children: [text('Из h3')], version: 1 },
        { type: 'heading', tag: 'h6', children: [text('Из h6')], version: 1 },
      ),
    );

    expect(blocks.map((block) => (block.kind === 'heading' ? block.level : 0))).toEqual([2, 2, 3, 4]);
  });

  it('выделение превращается в теги в фиксированном порядке вложенности', () => {
    // 1 = bold, 2 = italic, 16 = code (маска lexical).
    const blocks = richTextBlocks(doc(paragraph(text('жирный курсив', 1 | 2), text('код', 16))));
    const runs = blocks[0]?.kind === 'paragraph' ? blocks[0].runs : [];

    expect(runs[0]?.tags).toEqual(['strong', 'em']);
    expect(runs[1]?.tags).toEqual(['code']);
  });

  it('список становится блоком списка, вид — из listType', () => {
    const listItem = (value: string): Record<string, unknown> => ({
      type: 'listitem',
      children: [text(value)],
      version: 1,
    });
    const blocks = richTextBlocks(
      doc(
        { type: 'list', listType: 'bullet', tag: 'ul', children: [listItem('Раз'), listItem('Два')], version: 1 },
        { type: 'list', listType: 'number', tag: 'ol', children: [listItem('Первый')], version: 1 },
      ),
    );

    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[0]?.kind === 'list' ? blocks[0].items.length : 0).toBe(2);
  });

  it('вложенный список внутри элемента не склеивает слова', () => {
    // Находка ревизии Э3-05/Э3-06 (MINOR 1): абзац и вложенный список внутри
    // `listitem` расплющивались в один `<li>`, фрагменты печатались вплотную, и
    // «Раз» + «Вложенный» давали «РазВложенный». Для переноса строки склейка
    // специально исключена пробелом — на границе дочернего блока она обязана
    // быть исключена так же.
    const blocks = richTextBlocks(
      doc({
        type: 'list',
        listType: 'bullet',
        tag: 'ul',
        version: 1,
        children: [
          {
            type: 'listitem',
            version: 1,
            children: [
              text('Раз'),
              {
                type: 'list',
                listType: 'bullet',
                tag: 'ul',
                version: 1,
                children: [
                  { type: 'listitem', children: [text('Вложенный')], version: 1 },
                  { type: 'listitem', children: [text('И ещё')], version: 1 },
                ],
              },
            ],
          },
          { type: 'listitem', version: 1, children: [paragraph(text('Два')), paragraph(text('Три'))] },
        ],
      }),
    );

    const items = blocks[0]?.kind === 'list' ? blocks[0].items : [];
    const flat = items.map((runs) => runs.map((run) => run.text).join(''));

    expect(flat).toHaveLength(2);
    expect(flat[0]).toBe('Раз Вложенный И ещё');
    expect(flat[1]).toBe('Два Три');
  });

  it('узел, чьё содержимое лежит не в children, ВАЛИТ разбор с указанием типа', () => {
    // Находка ревизии Э3-05/Э3-06 (MAJOR): такой узел давал ноль фрагментов, и
    // проверка «есть ли содержание» отбрасывала блок БЕЗ СЛЕДА — текст пропадал
    // с опубликованной страницы молча. Со стороны CMS набор фич редактора сужен
    // так, что эти узлы невыразимы, но разбор обязан отказывать сам: тихая
    // потеря текста дороже 500.
    const invisible: Record<string, unknown>[] = [
      { type: 'upload', relationTo: 'card-images', value: 5, version: 1 },
      { type: 'relationship', relationTo: 'cards', value: 7, version: 1 },
      { type: 'block', fields: { blockType: 'callout', text: 'Текст внутри блока' }, version: 1 },
      { type: 'inlineBlock', fields: { blockType: 'badge' }, version: 1 },
    ];

    for (const node of invisible) {
      expect(() => richTextBlocks(doc(node))).toThrow(String(node['type']));
    }
  });

  it('узел без типа тоже отказ, а не молчаливая потеря', () => {
    expect(() => richTextBlocks(doc({ version: 1 }))).toThrow(/type/);
  });

  it('пустой абзац и горизонтальная линия отказа НЕ вызывают', () => {
    // Разница с проверкой выше принципиальная: пустой абзац — это пустая строка,
    // которую редактор оставил намеренно, а горизонтальная линия — оформление,
    // которое разбор не печатает по решению задачи Э3-06. Оба узла известны
    // разбору, и терять в них нечего.
    expect(richTextBlocks(doc(paragraph()))).toEqual([]);
    expect(richTextBlocks(doc({ type: 'horizontalrule', version: 1 }))).toEqual([]);
    expect(
      richTextBlocks(doc(paragraph(text('Абзац.')), { type: 'horizontalrule', version: 1 })),
    ).toHaveLength(1);
  });

  it('цитата и неизвестный тип узла не теряют текста', () => {
    // Молча выброшенный абзац виден не ошибкой, а отсутствием текста на
    // странице, поэтому неизвестный узел раскрывается, а не пропускается.
    const blocks = richTextBlocks(
      doc(
        { type: 'quote', children: [text('Цитата')], version: 1 },
        { type: 'sovsem-novyy-uzel', children: [text('Текст из неизвестного узла')], version: 1 },
      ),
    );

    expect(blocks[0]?.kind).toBe('quote');
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
    expect(blocks[1]?.kind === 'paragraph' ? blocks[1].runs[0]?.text : '').toBe(
      'Текст из неизвестного узла',
    );
  });
});

describe('ссылки внутри вводного текста', () => {
  function linkDoc(fields: Record<string, unknown>): ReturnType<typeof richTextBlocks> {
    return richTextBlocks(
      doc(paragraph({ type: 'link', fields, children: [text('ссылка')], version: 1 })),
    );
  }

  function firstRun(blocks: ReturnType<typeof richTextBlocks>): {
    href: string | null;
    external: boolean;
    text: string;
  } {
    const block = blocks[0];
    const run = block?.kind === 'paragraph' ? block.runs[0] : undefined;
    return { external: run?.external ?? false, href: run?.href ?? null, text: run?.text ?? '' };
  }

  it('путь от корня становится внутренней ссылкой', () => {
    expect(firstRun(linkDoc({ linkType: 'custom', url: '/podborki/prazdniki/8-marta' }))).toEqual({
      external: false,
      href: '/podborki/prazdniki/8-marta',
      text: 'ссылка',
    });
  });

  it('абсолютный http(s) — внешняя ссылка (получит rel=nofollow noopener)', () => {
    expect(firstRun(linkDoc({ linkType: 'custom', url: 'https://example.test/a' }))).toEqual({
      external: true,
      href: 'https://example.test/a',
      text: 'ссылка',
    });
  });

  it('внутренняя ссылка по идентификатору записи остаётся ТЕКСТОМ, а не href="#"', () => {
    // Официальный конвертер Payload в этом случае печатает href="#" — прямой
    // запрет проекта (hash-адресов в навигации нет). Путь записи по её
    // идентификатору в чистом модуле не вычислить, а адрес наугад — ссылка в
    // никуда; слова при этом сохраняются.
    const run = firstRun(linkDoc({ linkType: 'internal', doc: { relationTo: 'cards', value: 7 } }));

    expect(run.href).toBeNull();
    expect(run.text).toBe('ссылка');
  });

  it('адреса не тех схем ссылкой не становятся', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//chuzhoy.test/x',
      'mailto:a@b.test',
      'otnositelnyy/put',
    ]) {
      expect(firstRun(linkDoc({ linkType: 'custom', url })).href).toBeNull();
    }
  });

  it('выделение внутри ссылки сохраняется вместе с адресом', () => {
    const blocks = richTextBlocks(
      doc(
        paragraph({
          type: 'link',
          fields: { linkType: 'custom', url: '/podborki/adresaty/mame' },
          children: [text('маме', 1)],
          version: 1,
        }),
      ),
    );
    const run = blocks[0]?.kind === 'paragraph' ? blocks[0].runs[0] : undefined;

    expect(run?.href).toBe('/podborki/adresaty/mame');
    expect(run?.tags).toEqual(['strong']);
  });
});

/* ------------------------------------------------------------------ */
/* Битовые маски формата: сверка с апстримом                          */
/* ------------------------------------------------------------------ */

/**
 * Значения масок в `apps/web/src/seo/rich-text.ts` СКОПИРОВАНЫ числами из
 * `NodeFormat` пакета `@payloadcms/richtext-lexical` — импортировать оттуда в
 * продуктовый путь нельзя (обоснование в шапке модуля: пакет тянет peer-зависимости
 * на react, react-dom и next, а Astro-приложение без React получило бы их в дерево
 * ради разбора одного поля). Расхождение с апстримом проявилось бы ПОТЕРЕЙ
 * ВЫДЕЛЕНИЯ без единого падения — находка ревизии Э3-05/Э3-06 (MINOR 2).
 *
 * Тест — законное место для такого импорта: `@payloadcms/richtext-lexical` уже
 * зависимость `apps/cms`, и в дерево зависимостей публичного сервера он от этого
 * не попадает. Разрешается пакет ОТ `apps/cms`, потому что в корне
 * монорепозитория его нет: pnpm не поднимает зависимости приложения наверх.
 */
const requireFromCms = createRequire(
  new URL('../../apps/cms/package.json', import.meta.url),
);
const lexical = (await import(
  pathToFileURL(requireFromCms.resolve('@payloadcms/richtext-lexical')).href
)) as {
  readonly NodeFormat: Readonly<Record<string, number>>;
  readonly TEXT_TYPE_TO_FORMAT: Readonly<Record<string, number>>;
};

describe('битовые маски формата совпадают с @payloadcms/richtext-lexical', () => {
  it('каждая маска разбора равна значению NodeFormat из пакета', () => {
    for (const [name, bit] of Object.entries({
      ...TEXT_FORMAT_BITS,
      ...DECLINED_TEXT_FORMAT_BITS,
    })) {
      expect(lexical.NodeFormat[name], `маска ${name}`).toBe(bit);
    }
  });

  it('ни один формат текста апстрима не остался без решения', () => {
    // Проверка ловит НОВЫЙ бит формата в апстриме: пока он не назван ни среди
    // печатаемых, ни среди сознательно не печатаемых, разбор молча терял бы это
    // выделение. Источник набора — `TEXT_TYPE_TO_FORMAT` пакета: это ровно
    // форматы текстового узла, без режимов и выравниваний из того же объекта.
    const known = new Set<number>([
      ...Object.values(TEXT_FORMAT_BITS),
      ...Object.values(DECLINED_TEXT_FORMAT_BITS),
    ]);
    const unaccounted = Object.entries(lexical.TEXT_TYPE_TO_FORMAT).filter(
      ([, bit]) => !known.has(bit),
    );

    expect(unaccounted).toEqual([]);
  });

  it('печатаемые и непечатаемые форматы не пересекаются', () => {
    for (const name of Object.keys(DECLINED_TEXT_FORMAT_BITS)) {
      expect(name in TEXT_FORMAT_BITS).toBe(false);
    }
  });
});
