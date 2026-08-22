/**
 * Сборка итогового пути подборки (задача Э1-05): чистое ядро правил.
 *
 * Проверяется то, что определяет URL: склейка пути из цепочки родителей,
 * отказ по реестру зарезервированных маршрутов, допустимые сочетания «родитель →
 * ребёнок» и невозможность обратного порядка сегментов (решение Ч-04-7).
 *
 * Тесты негативных случаев сверяют МАШИННЫЙ признак отказа (`rule`), а не текст:
 * зелёный негативный тест, держащийся на подстроке сообщения, ломается при
 * первой правке формулировки и, что хуже, может проходить по другой причине.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PARENT_KINDS,
  COLLECTION_NODE_KINDS,
  CollectionNodeError,
  type CollectionNodeParent,
  isDescendantPath,
  planCollectionNode,
} from './collection-path';

const env = { PAYLOAD_ADMIN_PATH: '/admin' } as const;

/** Узел «Праздники»: /podborki/prazdniki. */
const prazdniki: CollectionNodeParent = {
  id: 1,
  nodeKind: 'group',
  path: '/podborki/prazdniki',
};

/** Узел «Адресаты»: /podborki/adresaty. */
const adresaty: CollectionNodeParent = {
  id: 2,
  nodeKind: 'group',
  path: '/podborki/adresaty',
};

/** Праздничная посадочная: /podborki/prazdniki/8-marta. */
const vosmoeMarta: CollectionNodeParent = {
  id: 3,
  nodeKind: 'occasion',
  path: '/podborki/prazdniki/8-marta',
};

/** Адресат под праздником: /podborki/prazdniki/8-marta/mame. */
const mameNa8Marta: CollectionNodeParent = {
  id: 4,
  nodeKind: 'recipient',
  path: '/podborki/prazdniki/8-marta/mame',
};

/** Адресат без праздника: /podborki/adresaty/mame. */
const mame: CollectionNodeParent = {
  id: 5,
  nodeKind: 'recipient',
  path: '/podborki/adresaty/mame',
};

function expectRule(run: () => unknown, rule: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CollectionNodeError);
    expect((error as CollectionNodeError).rule).toBe(rule);
    return;
  }
  throw new Error(`Ожидался отказ по правилу «${rule}», но отказа не было`);
}

describe('форма путей — решение человека от 2026-08-22', () => {
  it('группирующий узел живёт прямо под /podborki', () => {
    const plan = planCollectionNode({
      candidate: { nodeKind: 'group', parent: null, slug: 'prazdniki' },
      env,
    });
    expect(plan.path).toBe('/podborki/prazdniki');
    expect(plan.parentPath).toBeNull();
    expect(plan.depth).toBe(1);
  });

  it('праздничная посадочная — под группирующим узлом', () => {
    const plan = planCollectionNode({
      candidate: { nodeKind: 'occasion', parent: prazdniki, slug: '8-marta' },
      env,
    });
    expect(plan.path).toBe('/podborki/prazdniki/8-marta');
    expect(plan.parentPath).toBe('/podborki/prazdniki');
    expect(plan.depth).toBe(2);
  });

  it('пара «праздник × адресат» — три уровня вложенности', () => {
    const plan = planCollectionNode({
      candidate: { nodeKind: 'recipient', parent: vosmoeMarta, slug: 'mame' },
      env,
    });
    expect(plan.path).toBe('/podborki/prazdniki/8-marta/mame');
    expect(plan.depth).toBe(3);
  });

  it('адресат без праздника — под своим группирующим узлом', () => {
    const plan = planCollectionNode({
      candidate: { nodeKind: 'recipient', parent: adresaty, slug: 'mame' },
      env,
    });
    expect(plan.path).toBe('/podborki/adresaty/mame');
  });

  it('путь собирается из СОХРАНЁННОГО пути родителя, а не из его slug', () => {
    // Практическое следствие: цепочку родителей не надо обходить целиком на
    // каждом сохранении, а глубина вложенности не влияет на число запросов.
    const plan = planCollectionNode({
      candidate: { nodeKind: 'recipient', parent: vosmoeMarta, slug: 'babushke' },
      env,
    });
    expect(plan.path).toBe('/podborki/prazdniki/8-marta/babushke');
  });
});

