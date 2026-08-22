/**
 * Модель разметки изображения открытки: `<picture>`/`<img>` из зеркала
 * производных (задача Э3-04).
 *
 * Норма: ТЗ §6.5 («вывод через `<img>`/`<picture>` с реальным `src`,
 * обязательными `width` и `height`, `srcset`/`sizes`; первое крупное изображение
 * без lazy, остальные с ним»), ТЗ §10 (резерв места, отсутствие сдвига макета),
 * `CLAUDE.md` — раздел «Изображения» и раздел «Рендеринг» (первые изображения
 * присутствуют в HTML-ответе сервера, клиентского JS нет).
 *
 * Модуль ЧИСТЫЙ: ни запросов, ни чтения `process.env`, ни импортов Astro и
 * Payload. Поэтому он входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом `tests/unit/web-card-image.test.ts`. Компонент
 * `../components/CardImage.astro` поверх него только печатает атрибуты.
 *
 * ## Единственный источник каждого числа и каждого адреса
 *
 * Вход — зеркало `card.derivative.variants[]` (поле карточки, заполняет CMS).
 * Из него берётся ВСЁ: путь файла (`variant.key` через `derivativePublicPath`),
 * дескриптор `w` в `srcset`, атрибуты `width` и `height`. Ни одно из этих
 * значений не выводится из настроек пайплайна, из `IMAGE_WIDTHS`, из
 * `keyBase`/`nameStem`/`revision` и не пересчитывается по пропорции — это
 * условие C8. Расхождение здесь означало бы `srcset`, обещающий браузеру
 * ширину, которой в файле нет, и резерв места под другую картинку, то есть CLS.
 *
 * ## Что модуль отказывается делать
 *
 *   - **склеивать путь строкой.** `/media/<ключ>` собирает
 *     `derivativePublicPath` из `@otkritka/images/media` — та же функция, по
 *     которой входной сервер РАЗБИРАЕТ запрос файла. Второе написание пути
 *     разошлось бы с отдачей молча, а кеш производных выдан на год
 *     (`immutable`);
 *   - **подставлять хост.** В разметку идёт относительный путь: так адрес не
 *     зависит от того, каким хостом ответил сервер. Абсолютный адрес нужен
 *     только JSON-LD (`ImageObject.contentUrl`, задача Э3-05) и собирается
 *     {@link variantAbsoluteUrl} — единственным хелпером над `SITE_URL`;
 *   - **дополнять набор ширин.** Набор в зеркале — ПОДМНОЖЕСТВО
 *     320/640/960/1280/1920: апскейла пайплайн не делает, у исходника 1100 px
 *     появятся только 320/640/960. Ни одной ширины «на всякий случай» модель не
 *     добавляет и наличия конкретной ширины не предполагает;
 *   - **решать, какое изображение первое.** Это знает только шаблон страницы,
 *     поэтому {@link PictureModelInput.priority} — проп. Значение по умолчанию
 *     БЕЗОПАСНОЕ (`loading="lazy"`): забытый проп обязан давать ленивую
 *     загрузку, а не второй LCP-кандидат на странице.
 */

import { derivativeCacheHeaders, derivativePublicPath } from '@otkritka/images/media';
import { buildAbsoluteUrl, type SharedEnv } from '@otkritka/shared';

/**
 * Формат производной. Набор закрыт набором вывода пайплайна и совпадает с полем
 * `format` в зеркале карточки; проверку соответствия делает компилятор на
 * границе слоя данных (`../data/card-image.ts`), где тип берётся из
 * сгенерированных типов Payload.
 */
export type ImageFormat = 'avif' | 'webp' | 'jpeg';

/**
 * Вариант производной — ровно те четыре поля зеркала, которые нужны разметке.
 *
 * Структурный тип, а не `Pick` от сгенерированного типа Payload: этот модуль
 * обязан грузиться без типов CMS (см. шапку). Мост между зеркалом и этим типом —
 * `../data/card-image.ts`: там расхождение схемы становится ошибкой сборки.
 */
export interface ImageVariant {
  /** Ключ объекта в хранилище. Содержит `revision`, поэтому путь постоянен. */
  readonly key: string;
  readonly format: ImageFormat;
  /** ФАКТИЧЕСКАЯ ширина файла. Отсюда и дескриптор `w`, и атрибут `width`. */
  readonly width: number;
  /** ФАКТИЧЕСКАЯ высота файла. Без пары с шириной место не резервируется. */
  readonly height: number;
}

