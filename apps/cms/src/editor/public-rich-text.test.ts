/**
 * Набор фич редактора публичного текста (правка по вердикту ревизии Э3-05/Э3-06).
 *
 * Тест сторожит ровно одно: набор фич поля не шире того, что печатает публичный
 * разбор `apps/web`. Ожидания записаны ЗДЕСЬ, а не в модуле, — иначе возврат
 * полного набора «исправлялся» бы правкой той же константы, которую тест
 * проверяет, и падения не было бы.
 *
 * Сравнение идёт с настоящим `defaultEditorFeatures` пакета, поэтому тест
 * замечает не только наши правки, но и новую фичу, появившуюся в дефолтах
 * Payload: она попадёт в список расхождений и потребует решения — печатает её
 * шаблон или нет.
 */
import { defaultEditorFeatures } from '@payloadcms/richtext-lexical';
import type { Field, FieldAffectingData } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_RICH_TEXT_HEADING_SIZES,
  PUBLIC_RICH_TEXT_NODE_TYPES,
  publicRichTextFeatures,
  publicRichTextHooks,
  unsupportedRichTextNodes,
} from './public-rich-text';

function keysOf(features: readonly { readonly key: string }[]): readonly string[] {
  return features.map((feature) => feature.key);
}

/** Сборщик полей ссылки, как его вызовет сам LinkFeature. */
type FieldsBuilder = (args: { readonly defaultFields: FieldAffectingData[] }) => unknown;

function isFieldsBuilder(value: unknown): value is FieldsBuilder {
  return typeof value === 'function';
}

function propsOf(key: string): Record<string, unknown> {
  const feature = publicRichTextFeatures().find((candidate) => candidate.key === key);
  if (feature === undefined) {
    throw new Error(`Фича «${key}» в наборе не найдена`);
  }
  const props: unknown = feature.serverFeatureProps;
  if (typeof props !== 'object' || props === null) {
    throw new Error(`У фичи «${key}» нет props`);
  }
  return { ...props };
}

describe('набор фич публичного richText', () => {
  it('состав набора фиксирован', () => {
    expect(keysOf(publicRichTextFeatures())).toEqual([
      'bold',
      'italic',
      'underline',
      'strikethrough',
      'subscript',
      'superscript',
      'inlineCode',
      'paragraph',
      'heading',
      'unorderedList',
      'orderedList',
      'link',
      'blockquote',
      'toolbarInline',
    ]);
  });

  it('из дефолтов Payload исключено ровно то, что публичный разбор теряет молча', () => {
    const ours = keysOf(publicRichTextFeatures());
    const defaults = keysOf(defaultEditorFeatures);

    // upload / relationship — узлы без `children`: содержимое исчезает целиком.
    // horizontalRule — разбор пропускает как оформление.
    // checklist — состояние галочки печатать нечем.
    // align / indent — разбор игнорирует, админка и страница показали бы разное.
    expect(defaults.filter((key) => !ours.includes(key))).toEqual([
      'align',
      'indent',
      'checklist',
      'relationship',
      'upload',
      'horizontalRule',
    ]);
  });

  it('в наборе нет фичи, которой нет в дефолтах: своих узлов не добавляем', () => {
    const defaults = keysOf(defaultEditorFeatures);
    expect(keysOf(publicRichTextFeatures()).filter((key) => !defaults.includes(key))).toEqual([]);
  });

  it('фичи создаются заново на каждый вызов: props одного поля не достаются другому', () => {
    const first = publicRichTextFeatures();
    const second = publicRichTextFeatures();
    expect(first[0]).not.toBe(second[0]);
  });
});

describe('заголовки внутри текста', () => {
  it('h1 выбрать нельзя: единственный h1 страницы — поле записи', () => {
    expect(propsOf('heading').enabledHeadingSizes).toEqual(['h2', 'h3', 'h4']);
    expect([...PUBLIC_RICH_TEXT_HEADING_SIZES]).not.toContain('h1');
  });
});

describe('ссылки', () => {
  it('внутренние ссылки по идентификатору записи выключены', () => {
    // Пустой набор коллекций убирает и вид `internal`, и поле выбора записи.
    expect(propsOf('link').enabledCollections).toEqual([]);
  });

  it('автоссылки выключены: вставленный адрес остаётся текстом', () => {
    expect(propsOf('link').disableAutoLinks).toBe(true);
  });

  it('адрес ссылки проверяется тем же правилом, по которому печатает шаблон', () => {
    const build = propsOf('link').fields;
    if (!isFieldsBuilder(build)) {
      throw new Error('LinkFeature собран без функции полей');
    }
    const defaultFields = [
      { name: 'text', type: 'text', required: true },
      { name: 'url', type: 'text', required: true },
      { name: 'newTab', type: 'checkbox' },
    ] as unknown as FieldAffectingData[];

    const fields: unknown = build({ defaultFields });
    const url = (fields as readonly Field[]).find(
      (field): field is Field & { readonly validate: (value: unknown) => string | true } =>
        'name' in field && field.name === 'url' && 'validate' in field,
    );
    if (url === undefined) {
      throw new Error('Поле адреса ссылки не найдено');
    }

    expect(url.validate('/podborki/prazdniki/8-marta')).toBe(true);
    expect(url.validate('https://example.com')).toBe(true);
    expect(typeof url.validate('mailto:info@example.com')).toBe('string');
    expect(typeof url.validate('javascript:alert(1)')).toBe('string');
    expect(typeof url.validate('//example.com')).toBe('string');
  });
});