describe('порядок сегментов: только «повод → уточнение» (Ч-04-7)', () => {
  it('повод под уточнением не создаётся никогда', () => {
    // Обратный порядок — /podborki/adresaty/mame/8-marta. Это не предупреждение
    // и не соглашение: сочетание «родитель recipient → ребёнок occasion»
    // отсутствует в матрице, поэтому запись физически не собирается.
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: mame, slug: '8-marta' },
          env,
        }),
      'forbidden-parent',
    );
  });

  it('повод под поводом не создаётся', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: vosmoeMarta, slug: '9-maya' },
          env,
        }),
      'forbidden-parent',
    );
  });

  it('уточнение под уточнением не создаётся: глубина пары ограничена', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'recipient', parent: mameNa8Marta, slug: 'babushke' },
          env,
        }),
      'forbidden-parent',
    );
  });

  it('группирующий узел не вкладывается ни во что', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'group', parent: prazdniki, slug: 'adresaty' },
          env,
        }),
      'forbidden-parent',
    );
  });

  it('повод и уточнение без родителя не создаются: корень занят группами', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: null, slug: '8-marta' },
          env,
        }),
      'forbidden-parent',
    );
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'recipient', parent: null, slug: 'mame' },
          env,
        }),
      'forbidden-parent',
    );
  });

  it('матрица ограничивает глубину: длиннее пары «повод × уточнение» ничего нет', () => {
    // Отдельного правила «не глубже N» нет намеренно: глубина — следствие
    // матрицы, а второе правило о том же разошлось бы с первым.
    const kinds = COLLECTION_NODE_KINDS;
    const maxDepth = kinds.reduce((depth, kind) => Math.max(depth, longestChain(kind)), 0);
    expect(maxDepth).toBe(3);
  });
});

/** Самая длинная цепочка, которую допускает матрица для узла вида `kind`. */
function longestChain(kind: (typeof COLLECTION_NODE_KINDS)[number]): number {
  const parents = ALLOWED_PARENT_KINDS[kind];
  let longest = 0;
  for (const parent of parents) {
    const length = parent === null ? 1 : 1 + longestChain(parent);
    longest = Math.max(longest, length);
  }
  return longest;
}

describe('стили и настроения (Ч-04-3): вида узла под них нет', () => {
  it('набор видов закрыт и не содержит стиля и настроения', () => {
    // Решение Ч-04-3: стили и настроения — неиндексируемый фильтр без
    // собственных URL. Поэтому в модели подборок им нет ВИДА: URL появляется
    // только у узла коллекции, и отсутствие вида означает отсутствие пути.
    expect([...COLLECTION_NODE_KINDS]).toEqual(['group', 'occasion', 'recipient']);
    expect(COLLECTION_NODE_KINDS).not.toContain('style');
    expect(COLLECTION_NODE_KINDS).not.toContain('mood');
  });

  it('неизвестный вид узла отклоняется, а не трактуется как группа', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'style', parent: null, slug: 'akvarel' },
          env,
        }),
      'unknown-kind',
    );
    expectRule(
      () => planCollectionNode({ candidate: { parent: null, slug: 'akvarel' }, env }),
      'unknown-kind',
    );
  });
});

describe('slug каждого сегмента проходит общий валидатор', () => {
  it('кириллица, верхний регистр, пробел, подчёркивание и слеш отклоняются', () => {
    for (const slug of ['Праздники', 'Prazdniki', 'novyy god', 'novyy_god', 'a/b', '8-marta?utm=1']) {
      expectRule(
        () => planCollectionNode({ candidate: { nodeKind: 'group', parent: null, slug }, env }),
        'invalid-slug',
      );
    }
  });

  it('пустой slug и slug из одних цифр (Ч-27) отклоняются', () => {
    for (const slug of ['', '   ', '2026', undefined]) {
      expectRule(
        () => planCollectionNode({ candidate: { nodeKind: 'group', parent: null, slug }, env }),
        'invalid-slug',
      );
    }
  });
});

describe('итоговый путь проверяется по реестру зарезервированных маршрутов', () => {
  it('сегмент page запрещён на любом уровне: он занят пагинацией', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'group', parent: null, slug: 'page' },
          env,
        }),
      'reserved-path',
    );
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'recipient', parent: vosmoeMarta, slug: 'page' },
          env,
        }),
      'reserved-path',
    );
  });

  it('нестандартный PAYLOAD_ADMIN_PATH внутри /podborki участвует в проверке', () => {
    // Путь админки не записан строкой, а вычисляется из окружения. Настроен
    // внутрь контейнера подборок — совпадающий узел обязан отклоняться, иначе
    // подборка заняла бы адрес админки.
    const nested = { PAYLOAD_ADMIN_PATH: '/podborki/upravlenie' };
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'group', parent: null, slug: 'upravlenie' },
          env: nested,
        }),
      'reserved-path',
    );
    expect(
      planCollectionNode({
        candidate: { nodeKind: 'group', parent: null, slug: 'prazdniki' },
        env: nested,
      }).path,
    ).toBe('/podborki/prazdniki');
  });

  it('незаданный PAYLOAD_ADMIN_PATH даёт отказ по реестру, а не путь без проверки', () => {
    // Реестр без пути админки ответить не может, и «не смогли проверить»
    // обязано означать отказ: иначе запись прошла бы вообще без проверки.
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'group', parent: null, slug: 'prazdniki' },
          env: {},
        }),
      'reserved-path',
    );
  });
});