/**
 * Порядок предпочтения форматов в разметке.
 *
 * Это решение РАЗМЕТКИ, а не копия списка вывода пайплайна: браузер берёт первый
 * `<source>`, который умеет читать, поэтому форматы идут от самого экономного к
 * самому совместимому, а совместимый уходит в `<img>`. Совпадение с порядком
 * `OUTPUT_FORMATS` в `@otkritka/images` — следствие, а не зависимость (и
 * импортировать его отсюда нельзя: он лежит за `index.ts`, который тянет sharp,
 * а веб-серверу нативная библиотека не нужна).
 *
 * Формат, которого в списке нет, отклоняется с ошибкой — см.
 * {@link groupVariantsByFormat}. Молча выпасть он не может: иначе новый формат
 * пайплайна исчез бы из разметки, и заметили бы это по трафику, а не по тесту.
 */
const FORMAT_PREFERENCE: readonly ImageFormat[] = Object.freeze(['avif', 'webp', 'jpeg']);

/**
 * Резервный формат: он идёт в `<img src>` и в его `srcset`.
 *
 * JPEG в наборе есть всегда (контракт пайплайна), но выбирается он ПО ПОЛЮ
 * `format`, а не по позиции в массиве: порядок строк зеркала — свойство данных,
 * и опираться на него значит поставить `src` в зависимость от порядка сохранения.
 */
const FALLBACK_FORMAT: ImageFormat = 'jpeg';

/** MIME-тип формата. Значение для атрибута `type` у `<source>`. */
function mimeType(format: ImageFormat): string {
  return `image/${format}`;
}

/**
 * Роль изображения в вёрстке — и, значит, набор `sizes`.
 *
 * Роль, а не готовая строка пропом: `sizes` описывает, какую ШИРИНУ изображение
 * займёт на странице, и ошибка в нём не видна глазом — она видна лишним
 * трафиком (браузер взял файл шире нужного) или мылом (взял уже нужного).
 * Поэтому наборы живут здесь, проверяются тестом и меняются вместе с CSS сетки,
 * а не переписываются в каждом шаблоне.
 */
export type ImageLayout = 'content-width' | 'grid-tile';

/**
 * Наборы `sizes` по роли. Значения ВЫВЕДЕНЫ из вёрстки layout, а не подобраны.
 *
 * Исходные данные (`../layouts/BaseLayout.astro`): колонка контента —
 * `max-width: var(--content-max)` = `60rem` (960 px) при `padding: 1rem` с двух
 * сторон. Значит доступная ширина колонки = `min(60rem, 100vw) - 2rem`, то есть
 * 928 px на широком экране.
 *
 *   - `content-width` — изображение занимает всю колонку контента (главное
 *     изображение страницы карточки). Отсюда `calc(60rem - 2rem)` на широком
 *     экране и `calc(100vw - 2rem)` на узком;
 *   - `grid-tile` — плитка в сетке списка. Набор посчитан для сетки
 *     `grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem;`
 *     внутри той же колонки: три колонки от 49rem (240·3 + отбивки), две от
 *     33rem, одна ниже. ЭТО КОНТРАКТ С ШАБЛОНОМ СПИСКА (задачи Э3-06, Э3-09):
 *     сетка обязана быть такой, либо набор правится ЗДЕСЬ вместе с CSS — иначе
 *     браузер выбирает ширину под сетку, которой нет.
 *
 * Новой роли (например, узкая плитка блока перелинковки) место здесь же:
 * `sizes` строкой в шаблоне запрещён, потому что тогда его никто не проверит.
 */
export const IMAGE_LAYOUT_SIZES: Readonly<Record<ImageLayout, string>> = Object.freeze({
  'content-width': '(min-width: 60rem) calc(60rem - 2rem), calc(100vw - 2rem)',
  'grid-tile':
    '(min-width: 60rem) calc((60rem - 4rem) / 3), ' +
    '(min-width: 49rem) calc((100vw - 4rem) / 3), ' +
    '(min-width: 33rem) calc((100vw - 3rem) / 2), ' +
    'calc(100vw - 2rem)',
});

/**
 * Значение атрибута `alt` как РЕШЕНИЕ, а не как строка.
 *
 * Пустой `alt` и отсутствующий `alt` — разные вещи: первый заявляет
 * «изображение декоративное, читать нечего», второй означает «атрибут забыли».
 * Поэтому забыть его нельзя даже теоретически: тип не выражает отсутствия, а
 * пустое описание отклоняется ({@link describedImage}). Единственный способ
 * получить `alt=""` — назвать изображение декоративным явно
 * ({@link DECORATIVE_IMAGE}).
 */
