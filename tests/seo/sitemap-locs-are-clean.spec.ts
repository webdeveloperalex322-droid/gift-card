/**
 * Требование (`CLAUDE.md`, «Sitemap и robots»: «Редиректы, 404, noindex,
 * параметры — исключаются»; «Правила индексации»: пагинация вне sitemap, решения
 * Ч-01b/Ч-05): ни один `<loc>` карты сайта не содержит строки запроса,
 * фрагмента и сегмента пагинации.
 *
 * ## Почему форма адреса — отдельное требование от состава карты
 *
 * Соседний spec (`sitemap-entries-are-indexable.spec.ts`) спрашивает у сервера,
 * что отвечает адрес. Здесь не спрашивается ничего: утверждение о САМОЙ СТРОКЕ,
 * и это принципиально. Адрес `/podborki/prazdniki/8-marta?format=vertical`
 * отвечает 200 и может даже нести self-canonical — то есть проверку состава он
 * пройдёт, а в карте ему быть нельзя: параметр не адрес, а представление
 * (ТЗ §6.5). То же с `/page/2`: страница отвечает 200 и законно существует, но
 * директива у неё `noindex,follow` (Ч-01b), и в карте она означала бы
 * приглашение индексировать пагинацию.
 *
 * Фрагмент (`#`) в карте не значит вообще ничего: поисковая система его
 * отбрасывает, а два `<loc>`, различающиеся только фрагментом, — это дубль.
 *
 * Проверяются адреса ОБОИХ уровней: и `<loc>` файлов в индексе, и `<loc>`
 * страниц в `urlset`. Параметр в адресе файла карты встречается не реже — он
 * приезжает туда, когда адрес собирают не хелпером, а конкатенацией.
 */

import { expect, test } from '@playwright/test';

import {
  annotateEmptyRun,
  indexLocs,
  pageLocs,
  readSitemapTree,
} from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();

test.describe.configure({ timeout: 180_000 });

/**
 * Запрещённые формы. Каждая — с причиной, потому что падение обязано объяснять,
 * а не только называть символ.
 */
const FORBIDDEN: readonly {
  readonly matches: (loc: string) => boolean;
  readonly reason: string;
}[] = [
  {
    matches: (loc) => loc.includes('?'),
    reason:
      'строка запроса: адрес с параметрами задаёт ПРЕДСТАВЛЕНИЕ, а не страницу (ТЗ §6.5), ' +
      'своего canonical у него нет, и в карте он приглашает краулера обходить пространство ' +
      'параметров',
  },
  {
    matches: (loc) => loc.includes('#'),
    reason:
      'фрагмент: поисковая система его отбрасывает, поэтому два <loc>, различающиеся только ' +
      'фрагментом, — это один адрес, записанный дважды',
  },
  {
    matches: (loc) => /\/page\/[^/]*$/u.test(loc) || loc.includes('/page/'),
    reason:
      'сегмент пагинации: страницы 2+ получают noindex,follow (решения Ч-01b и Ч-05) и в карту ' +
      'не входят. Их присутствие здесь означает, что отбор идёт не по директиве',
  },
];

function violationsIn(label: string, locs: readonly string[]): string[] {
  return locs.flatMap((loc) =>
    FORBIDDEN.filter((rule) => rule.matches(loc)).map(
      (rule) => `${label}: «${loc}» — ${rule.reason}`,
    ),
  );
}

test('ни один <loc> карты сайта не содержит параметров, фрагмента и сегмента пагинации', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);

  const index = indexLocs(tree);
  const pages = pageLocs(tree);

  if (index.length === 0 && pages.length === 0) {
    annotateEmptyRun(testInfo, 'Форма адресов в карте сайта НЕ проверена: адресов в ней нет.');
    return;
  }

  const violations = [
    ...violationsIn('<loc> файла в индексе', index),
    ...violationsIn('<loc> страницы в urlset', pages),
  ];

  expect(
    violations,
    `Проверено адресов: ${String(index.length + pages.length)} ` +
      `(файлов в индексе — ${String(index.length)}, страниц — ${String(pages.length)}).`,
  ).toEqual([]);
});