describe('родитель вне пространства подборок и цикл', () => {
  it('родитель с путём вне /podborki отклоняется', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: {
            nodeKind: 'occasion',
            parent: { id: 9, nodeKind: 'group', path: '/otkrytki/prazdniki' },
            slug: '8-marta',
          },
          env,
        }),
      'parent-outside-container',
    );
  });

  it('родитель без сохранённого пути отклоняется, а не считается корнем', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: {
            nodeKind: 'occasion',
            parent: { id: 9, nodeKind: 'group', path: null },
            slug: '8-marta',
          },
          env,
        }),
      'parent-outside-container',
    );
  });

  it('матрица видов сама делает цикл недостижимым в согласованном дереве', () => {
    // Вид узла по цепочке строго убывает (group → occasion → recipient) и ни
    // один вид не может быть своим же предком, поэтому в дереве, собранном
    // хуками, цикл невозможен. Проверки цикла ниже — защита от правки данных в
    // обход хуков и от будущего расширения матрицы, а не рабочий сценарий.
    for (const kind of COLLECTION_NODE_KINDS) {
      expect(ALLOWED_PARENT_KINDS[kind]).not.toContain(kind);
    }
  });

  it('узел не может быть родителем самому себе', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: {
            id: prazdniki.id,
            nodeKind: 'group',
            parent: prazdniki,
            slug: 'prazdniki',
            currentPath: '/podborki/prazdniki',
          },
          env,
        }),
      'parent-cycle',
    );
  });

  it('узел не может уйти под собственного потомка', () => {
    // /podborki/prazdniki нельзя подчинить /podborki/prazdniki/8-marta:
    // получилось бы поддерево, недостижимое от корня, и бесконечная склейка.
    expectRule(
      () =>
        planCollectionNode({
          candidate: {
            id: prazdniki.id,
            nodeKind: 'group',
            parent: vosmoeMarta,
            slug: 'prazdniki',
            currentPath: '/podborki/prazdniki',
          },
          env,
        }),
      'parent-cycle',
    );
  });
});

describe('уникальность итогового пути', () => {
  it('одинаковый slug под разными родителями даёт РАЗНЫЕ пути', () => {
    // Поэтому slug подборки не может быть уникальным полем: «mame» законно
    // существует и под праздником, и в ветке адресатов.
    const underHoliday = planCollectionNode({
      candidate: { nodeKind: 'recipient', parent: vosmoeMarta, slug: 'mame' },
      env,
    });
    const standalone = planCollectionNode({
      candidate: { nodeKind: 'recipient', parent: adresaty, slug: 'mame' },
      env,
    });
    expect(underHoliday.path).not.toBe(standalone.path);
  });

  it('одинаковый slug под ОДНИМ родителем даёт один и тот же путь', () => {
    // Это и есть коллизия, которую обязан поймать уникальный индекс БД:
    // планировщик её не видит и видеть не может — он чистый и о других записях
    // не знает. Запрос «нет ли такого пути» перед записью не помог бы, потому
    // что два одновременных сохранения через API прошли бы его оба.
    const first = planCollectionNode({
      candidate: { id: 10, nodeKind: 'recipient', parent: vosmoeMarta, slug: 'mame' },
      env,
    });
    const second = planCollectionNode({
      candidate: { id: 11, nodeKind: 'recipient', parent: vosmoeMarta, slug: 'mame' },
      env,
    });
    expect(second.path).toBe(first.path);
  });
});

/**
 * Год в URL ежегодного праздника (условие C3; блокирующая находка ревизии от
 * 2026-08-22: правило не было реализовано НИГДЕ — `slugify('Новый год 2027')`
 * давал `novyy-god-2027`, валидатор его принимал, реестр маршрутов не видел,
 * хук пропускал, а единственным упоминанием запрета был текст подсказки в
 * админке).
 *
 * Норма: `CLAUDE.md` → «Правила URL» → «Год не добавляется в URL ежегодных
 * праздников»; `docs/plan-etapov.md` называет год в URL ежегодного праздника
 * прямым критерием провала вето V1. Slug после первой публикации неизменяем,
 * поэтому ошибка необратима — проверка обязана стоять до записи.
 *
 * Область применения: узел ежегодного праздника (`occasion`) и всё, что живёт
 * ПОД ним (пара «праздник × адресат» — та же ежегодная страница). Группирующий
 * узел и адресат без праздника под правило не попадают: у них нет годовой
 * природы, а расширять запрет на всё подряд значило бы запретить год там, где он
 * может быть осмысленным, без указания человека.
 */