export type ImageAlt =
  | { readonly kind: 'described'; readonly text: string }
  | { readonly kind: 'decorative' };

/**
 * Декоративный элемент: `alt=""`.
 *
 * Открытка декоративной не бывает — у неё есть содержание, которое нужно
 * описать. Это значение для служебной графики (иконка, разделитель), у которой
 * текстового смысла нет вовсе.
 */
export const DECORATIVE_IMAGE: ImageAlt = Object.freeze({ kind: 'decorative' });

/**
 * Содержательное описание изображения.
 *
 * @throws Error если описание пусто или состоит из пробелов. Пустая строка,
 *   попавшая сюда из незаполненного поля записи, означала бы, что изображение
 *   молча объявлено декоративным: содержание страницы пропало бы для
 *   скринридера и для поиска по картинкам, а разметка выглядела бы исправной.
 */
export function describedImage(text: string): ImageAlt {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error(
      'Описание изображения (alt) пусто. Пустой alt допустим ТОЛЬКО у декоративных ' +
        'элементов и заявляется явно — значением DECORATIVE_IMAGE. Заполните поле alt ' +
        'записи: перечень ключевых слов или подстановка заголовка вместо описания ' +
        'запрещены (CLAUDE.md, раздел «Изображения»).',
    );
  }
  return { kind: 'described', text: trimmed };
}

/** Значение атрибута `alt`: описание либо пустая строка у декоративного. */
export function altText(alt: ImageAlt): string {
  return alt.kind === 'decorative' ? '' : alt.text;
}

/**
 * Публичный путь файла: `/media/<ключ>`.
 *
 * Хоста в результате нет намеренно (см. шапку). Форму ключа проверяет
 * `derivativePublicPath`: ключ приходит из данных записи, и `..` в нём означал
 * бы адрес наружу пространства производных.
 */
export function variantPath(variant: ImageVariant): string {
  return derivativePublicPath(variant.key);
}

/**
 * Абсолютный адрес файла — для `ImageObject.contentUrl` в JSON-LD (задача Э3-05).
 *
 * Существует ровно для того, чтобы у шаблона не появилось соблазна склеить
 * `SITE_URL` с путём вручную. В разметке `<img>` абсолютный адрес НЕ нужен и не
 * используется.
 *
 * @throws Error если `SITE_URL` не задан или некорректен.
 */
export function variantAbsoluteUrl(variant: ImageVariant, env?: SharedEnv): string {
  const path = variantPath(variant);
  return env === undefined ? buildAbsoluteUrl(path) : buildAbsoluteUrl(path, env);
}

/**
 * Проверка «формат совпадает с расширением ключа».
 *
 * MIME-тип берётся из ключа единственной таблицей проекта (`derivativeCacheHeaders`
 * — та же, по которой файл ОТДАЁТСЯ), и сравнивается с типом, объявленным полем
 * `format`. Расхождение означает, что `<source type>` пообещал браузеру один
 * формат, а по адресу лежит другой: браузер выберет источник, который не сможет
 * прочитать, и изображение не покажется вовсе.
 */
function assertFormatMatchesKey(variant: ImageVariant): void {
  const expected = mimeType(variant.format);
  const actual = derivativeCacheHeaders(variant.key)['Content-Type'];
  if (actual !== expected) {
    throw new Error(
      `Вариант «${variant.key}» объявлен форматом ${variant.format} (${expected}), а по ` +
        `расширению файла это ${String(actual)}. Формат и расширение приходят из одной ` +
        'записи зеркала и разойтись не могут — значит данные повреждены, и выводить такую ' +
        'разметку нельзя: браузер выбрал бы источник, который не умеет читать.',
    );
  }
}

function byWidthAscending(left: ImageVariant, right: ImageVariant): number {
  return left.width - right.width;
}

/** Группа вариантов одного формата: готовый `<source>` без строки `srcset`. */
export interface VariantGroup {
  readonly format: ImageFormat;
  /** Значение атрибута `type` у `<source>`. */
  readonly type: string;
  /** Варианты этого формата по возрастанию ширины. */
  readonly variants: readonly ImageVariant[];
}

