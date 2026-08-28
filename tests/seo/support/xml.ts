/**
 * Разбор ответа как XML — НАСТОЯЩИМ парсером, а не регулярным выражением.
 *
 * Здесь единственное место приёмки, где браузер нужен не ради видимости
 * контента, и причина одна: требование п. 22 звучит как «валидный XML», а
 * проверить это можно только тем, что XML действительно разбирает.
 *
 * ## Почему не регулярные выражения, как в `./html.ts`
 *
 * У HTML и XML разная цена ошибки разбора. HTML браузер чинит: незакрытый тег,
 * лишний `&`, перепутанная вложенность — документ всё равно отобразится, поэтому
 * в `./html.ts` разбор намеренно узкий и смотрит ровно на нужный тег. XML не
 * чинит НИКТО: поисковая система, получив дефектный документ, отвергает файл
 * карты сайта целиком. Значит, проверка «валидный XML» обязана быть проверкой
 * ВСЕГО документа — вложенности, единственного корня, экранирования `&` и `<` в
 * тексте, закрытых тегов. Регулярное выражение, вытаскивающее `<loc>…</loc>`, из
 * документа с оборванным `</urlset>` достанет ровно те же адреса, и spec
 * останется зелёным на файле, который Яндекс и Google не примут.
 *
 * ## Почему браузер, а не библиотека
 *
 * В Node встроенного XML-парсера нет, а в зависимостях монорепозитория нет ни
 * одного стороннего (замерено 2026-08-28: `node_modules` и `node_modules/.pnpm`
 * пусты на `xml`, `jsdom`, `linkedom`). Оставались два выхода:
 *
 *   1. написать свой разбор well-formedness здесь. Отклонено: собственный
 *      парсер приёмки принимал бы ровно то, что автор парсера сумел
 *      предусмотреть, и «валидный XML» означало бы «прошёл мой парсер». Это
 *      худший вид ложного зелёного — он выглядит как строгая проверка;
 *   2. взять парсер, который в проекте уже есть. Chromium, которым приёмка
 *      проверяет видимость контента без JS, содержит за `DOMParser` строгий
 *      разбор `application/xml`: любой дефект даёт документ с элементом
 *      `parsererror`. Выбрано это — новой зависимости не появляется, браузер уже
 *      установлен ради `server-rendered-without-js.spec.ts`.
 *
 * Плата — запуск браузера в specs карты сайта, поэтому они поднимают свой бюджет
 * времени, как это уже сделано в `server-rendered-without-js.spec.ts`.
 *
 * ## Почему типы DOM объявлены здесь, а не взяты из `lib.dom`
 *
 * Проект тестов собирается с `lib: ["ES2023"]` (`tsconfig.base.json`) — DOM в нём
 * нет намеренно: это код для Node, и глобальные `document`, `window`, `fetch`
 * браузера в юнит-тестах не должны даже подсказываться. Добавить `DOM` в `lib`
 * ради одного модуля значило бы открыть их всему проекту `tests/`. Поэтому ниже
 * объявлена ровно та поверхность DOM, которой пользуется код внутри
 * `page.evaluate`, — она живёт в этом файле и никуда не протекает.
 *
 * ## Что этот модуль НЕ делает
 *
 * Не проверяет документ по XSD-схеме sitemaps.org. Схема добавила бы в приёмку
 * загрузку XSD по сети, а те её требования, которые для нас содержательны
 * (корень, пространство имён, обязательный `<loc>`, обязательный `<image:loc>`),
 * утверждаются specs явно и называют нарушение по имени. «Документ не прошёл
 * схему» такого имени не называет.
 */

import type { Browser } from '@playwright/test';

/** Пространство имён карты сайта (sitemaps.org 0.9). */
export const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

/** Пространство имён image sitemap (Google, sitemap-image/1.1). */
export const SITEMAP_IMAGE_NAMESPACE = 'http://www.google.com/schemas/sitemap-image/1.1';

/** Запись `<url>` обычного или image `urlset`. */
export interface SitemapUrlEntry {
  /** Текст `<loc>`; `null` — элемента нет вовсе (это нарушение, и оно называется). */
  readonly loc: string | null;
  /** Тексты всех `<image:loc>` записи. */
  readonly imageLocs: readonly string[];
  /** Тексты всех `<lastmod>` записи. */
  readonly lastmods: readonly string[];
}

/** Запись `<sitemap>` индекса. */
export interface SitemapIndexEntry {
  readonly loc: string | null;
}