describe('год в URL ежегодного праздника (условие C3)', () => {
  /**
   * Вердикт url-guard от 2026-08-22: правило было закрыто наполовину —
   * проверялся только СВОЙ сегмент узла, поэтому год попадал в адрес двумя
   * путями. Оба теста ниже идут через сборку итогового пути, а не через
   * проверку сегмента.
   */
  it('путь (а): группа с годом отклоняется — её сегмент входит в адрес каждого повода', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'group', parent: null, slug: 'prazdniki-2027' },
          env,
        }),
      'year-in-path',
    );
  });

  it('путь (а): повод с чистым сегментом под годовой группой тоже отклоняется', () => {
    // Собственный сегмент посадочной безупречен (`8-marta`), а её итоговый
    // адрес — /podborki/prazdniki-2027/8-marta. Проверка по сегменту это
    // пропускала, проверка по итоговому пути — нет.
    const yearBearingGroup: CollectionNodeParent = {
      id: 20,
      nodeKind: 'group',
      path: '/podborki/prazdniki-2027',
    };
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: yearBearingGroup, slug: '8-marta' },
          env,
        }),
      'year-in-path',
    );
  });

  it('путь (б): recipient прямо под группой праздников с годом отклоняется', () => {
    // Матрица допускает recipient под группой, поэтому
    // /podborki/prazdniki/novyy-god-2027 собирался без отказа: вид узла
    // recipient, родитель — группа. Отделить его от адресата в ветви
    // «Адресаты» машинно нечем (формы одинаковые), поэтому год запрещён во всей
    // коллекции.
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'recipient', parent: prazdniki, slug: 'novyy-god-2027' },
          env,
        }),
      'year-in-path',
    );
  });

  it('адресат без праздника остаётся законным: правило запрещает год, а не цифры', () => {
    // Явная регрессия из вердикта: /podborki/adresaty/mame собирается как
    // раньше — расширение запрета на эту ветвь «за компанию» было бы
    // додумыванием за человека.
    expect(
      planCollectionNode({
        candidate: { nodeKind: 'recipient', parent: adresaty, slug: 'mame' },
        env,
      }).path,
    ).toBe('/podborki/adresaty/mame');
  });

  it('цифры в адресе не годы: 8-marta, 23-fevralya, 1-sentyabrya, otkrytka-1920x1080', () => {
    for (const slug of ['8-marta', '23-fevralya', '1-sentyabrya', 'otkrytka-1920x1080']) {
      expect(
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: prazdniki, slug },
          env,
        }).path,
        slug,
      ).toBe(`/podborki/prazdniki/${slug}`);
      // И у группы — тот же набор: правило одно на все виды узлов.
      expect(
        planCollectionNode({ candidate: { nodeKind: 'group', parent: null, slug }, env }).path,
        slug,
      ).toBe(`/podborki/${slug}`);
    }
  });

  it('повод с годом отклоняется', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: prazdniki, slug: 'novyy-god-2027' },
          env,
        }),
      'year-in-path',
    );
  });

  it('пара под праздником с годом отклоняется тоже: это та же ежегодная страница', () => {
    expectRule(
      () =>
        planCollectionNode({
          candidate: { nodeKind: 'recipient', parent: vosmoeMarta, slug: 'mame-2027' },
          env,
        }),
      'year-in-path',
    );
  });

  it('даты праздников годом не считаются: 8-marta, 23-fevralya, 1-sentyabrya', () => {
    for (const slug of ['8-marta', '23-fevralya', '1-sentyabrya', '9-maya', 'novyy-god']) {
      expect(
        planCollectionNode({
          candidate: { nodeKind: 'occasion', parent: prazdniki, slug },
          env,
        }).slug,
        slug,
      ).toBe(slug);
    }
  });

  it('отказ называет год и объясняет, почему он необратим', () => {
    try {
      planCollectionNode({
        candidate: { nodeKind: 'occasion', parent: prazdniki, slug: 'novyy-god-2027' },
        env,
      });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionNodeError);
      expect((error as CollectionNodeError).message).toContain('2027');
    }
  });
});

describe('isDescendantPath', () => {
  it('потомок определяется по границе сегмента, а не по подстроке', () => {
    expect(isDescendantPath('/podborki/prazdniki', '/podborki/prazdniki/8-marta')).toBe(true);
    expect(isDescendantPath('/podborki/prazdniki', '/podborki/prazdniki-2026')).toBe(false);
    expect(isDescendantPath('/podborki/prazdniki', '/podborki/prazdniki')).toBe(false);
    expect(isDescendantPath('/podborki/prazdniki', '/podborki/adresaty/mame')).toBe(false);
  });
});
