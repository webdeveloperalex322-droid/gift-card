import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLUG_MAX_LENGTH,
  isValidSlug,
  SLUG_PATTERN,
  slugify,
} from '@otkritka/shared';

/**
 * Задача Э1-01a: транслитерация заголовка в slug и валидатор slug.
 *
 * Правила берутся из `CLAUDE.md`, раздел «Правила URL — нарушать запрещено»:
 * нижний регистр, транслитерация, дефисы между словами; без кириллицы,
 * пробелов, подчёркиваний, параметров; slug не зависит от ID, даты публикации
 * и позиции в меню.
 *
 * Тест — норма, черновик `docs/etap-0-struktura-url.md` — предложение. Расхождения
 * (`s-cvetami`, `pasha`, `svetloe-hristovo-voskresenie`) устранены правкой
 * черновика под таблицу, а не правкой таблицы под черновик; список ниже держит
 * их синхронными и обязан краснеть, если черновик разъедется с таблицей снова.
 *
 * Литера, не давшая ни одного допустимого символа (кириллица вне русского
 * алфавита, азербайджанская, армянская, грузинская, греческая — вопрос Ч-25),
 * обязана давать явный отказ: пустую строку, а не правдоподобный slug вида
 * `ki-v`, `otkrytki-nv-r` или `otkrytki`. Критерий — результат, не письменность.
 */

describe('slugify: транслитерация кириллицы', () => {
  it('переводит заголовок в нижний регистр и ставит дефисы между словами', () => {
    expect(slugify('Открытки С Днём Рождения')).toBe('otkrytki-s-dnem-rozhdeniya');
  });

  it('передаёт согласные-диграфы: ж, ч, ш, щ, х, ц', () => {
    expect(slugify('Жёлудь')).toBe('zhelud'); // ж→zh, ё→e, ь→''
    expect(slugify('Чашка')).toBe('chashka');
    expect(slugify('Щука')).toBe('shchuka');
    expect(slugify('Хлеб')).toBe('khleb');
    expect(slugify('Цветы')).toBe('tsvety');
  });

  it('передаёт «ый» как yy — сумма ы→y и й→y, без спецправила на окончание', () => {
    expect(slugify('Новый год')).toBe('novyy-god');
    expect(slugify('Красивые')).toBe('krasivye');
    expect(slugify('Выпускной')).toBe('vypusknoy');
  });

  it('выбрасывает мягкий и твёрдый знак', () => {
    expect(slugify('Свадьба')).toBe('svadba');
    expect(slugify('День матери')).toBe('den-materi');
    expect(slugify('Подъезд')).toBe('podezd');
  });

  it('передаёт ё как e — заголовок с «е» вместо «ё» даёт тот же slug', () => {
    expect(slugify('Ёлка')).toBe('elka');
    expect(slugify('Елка')).toBe(slugify('Ёлка'));
    expect(slugify('С Днём учителя')).toBe(slugify('С Днем учителя'));
  });

  it('передаёт я, ю, э', () => {
    expect(slugify('23 Февраля')).toBe('23-fevralya');
    expect(slugify('Учителю')).toBe('uchitelyu');
    expect(slugify('Экран')).toBe('ekran');
  });

  it('передаёт щ как shch и ц как ts во всех позициях', () => {
    expect(slugify('Годовщина свадьбы')).toBe('godovshchina-svadby');
    expect(slugify('Женщине')).toBe('zhenshchine');
    expect(slugify('Масленица')).toBe('maslenitsa');
    expect(slugify('Официальные')).toBe('ofitsialnye');
    expect(slugify('С цветами')).toBe('s-tsvetami');
  });

  it('передаёт х как kh, чтобы «сх» не сливалось с «ш»', () => {
    expect(slugify('Пасха')).toBe('paskha');
    expect(slugify('Паша')).toBe('pasha');
    expect(slugify('Пасха')).not.toBe(slugify('Паша'));
  });

  it('схлопывает пробелы, подчёркивания и пунктуацию в один дефис', () => {
    expect(slugify('Открытки   мужчине')).toBe('otkrytki-muzhchine');
    expect(slugify('открытки_мужчине')).toBe('otkrytki-muzhchine');
    expect(slugify('Открытки — мужчине!')).toBe('otkrytki-muzhchine');
    expect(slugify('Открытки?мужчине&формат=a4')).toBe('otkrytki-muzhchine-format-a4');
  });

  it('не оставляет ведущих и хвостовых дефисов', () => {
    expect(slugify('  — Открытки маме — ')).toBe('otkrytki-mame');
    expect(slugify('...Пасха...')).toBe('paskha');
  });

  it('сохраняет цифры и латиницу как есть', () => {
    expect(slugify('8 Марта')).toBe('8-marta');
    expect(slugify('1 Сентября')).toBe('1-sentyabrya');
    expect(slugify('otkrytka-a4')).toBe('otkrytka-a4');
  });

  it('снимает диакритику с латиницы вместо превращения её в дефис', () => {
    expect(slugify('Café Déjà')).toBe('cafe-deja');
  });

  it('фиксирует расхождение с образцом имени файла из CLAUDE.md (Ч-24)', () => {
    // CLAUDE.md приводит `otkrytka-mame-na-8-marta-s-tulpanami.webp`, но `ю`→`yu`
    // по таблице даёт `tyulpanami`. Спецправила под образец нет: исключение из
    // таблицы ради одного примера рассинхронизировало бы slug и имена файлов.
    // Выбор написания — за человеком (Ч-24).
    expect(slugify('Открытка маме на 8 марта с тюльпанами')).toBe(
      'otkrytka-mame-na-8-marta-s-tyulpanami',
    );
  });
});