/** Результат разбора одного документа карты сайта. */
export interface ParsedSitemapXml {
  /**
   * Сообщение парсера, если документ невалиден, иначе `null`.
   *
   * Именно сообщение, а не флаг: падение spec'а обязано называть, ЧТО не так с
   * документом, — иначе владелец слоя получает «XML невалиден» и ищет причину
   * глазами.
   */
  readonly parseError: string | null;
  /** Локальное имя корня: `sitemapindex` или `urlset`. */
  readonly rootLocalName: string | null;
  /** Пространство имён корня. */
  readonly rootNamespace: string | null;
  /**
   * Пространства имён, ОБЪЯВЛЕННЫЕ на корне: префикс (пустая строка — по
   * умолчанию) → URI. Нужны для требования «image sitemap объявляет
   * `sitemap-image/1.1`»: наличие элементов в этом пространстве проверяется
   * отдельно, а объявление — то, что читает валидатор поисковой системы.
   */
  readonly rootNamespaceDeclarations: Readonly<Record<string, string>>;
  /** Записи `<sitemap>` — непусто только у индекса. */
  readonly sitemapEntries: readonly SitemapIndexEntry[];
  /** Записи `<url>` — непусто только у `urlset`. */
  readonly urlEntries: readonly SitemapUrlEntry[];
}

/**
 * Поверхность DOM, которой пользуется код внутри `page.evaluate`.
 *
 * Объявлена локально (причина — в шапке модуля) и намеренно узко: чем меньше
 * здесь методов, тем меньше соблазна написать в браузерном контексте логику,
 * которой место в spec'е.
 */
interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

interface XmlElement {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly textContent: string | null;
  readonly attributes: ArrayLike<XmlAttribute>;
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<XmlElement>;
}

interface XmlDocument {
  readonly documentElement: XmlElement;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

interface DomParserLike {
  parseFromString(source: string, type: string): XmlDocument;
}

interface BrowserGlobals {
  readonly DOMParser: new () => DomParserLike;
}

/** Разборщик, держащий открытую страницу браузера. */
export interface XmlParser {
  parse(xml: string): Promise<ParsedSitemapXml>;
  close(): Promise<void>;
}

/**
 * Поднимает страницу браузера и возвращает разборщик.
 *
 * Контекст открывает `about:blank` и со страницами сайта не соприкасается: он
 * разбирает переданный текст, а не ходит по сайту. Тексты ответов приёмка
 * по-прежнему получает запросом без переходов (`./http.ts`).
 */
export async function createXmlParser(browser: Browser): Promise<XmlParser> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');

  return {
    async close(): Promise<void> {
      await context.close();
    },

    async parse(xml: string): Promise<ParsedSitemapXml> {
      return page.evaluate(
        ({ source, sitemapNs, imageNs }): ParsedSitemapXml => {
          const parser = new (globalThis as unknown as BrowserGlobals).DOMParser();
          const doc = parser.parseFromString(source, 'application/xml');

          const errors = Array.from(doc.getElementsByTagName('parsererror'));
          if (errors.length > 0) {
            return {
              parseError: (errors[0]?.textContent ?? 'парсер не сообщил подробностей')
                .replace(/\s+/gu, ' ')
                .trim(),
              rootLocalName: null,
              rootNamespace: null,
              rootNamespaceDeclarations: {},
              sitemapEntries: [],
              urlEntries: [],
            };
          }

          const root = doc.documentElement;

          const declarations: Record<string, string> = {};
          for (const attribute of Array.from(root.attributes)) {
            if (attribute.name === 'xmlns') {
              declarations[''] = attribute.value;
            } else if (attribute.name.startsWith('xmlns:')) {
              declarations[attribute.name.slice('xmlns:'.length)] = attribute.value;
            }
          }

          const textsOf = (element: XmlElement, ns: string, name: string): string[] =>
            Array.from(element.getElementsByTagNameNS(ns, name)).map((node) =>
              (node.textContent ?? '').trim(),
            );

          const urlEntries = Array.from(root.getElementsByTagNameNS(sitemapNs, 'url')).map(
            (element) => ({
              imageLocs: textsOf(element, imageNs, 'loc'),
              lastmods: textsOf(element, sitemapNs, 'lastmod'),
              loc: textsOf(element, sitemapNs, 'loc')[0] ?? null,
            }),
          );

          const sitemapEntries = Array.from(
            root.getElementsByTagNameNS(sitemapNs, 'sitemap'),
          ).map((element) => ({ loc: textsOf(element, sitemapNs, 'loc')[0] ?? null }));

          return {
            parseError: null,
            rootLocalName: root.localName,
            rootNamespace: root.namespaceURI,
            rootNamespaceDeclarations: declarations,
            sitemapEntries,
            urlEntries,
          };
        },
        { imageNs: SITEMAP_IMAGE_NAMESPACE, sitemapNs: SITEMAP_NAMESPACE, source: xml },
      );
    },
  };
}