/**
 * Явная группировка вариантов по формату.
 *
 * Именно ЯВНАЯ: порядок строк в зеркале сегодня «группами по формату, внутри по
 * возрастанию ширины», но это свойство источника, а не контракт разметки.
 * Опираться на позицию значило бы получить перемешанные `<source>` от одной
 * перегенерации.
 *
 * Пустых групп на выходе нет: формат, которого в наборе не оказалось, просто не
 * появляется — и `<source>` с пустым `srcset` тоже.
 *
 * @throws Error если формат вне набора вывода пайплайна или не совпадает с
 *   расширением ключа.
 */
export function groupVariantsByFormat(
  variants: readonly ImageVariant[],
): readonly VariantGroup[] {
  const buckets = new Map<ImageFormat, ImageVariant[]>();

  for (const variant of variants) {
    if (!FORMAT_PREFERENCE.includes(variant.format)) {
      throw new Error(
        `Формат «${String(variant.format)}» не входит в набор вывода пайплайна ` +
          `(${FORMAT_PREFERENCE.join(', ')}). Порядок источников в разметке задан для ` +
          'известных форматов; молча пропустить неизвестный нельзя — он исчез бы из ' +
          'разметки незаметно. Добавьте формат в порядок предпочтения осознанно.',
      );
    }
    assertFormatMatchesKey(variant);

    const bucket = buckets.get(variant.format);
    if (bucket === undefined) {
      buckets.set(variant.format, [variant]);
    } else {
      bucket.push(variant);
    }
  }

  return FORMAT_PREFERENCE.flatMap((format) => {
    const bucket = buckets.get(format);
    if (bucket === undefined) {
      return [];
    }
    return [{ format, type: mimeType(format), variants: [...bucket].sort(byWidthAscending) }];
  });
}

/**
 * Строка `srcset` для одного формата: `<путь> <ширина>w`, по возрастанию ширины.
 *
 * Дескриптор `w` — это `variant.width`, фактическая ширина готового файла.
 * Запрошенная пайплайном ширина (`targetWidth`) для этого не годится и в зеркало
 * не переносится вовсе: на пропорциях, не делящихся нацело, она расходится с
 * фактической, и браузер выбирал бы кандидата по числу, которого в файле нет.
 *
 * @throws Error если набор пуст, если в нём смешаны форматы или если две
 *   производные заявляют одну ширину (браузеру нечем выбрать между ними).
 */
export function buildSrcset(variants: readonly ImageVariant[]): string {
  if (variants.length === 0) {
    throw new Error(
      'srcset без источников: набор вариантов пуст. Пустой srcset — это атрибут, из ' +
        'которого браузеру нечего выбрать; при пустом наборе разметка изображения не ' +
        'выводится вовсе (см. buildPictureModel).',
    );
  }

  const format = variants[0]?.format;
  const widths = new Set<number>();

  return [...variants]
    .sort(byWidthAscending)
    .map((variant) => {
      if (variant.format !== format) {
        throw new Error(
          `В одной строке srcset смешаны форматы (${String(format)} и ${variant.format}). ` +
            'Каждый формат живёт в своём <source>: смешанный набор заставил бы браузер ' +
            'выбирать между форматами по ширине, а не по поддержке.',
        );
      }
      if (widths.has(variant.width)) {
        throw new Error(
          `Ширина ${String(variant.width)} встречается в наборе ${variant.format} дважды. ` +
            'Два кандидата одной ширины неразличимы для браузера: выбор между ними ничем ' +
            'не задан. Проверьте зеркало производных карточки.',
        );
      }
      widths.add(variant.width);
      return `${variantPath(variant)} ${String(variant.width)}w`;
    })
    .join(', ');
}

/**
 * Резервный вариант для `<img src>`: самая широкая производная в формате JPEG.
 *
 * Почему самая широкая. `src` читают только клиенты без поддержки `srcset` —
 * остальные его игнорируют. Из этого следует два свойства: во-первых, отсюда же
 * берутся атрибуты `width` и `height`, а у самого крупного файла пропорция
 * задана точнее всего (округление меньше влияет); во-вторых, редкому старому
 * клиенту достанется резкое изображение, а не мыло. Цена — вес файла для этого
 * клиента; она принята осознанно.
 *
 * @throws Error если JPEG в наборе нет: `<img>` остался бы без `src`, то есть
 *   без изображения в HTML-ответе сервера, а это критическая ошибка ТЗ §6.5.
 */