describe('slugify: идемпотентность', () => {
  const samples = [
    'Открытки С Днём Рождения',
    '8 Марта маме',
    'Годовщина свадьбы — 25 лет!',
    'otkrytka-a4',
    'С цветами',
    '  — Пасха — ',
    'Очень   длинный   заголовок   про   открытки   с   днём   рождения   маме   и   бабушке',
  ];

  for (const sample of samples) {
    it(`slugify(slugify(x)) === slugify(x) для «${sample}»`, () => {
      const once = slugify(sample);
      expect(slugify(once)).toBe(once);
    });
  }

  it('идемпотентен и при нестандартной максимальной длине', () => {
    const once = slugify('Открытки с днём рождения маме и бабушке', { maxLength: 20 });
    expect(slugify(once, { maxLength: 20 })).toBe(once);
  });
});

describe('slugify: детерминизм и независимость от ID/даты/позиции', () => {
  it('повторный вызов даёт тот же результат', () => {
    const first = slugify('Открытки с Днём Победы');
    const second = slugify('Открытки с Днём Победы');
    const third = slugify('Открытки с Днём Победы');
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('игнорирует посторонние поля в опциях — их нельзя протащить в slug', () => {
    const withJunk = slugify('Новый год', {
      id: 42,
      publishedAt: '2026-08-20',
      position: 3,
    } as unknown as { maxLength?: number });
    expect(withJunk).toBe(slugify('Новый год'));
  });

  it('не добавляет в slug ни цифр, ни дат, если их нет в заголовке', () => {
    expect(slugify('Открытки маме')).toBe('otkrytki-mame');
    expect(slugify('Открытки маме')).not.toMatch(/\d/);
  });
});

describe('slugify: литера без допустимых символов — отказ целиком (Ч-25)', () => {
  // Правдоподобный неверный slug опаснее явного отказа: география проекта —
  // Россия и СНГ, slug заполняет сервисный аккаунт `ai-editor`, а после первой
  // публикации URL исправляется только редиректом.
  const rejectedTitles: ReadonlyArray<readonly [string, string]> = [
    ['украинский: Київ (был бы «ki-v»)', 'Київ'],
    ['казахский: Гүлдер (был бы «g-lder»)', 'Гүлдер'],
    ['белорусский: Открытка ў садзе (была бы «otkrytka-sadze»)', 'Открытка ў садзе'],
    ['одна литера і', 'і'],
    ['одна литера ї', 'ї'],
    ['одна литера є', 'є'],
    ['одна литера ґ', 'ґ'],
    ['одна литера ә', 'ә'],
    ['одна литера ў', 'ў'],
    ['одна литера ү', 'ү'],
    ['верхний регистр Ї', 'Ї'],
    ['смешанный вход: русский + одна украинская литера', 'Открытки для Наталії'],
    ['смешанный вход: латиница + кириллица вне таблицы', 'Kyiv Київ'],
    ['литера в конце слова', 'Открытка мамі'],
    ['литера в начале строки', 'Ґанок открытки'],
    // Азербайджан, Армения, Грузия — та же география проекта (ТЗ §16).
    ['азербайджанский: Bakı (был бы «bak»)', 'Bakı'],
    ['азербайджанский: Ənvər açıq (был бы «nv-r-ac-q»)', 'Ənvər açıq'],
    ['смешанный: открытки Ənvər (был бы «otkrytki-nv-r»)', 'открытки Ənvər'],
    ['армянский: Բարև открытки (был бы «otkrytki»)', 'Բարև открытки'],
    ['грузинский: გილოცავ открытки (был бы «otkrytki»)', 'გილოცავ открытки'],
    ['греческий: Καλά открытки (был бы «otkrytki»)', 'Καλά открытки'],
    ['одна литера ı', 'ı'],
    ['одна литера ə', 'ə'],
  ];

  for (const [label, title] of rejectedTitles) {
    it(`отказывает пустой строкой: ${label}`, () => {
      expect(slugify(title)).toBe('');
      expect(isValidSlug(slugify(title))).toBe(false);
    });
  }

  it('не возвращает частичный slug: одна литера вне таблицы отменяет весь результат', () => {
    // Русский вариант того же заголовка slug даёт — значит отказ вызван именно
    // литерой, а не тем, что транслитерировать было нечего.
    expect(slugify('Открытки для Натали')).toBe('otkrytki-dlya-natali');
    expect(slugify('Открытки для Наталії')).toBe('');
  });

  it('смешанный вход не даёт частичного slug ни при какой письменности', () => {
    // Опасность именно в частичном результате: русская часть транслитерируется,
    // чужая литера пропадает, и slug выглядит правдоподобно.
    for (const mixed of [
      'открытки Ənvər',
      'Բարև открытки',
      'გილოცავ открытки',
      'Καλά открытки',
      'Открытки Bakı',
      'Kyiv Київ',
    ]) {
      expect(slugify(mixed), mixed).toBe('');
      expect(isValidSlug(slugify(mixed)), mixed).toBe(false);
    }
  });

  it('одиночная комбинирующая метка отбрасывается, а не становится дефисом', () => {
    // `İ` U+0130 после toLowerCase распадается на `i` + U+0307, и составной
    // строчной формы у него нет — NFC не собирает её обратно. Выбрано отбрасывание
    // метки: базовая литера `i` допустимый символ дала, слово остаётся целым и
    // верным (`İki` по-турецки и по-азербайджански читается «iki»), а отказ был бы
    // непоследователен рядом с `Café` → `cafe`. Чего быть НЕ должно —
    // `i-stanbul-otkrytki`: правдоподобный и необратимый после публикации slug.
    expect(slugify('İstanbul otkrytki')).toBe('istanbul-otkrytki');
    expect(slugify('İki')).toBe('iki');
    // Прямой вход из кодовых точек: тест не зависит от того, как редактор
    // сохранил файл и нормализовал ли он строку.
    expect(slugify('i\u0307stanbul otkrytki')).toBe('istanbul-otkrytki');
    expect(slugify('i\u0307ki')).toBe('iki');
    expect(slugify('\u0307')).toBe('');
  });

  it('знак ударения в русском тексте не разрывает слово', () => {
    // «поздравления» со знаком ударения: у `о` + U+0301 составной формы нет, метка отбрасывается.
    expect(slugify('по\u0301здравления')).toBe('pozdravleniya');
    expect(slugify('откры\u0301тки маме')).toBe('otkrytki-mame');
  });

  it('апострофы и кавычки дают слитное слово: ни отказа, ни дефиса', () => {
    // От порядка «DROPPED_CHARS раньше проверки на литеру» зависит, что `ʼ`
    // U+02BC — формально \p{Lm}, то есть литера — не роняет всю строку.
    expect(slugify('oʼbrien otkrytki')).toBe('obrien-otkrytki');
    expect(slugify("O'Brien")).toBe('obrien');
    expect(slugify('O’Хара')).toBe('okhara'); // O’Хара
    expect(slugify('don’t')).toBe('dont');
    expect(slugify('«Открытки» "маме"')).toBe('otkrytki-mame');
    expect(slugify('“Открытки” маме')).toBe('otkrytki-mame');
    // Ни один из входов выше не должен быть отказом.
    for (const value of ['oʼbrien', "O'Brien", 'don’t', '«Открытки»']) {
      expect(slugify(value), value).not.toBe('');
      expect(isValidSlug(slugify(value)), value).toBe(true);
    }
  });

  it('регрессия: латиница с диакритикой теряет диакритику, а не отказывает', () => {
    // Отказ только когда литера не дала НИЧЕГО. `é`, `à`, `ç` дают символ.
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('Café Déjà')).toBe('cafe-deja');
    expect(slugify('Garçon')).toBe('garcon');
  });

  it('регрессия: цифры, дефисы и пробелы поведение не меняют', () => {
    expect(slugify('8 Марта 2027')).toBe('8-marta-2027');
    expect(slugify('otkrytka - a4')).toBe('otkrytka-a4');
  });

  it('регрессия: полный русский алфавит транслитерируется без отказа', () => {
    expect(slugify('абвгдеёжзийклмнопрстуфхцчшщъыьэюя')).toBe(
      'abvgdeezhziyklmnoprstufkhtschshshchyeyuya',
    );
    expect(slugify('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')).toBe(
      slugify('абвгдеёжзийклмнопрстуфхцчшщъыьэюя'),
    );
  });

  it('регрессия: Пасха и Паша остаются разными slug', () => {
    expect(slugify('Пасха')).toBe('paskha');
    expect(slugify('Паша')).toBe('pasha');
    expect(slugify('Пасха')).not.toBe(slugify('Паша'));
  });

  it('русский алфавит отказом не задевается', () => {
    expect(slugify('Ёлка и щенок под ёлкой')).toBe('elka-i-shchenok-pod-elkoy');
    expect(slugify('Съезд подъезд объявление')).toBe('sezd-podezd-obyavlenie');
  });
});

describe('isValidSlug: негативные случаи', () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['кириллица', 'открытки'],
    ['кириллица внутри латиницы', 'otkrytki-маме'],
    ['пробел', 'otkrytki mame'],
    ['подчёркивание', 'otkrytki_mame'],
    ['верхний регистр', 'Otkrytki-Mame'],
    ['знак вопроса', 'otkrytki?mame'],
    ['амперсанд', 'otkrytki&mame'],
    ['равно', 'format=a4'],
    ['параметр запроса', 'otkrytki-mame?sort=new'],
    ['ведущий дефис', '-otkrytki'],
    ['хвостовой дефис', 'otkrytki-'],
    ['двойной дефис', 'otkrytki--mame'],
    ['пустая строка', ''],
    ['только дефис', '-'],
    ['слеш внутри', 'podborki/8-marta'],
    ['ведущий слеш', '/otkrytki'],
    ['хвостовой слеш', 'otkrytki/'],
    ['точка (расширение файла)', 'sitemap.xml'],
    ['пробел по краям', ' otkrytki '],
    ['процент-кодирование', 'otkrytki%20mame'],
    ['решётка', 'otkrytki#mame'],
  ];

  for (const [label, value] of rejected) {
    it(`отклоняет: ${label}`, () => {
      expect(isValidSlug(value)).toBe(false);
    });
  }

  it('отклоняет slug длиннее максимальной длины', () => {
    expect(isValidSlug('a'.repeat(DEFAULT_SLUG_MAX_LENGTH + 1))).toBe(false);
    expect(isValidSlug('a'.repeat(DEFAULT_SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidSlug('abcdef', { maxLength: 5 })).toBe(false);
  });
});

describe('isValidSlug: позитивные случаи и границы контракта', () => {
  it('принимает односегментный slug с цифрами в начале', () => {
    expect(isValidSlug('8-marta')).toBe(true);
    expect(isValidSlug('23-fevralya')).toBe(true);
  });

  it('формат зарезервированных сегментов валиден — резерв проверяет реестр маршрутов, не этот валидатор', () => {
    // Границы слайса Э1-01a: реестр зарезервированных маршрутов и запрет
    // сегмента `page` остаются на этап 1 (задача Э1-01). Валидатор проверяет
    // только форму одного сегмента, поэтому `page` формально валиден.
    expect(isValidSlug('page')).toBe(true);
    expect(isValidSlug('search')).toBe(true);
  });

  it('любой результат slugify непустого заголовка проходит валидатор', () => {
    const titles = [
      'Открытки С Днём Рождения',
      'Годовщина свадьбы — 25 лет!',
      'Открытки?мужчине&формат=a4',
      '  — Пасха — ',
      'С цветами',
    ];
    for (const title of titles) {
      const slug = slugify(title);
      expect(slug, title).not.toBe('');
      expect(isValidSlug(slug), `${title} -> ${slug}`).toBe(true);
    }
  });

  it('SLUG_PATTERN и isValidSlug согласованы', () => {
    expect(SLUG_PATTERN.test('den-rozhdeniya')).toBe(true);
    expect(SLUG_PATTERN.test('den--rozhdeniya')).toBe(false);
    expect(SLUG_PATTERN.global).toBe(false); // иначе lastIndex сделает проверку неустойчивой
  });
});

describe('slugify: граничные входы', () => {
  it('пустая строка даёт пустую строку, а не бросает исключение', () => {
    expect(slugify('')).toBe('');
    expect(isValidSlug(slugify(''))).toBe(false);
  });

  it('строка только из служебных символов даёт пустую строку', () => {
    expect(slugify('___')).toBe('');
    expect(slugify('  ?&=#/  ')).toBe('');
    expect(slugify('---')).toBe('');
    expect(slugify('ЬЪ')).toBe('');
    expect(slugify('🎉🎂')).toBe('');
  });

  it('очень длинный заголовок обрезается по границе слова и остаётся валидным', () => {
    const long = Array.from({ length: 40 }, () => 'Открытка маме').join(' ');
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(DEFAULT_SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('-')).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
    // Обрезка не рвёт слово посередине.
    expect(slug.split('-').every((part) => ['otkrytka', 'mame'].includes(part))).toBe(true);
  });

  it('обрезает одно длинное слово жёстко, когда границы слова нет', () => {
    const slug = slugify('о'.repeat(200));
    expect(slug).toBe('o'.repeat(DEFAULT_SLUG_MAX_LENGTH));
    expect(isValidSlug(slug)).toBe(true);
  });

  it('уважает maxLength из опций', () => {
    expect(slugify('Открытки с днём рождения маме', { maxLength: 12 })).toBe('otkrytki-s');
    expect(slugify('Открытки с днём рождения маме', { maxLength: 5 })).toBe('otkry');
  });

  it('отклоняет некорректную maxLength явной ошибкой, а не молчанием', () => {
    expect(() => slugify('Открытки', { maxLength: 0 })).toThrow(RangeError);
    expect(() => slugify('Открытки', { maxLength: -1 })).toThrow(RangeError);
    expect(() => slugify('Открытки', { maxLength: 1.5 })).toThrow(RangeError);
    expect(() => isValidSlug('otkrytki', { maxLength: 0 })).toThrow(RangeError);
  });
});

describe('прогон slug из docs/etap-0-struktura-url.md через валидатор', () => {
  // Все slug из разделов 1 и 2 черновика структуры URL, включая перечисленные
  // там альтернативы. Черновик (строки 241-243) требует именно такой сверки.
  const draftSlugs = [
    // раздел 1: пути первого уровня и служебные сегменты
    'otkrytki',
    'podborki',
    'search',
    'o-proekte',
    'usloviya',
    'kontakty',
    'admin',
    'generator',
    'preview',
    'account',
    'pozdravleniya',
    // раздел 2.2: праздники
    'den-rozhdeniya',
    'novyy-god',
    'den-materi',
    'den-uchitelya',
    '8-marta',
    '23-fevralya',
    'den-pobedy',
    'rozhdestvo',
    '1-sentyabrya',
    'svadba',
    'godovshchina-svadby',
    'yubiley',
    '14-fevralya',
    'maslenitsa',
    'paskha',
    'vypusknoy',
    // раздел 2.2: уточнения второго уровня
    'mame',
    'babushke',
    'kollege',
    'podruge',
    'pape',
    'muzhchine',
    'zhenshchine',
    // раздел 2.3: адресаты
    'dedushke',
    'zhene',
    'muzhu',
    'sestre',
    'bratu',
    'synu',
    'docheri',
    'uchitelyu',
    // раздел 2.4: стили и настроения
    'krasivye',
    'smeshnye',
    'detskie',
    's-tsvetami',
    'ofitsialnye',
    // раздел 6.1: альтернативы, перечисленные как выбор человека
    '9-maya',
    'den-svyatogo-valentina',
    'svetloe-khristovo-voskresenie',
    'vosmoe-marta',
    'dvadtsat-tretye-fevralya',
  ] as const;

  for (const slug of draftSlugs) {
    it(`«${slug}» проходит валидатор`, () => {
      expect(isValidSlug(slug)).toBe(true);
    });
  }

  it('список синхронизирован с черновиком: 52 slug', () => {
    // Число прибито гвоздём осознанно: если в черновике появится или исчезнет
    // узел, тест покраснеет и список придётся привести в соответствие, а не
    // тихо разойтись с документом.
    expect(draftSlugs).toHaveLength(52);
  });

  it('сторож синхронизации: ранее расходившиеся slug теперь совпадают с таблицей', () => {
    // Валидатор проверяет только форму, поэтому был зелёным на обоих написаниях.
    // Здесь сверяется именно написание: черновик исправлен под таблицу
    // (s-cvetami → s-tsvetami, pasha → paskha, hristovo → khristovo), и эти три
    // пары обязаны краснеть при любом расхождении в будущем.
    expect(slugify('С цветами')).toBe('s-tsvetami');
    expect(draftSlugs).toContain('s-tsvetami');
    expect(draftSlugs).not.toContain('s-cvetami');

    expect(slugify('Пасха')).toBe('paskha');
    expect(draftSlugs).toContain('paskha');
    expect(draftSlugs).not.toContain('pasha');

    expect(slugify('Светлое Христово Воскресение')).toBe('svetloe-khristovo-voskresenie');
    expect(draftSlugs).toContain('svetloe-khristovo-voskresenie');
    expect(draftSlugs).not.toContain('svetloe-hristovo-voskresenie');
  });

  it('воспроизводит остальные slug черновика из русских заголовков', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['День рождения', 'den-rozhdeniya'],
      ['Новый год', 'novyy-god'],
      ['День матери', 'den-materi'],
      ['День учителя', 'den-uchitelya'],
      ['8 Марта', '8-marta'],
      ['23 Февраля', '23-fevralya'],
      ['День Победы', 'den-pobedy'],
      ['Рождество', 'rozhdestvo'],
      ['1 Сентября', '1-sentyabrya'],
      ['Свадьба', 'svadba'],
      ['Годовщина свадьбы', 'godovshchina-svadby'],
      ['Юбилей', 'yubiley'],
      ['14 Февраля', '14-fevralya'],
      ['Масленица', 'maslenitsa'],
      ['Пасха', 'paskha'],
      ['Выпускной', 'vypusknoy'],
      ['С цветами', 's-tsvetami'],
      ['Светлое Христово Воскресение', 'svetloe-khristovo-voskresenie'],
      ['Маме', 'mame'],
      ['Бабушке', 'babushke'],
      ['Коллеге', 'kollege'],
      ['Подруге', 'podruge'],
      ['Папе', 'pape'],
      ['Мужчине', 'muzhchine'],
      ['Женщине', 'zhenshchine'],
      ['Дедушке', 'dedushke'],
      ['Жене', 'zhene'],
      ['Мужу', 'muzhu'],
      ['Сестре', 'sestre'],
      ['Брату', 'bratu'],
      ['Сыну', 'synu'],
      ['Дочери', 'docheri'],
      ['Учителю', 'uchitelyu'],
      ['Красивые', 'krasivye'],
      ['Смешные', 'smeshnye'],
      ['Детские', 'detskie'],
      ['Официальные', 'ofitsialnye'],
      ['9 Мая', '9-maya'],
      ['День святого Валентина', 'den-svyatogo-valentina'],
      ['Поздравления', 'pozdravleniya'],
      ['О проекте', 'o-proekte'],
      ['Условия', 'usloviya'],
      ['Контакты', 'kontakty'],
      ['Открытки', 'otkrytki'],
      ['Подборки', 'podborki'],
    ];

    for (const [title, expected] of pairs) {
      expect(slugify(title), title).toBe(expected);
    }
  });
});
