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
import { describe, expect, it } from 'vitest';

import { richTextBlocks } from '../../apps/web/src/seo/rich-text.js';

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