/* ------------------------------------------------------------------ */
/* Серверная сторона: узел без фичи не проходит через API              */
/* ------------------------------------------------------------------ */

/**
 * Почему одного набора фич недостаточно.
 *
 * Проверено по `@payloadcms/richtext-lexical/dist/validate/validateNodes.js`:
 * валидация запускает проверки, ЗАРЕГИСТРИРОВАННЫЕ фичами, а у отсутствующей
 * фичи проверок нет — её узел проходит молча и сохраняется. В админке такой узел
 * не вставить, а через REST и GraphQL можно, и правило, живущее в интерфейсе,
 * внешний AI-редактор обходит через API. Отсюда серверный хук.
 */
describe('узлы, которых публичный разбор не печатает', () => {
  function document(...children: unknown[]): unknown {
    return { root: { type: 'root', children } };
  }

  const paragraph = { type: 'paragraph', children: [{ type: 'text', text: 'Текст' }] };

  it('поддерживаемый документ проходит', () => {
    expect(
      unsupportedRichTextNodes(
        document(
          paragraph,
          { type: 'heading', tag: 'h2', children: [{ type: 'text', text: 'Заголовок' }] },
          {
            type: 'list',
            listType: 'bullet',
            children: [{ type: 'listitem', children: [{ type: 'text', text: 'Пункт' }] }],
          },
          { type: 'quote', children: [{ type: 'text', text: 'Цитата' }] },
          {
            type: 'paragraph',
            children: [
              {
                type: 'link',
                fields: { linkType: 'custom', url: '/usloviya' },
                children: [{ type: 'text', text: 'условия' }],
              },
            ],
          },
        ),
      ),
    ).toEqual([]);
  });

  it('upload, relationship и block называются все сразу, без повторов', () => {
    expect(
      unsupportedRichTextNodes(
        document(
          { type: 'upload', value: 7, relationTo: 'card-images' },
          paragraph,
          { type: 'relationship', value: { id: 3 }, relationTo: 'cards' },
          { type: 'upload', value: 8, relationTo: 'card-images' },
          { type: 'block', fields: {} },
        ),
      ),
    ).toEqual(['block', 'relationship', 'upload']);
  });

  it('узел, вложенный в абзац, тоже находится', () => {
    expect(
      unsupportedRichTextNodes(
        document({ type: 'paragraph', children: [{ type: 'inlineBlock', fields: {} }] }),
      ),
    ).toEqual(['inlineBlock']);
  });

  it('пустое значение и отсутствие документа — не нарушение', () => {
    expect(unsupportedRichTextNodes(null)).toEqual([]);
    expect(unsupportedRichTextNodes(undefined)).toEqual([]);
    expect(unsupportedRichTextNodes(document())).toEqual([]);
  });

  it('в наборе разрешённых типов нет ни upload, ни relationship, ни разделителя', () => {
    for (const type of ['upload', 'relationship', 'block', 'inlineBlock', 'horizontalrule']) {
      expect(PUBLIC_RICH_TEXT_NODE_TYPES.has(type), type).toBe(false);
    }
  });

  it('хук поля отклоняет такой документ с внятным текстом', () => {
    const [hook] = publicRichTextHooks().beforeValidate;
    if (hook === undefined) {
      throw new Error('у поля нет хука beforeValidate');
    }
    const args = {
      value: document({ type: 'upload', value: 7, relationTo: 'card-images' }),
    } as unknown as Parameters<typeof hook>[0];

    expect(() => hook(args)).toThrow(/upload/u);
  });

  it('хук пропускает поддерживаемый документ, возвращая значение как есть', () => {
    const [hook] = publicRichTextHooks().beforeValidate;
    if (hook === undefined) {
      throw new Error('у поля нет хука beforeValidate');
    }
    const value = document(paragraph);
    const args = { value } as unknown as Parameters<typeof hook>[0];
    expect(hook(args)).toBe(value);
  });

  it('каждое поле получает свой массив хуков', () => {
    expect(publicRichTextHooks().beforeValidate).not.toBe(publicRichTextHooks().beforeValidate);
  });
});