export function pickFallbackVariant(variants: readonly ImageVariant[]): ImageVariant {
  const fallbacks = [...variants]
    .filter((variant) => variant.format === FALLBACK_FORMAT)
    .sort(byWidthAscending);
  const widest = fallbacks.at(-1);

  if (widest === undefined) {
    throw new Error(
      `В наборе производных нет ни одного файла в формате ${FALLBACK_FORMAT}. Резервный ` +
        'JPEG создаётся пайплайном всегда (CLAUDE.md, раздел «Изображения»), поэтому его ' +
        'отсутствие означает повреждённое зеркало. Без него у <img> не было бы src — ' +
        'изображения не было бы в HTML-ответе сервера.',
    );
  }

  return widest;
}

/** Атрибуты одного `<source>`. */
export interface PictureSourceModel {
  readonly type: string;
  readonly srcset: string;
  readonly sizes: string;
}

/**
 * Атрибуты `<img>`.
 *
 * `loading` и `fetchpriority` — ВЗАИМОИСКЛЮЧАЮЩИЕ и опциональные: у первого
 * крупного изображения ключа `loading` в объекте нет вовсе (Astro не печатает
 * атрибут со значением `undefined`), у остальных нет `fetchpriority`.
 * `loading="eager"` не используется: это значение по умолчанию, и явно писать
 * его значит добавить атрибут, который ничего не меняет.
 */
export interface PictureImgModel {
  readonly src: string;
  readonly srcset: string;
  readonly sizes: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly loading?: 'lazy';
  readonly fetchpriority?: 'high';
}

export interface PictureModel {
  /** `<source>` в порядке предпочтения; резервный формат сюда не попадает. */
  readonly sources: readonly PictureSourceModel[];
  readonly img: PictureImgModel;
}

export interface PictureModelInput {
  /** Зеркало `card.derivative.variants[]`. Пустой набор — законное состояние. */
  readonly variants: readonly ImageVariant[];
  readonly alt: ImageAlt;
  readonly layout: ImageLayout;
  /**
   * Это ПЕРВОЕ КРУПНОЕ изображение страницы?
   *
   * Знает только шаблон: компонент не видит ни порядка блоков, ни первого
   * экрана. `true` снимает `loading="lazy"` и добавляет `fetchpriority="high"`
   * (ТЗ §6.5) — на странице такое изображение ровно одно.
   *
   * Тип с явным `| undefined`: при `exactOptionalPropertyTypes` пропущенный проп
   * компонента приходит как `undefined`, и он обязан быть принят здесь, чтобы
   * значение по умолчанию оставалось в ОДНОМ месте — в этой функции. Второй
   * дефолт в компоненте разошёлся бы с этим незаметно.
   */
  readonly priority?: boolean | undefined;
}

/**
 * Полная модель разметки изображения либо `null`.
 *
 * `null` означает «производных нет»: у карточки без загруженного изображения или
 * до первой обработки пайплайном. Тогда `<picture>` не выводится ВОВСЕ — ни с
 * пустым `srcset`, ни с заглушкой. Пустой `srcset` был бы разметкой, из которой
 * браузеру нечего выбрать, а заглушка — картинкой, которой нет в записи.
 *
 * @throws Error при повреждённом зеркале: неизвестный формат, расхождение
 *   формата с расширением, отсутствие резервного JPEG, две производные одной
 *   ширины. Все четыре случая невозможны при исправном пайплайне, и молчаливая
 *   деградация тут хуже отказа: страница выглядела бы исправной.
 */
export function buildPictureModel(input: PictureModelInput): PictureModel | null {
  if (input.variants.length === 0) {
    return null;
  }

  // Группировка идёт первой: она проверяет ВСЕ варианты, включая резервные.
  const groups = groupVariantsByFormat(input.variants);
  const fallback = pickFallbackVariant(input.variants);
  const sizes = IMAGE_LAYOUT_SIZES[input.layout];
  const priority = input.priority ?? false;

  const sources = groups
    .filter((group) => group.format !== FALLBACK_FORMAT)
    .map((group) => ({ type: group.type, srcset: buildSrcset(group.variants), sizes }));

  const fallbackVariants = input.variants.filter((variant) => variant.format === FALLBACK_FORMAT);

  return {
    sources,
    img: {
      src: variantPath(fallback),
      srcset: buildSrcset(fallbackVariants),
      sizes,
      width: fallback.width,
      height: fallback.height,
      alt: altText(input.alt),
      ...(priority ? { fetchpriority: 'high' as const } : { loading: 'lazy' as const }),
    },
  };
}
