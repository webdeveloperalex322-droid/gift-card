import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLUG_MAX_LENGTH,
  findYearInSlug,
  hasYearInSlug,
  isValidSlug,
  SLUG_PATTERN,
  slugify,
  YEAR_IN_SLUG_MAX,
  YEAR_IN_SLUG_MIN,
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
 * Поведение на литерах без таблицы задано решением Ч-25 (2026-08-21): такие
 * литеры ПРОПУСКАЮТСЯ, а ошибка возникает только если результат пуст целиком.
 * Прежнее поведение (одна литера обрывала весь результат) отменено ответом
 * человека, а не сломалось: тесты ниже переписаны под новую норму. Смягчение,
 * принятое вместе с ответом: алфавиты СНГ (украинский, белорусский, казахский,
 * азербайджанский, турецкий) внесены в таблицы, поэтому пропуск на них не
 * срабатывает вовсе. Принимаемый риск назван в `docs/otkrytye-voprosy.md`, К-3.
 *
 * Решения Ч-24 (образец имени файла приведён к таблице), Ч-26 (длина — жёсткий
 * отказ, slug 80) и Ч-27 (slug из одних цифр отклоняется) закрыты тем же днём.
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

  it('соответствует образцу имени файла из CLAUDE.md (решение Ч-24)', () => {
    // Ч-24 закрыт: правится образец, а не таблица. `CLAUDE.md` теперь приводит
    // `otkrytka-mame-na-8-marta-s-tyulpanami.webp`, правило `ю → yu` остаётся
    // нормой. Спецправила под отдельный пример здесь нет и не будет: исключение
    // из таблицы рассинхронизировало бы slug и имена файлов.
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

describe('slugify: алфавиты СНГ транслитерируются, а не пропускаются (Ч-25)', () => {
  // Смягчение, принятое человеком вместе с ответом Ч-25: география проекта —
  // Россия и СНГ (ТЗ §16), а пропуск литеры даёт правдоподобный slug ДРУГОГО
  // слова, необратимый после первой публикации. Поэтому на этих алфавитах
  // литеры обязаны транслитерироваться, а не исчезать.
  const transliterated: ReadonlyArray<readonly [string, string, string]> = [
    ['украинский', 'Київ', 'kiyiv'],
    ['украинский', 'Открытки для Наталії', 'otkrytki-dlya-nataliyi'],
    ['украинский', 'Ґанок открытки', 'ganok-otkrytki'],
    ['украинский', 'Єлизавета', 'yelizaveta'],
    ['украинский', 'Открытка мамі', 'otkrytka-mami'],
    ['белорусский', 'Открытка ў садзе', 'otkrytka-u-sadze'],
    ['белорусский', 'ў', 'u'],
    ['казахский', 'Гүлдер', 'gulder'],
    ['казахский', 'Қазақстан', 'kazakstan'],
    ['казахский', 'Түсау кесу', 'tusau-kesu'],
    ['азербайджанский', 'Bakı', 'baki'],
    ['азербайджанский', 'Ənvər', 'enver'],
    ['азербайджанский', 'Ənvər açıq', 'enver-aciq'],
    ['азербайджанский', 'открытки Ənvər', 'otkrytki-enver'],
    ['турецкий', 'Doğum günün kutlu olsun', 'dogum-gunun-kutlu-olsun'],
    ['турецкий', 'Güneş', 'gunes'],
    ['турецкий', 'çiçek', 'cicek'],
    ['смешанный вход', 'Kyiv Київ', 'kyiv-kiyiv'],
  ];

  for (const [alphabet, title, expected] of transliterated) {
    it(`${alphabet}: «${title}» → ${expected}`, () => {
      expect(slugify(title)).toBe(expected);
      expect(isValidSlug(slugify(title))).toBe(true);
    });
  }

  it('покрывает дополнительные литеры алфавитов целиком, а не выборочно', () => {
    // Украинский: і ї є ґ. Белорусский: ў. Казахский: ә ғ қ ң ө ұ ү һ і.
    expect(slugify('іїєґ')).toBe('iyiyeg');
    expect(slugify('әғқңөұүһі')).toBe('agkngouuhi');
    expect(slugify('ıəçşğöü')).toBe('iecsgou');
  });

  it('верхний регистр этих алфавитов даёт тот же slug, что нижний', () => {
    expect(slugify('ІЇЄҐ')).toBe(slugify('іїєґ'));
    expect(slugify('ӘҒҚҢӨҰҮҺІ')).toBe(slugify('әғқңөұүһі'));
    expect(slugify('Ў')).toBe(slugify('ў'));
    expect(slugify('Ə')).toBe(slugify('ə'));
  });

  it('ни одна литера этих алфавитов не пропадает молча', () => {
    // Сторож смягчения: если литеру забудут внести в таблицу, slug станет
    // пустым, — и этот тест покраснеет раньше первой публикации.
    const letters = [
      'і', 'ї', 'є', 'ґ', 'ў',
      'ә', 'ғ', 'қ', 'ң', 'ө', 'ұ', 'ү', 'һ',
      'ı', 'ə', 'ç', 'ş', 'ğ', 'ö', 'ü',
    ];
    for (const letter of letters) {
      expect(slugify(letter), letter).not.toBe('');
      expect(isValidSlug(slugify(letter)), letter).toBe(true);
    }
  });

  it('известное следствие единой посимвольной таблицы: языка она не знает', () => {
    // `и` передаётся как `i` по русской норме, поэтому «Київ» даёт `kiyiv`, а не
    // «kyiv». Зависимость от языка означала бы угадывание языка по буквам и два
    // разных slug для одного заголовка. Детерминизм здесь важнее читаемости.
    expect(slugify('Київ')).toBe('kiyiv');
    // Казахские `ұ` и `ү` обе дают `u` — как `ы` и `й` дают `y`. Совпадение slug
    // двух разных написаний закрывает не эта функция, а проверка уникальности
    // итогового пути в хуках Payload (Э1-09).
    expect(slugify('Гұлдер')).toBe(slugify('Гүлдер'));
  });
});

describe('slugify: письменности без таблицы — литеры пропускаются (Ч-25)', () => {
  // Норма после ответа человека: «такие символы просто пропускаем; если при этом
  // имя становится пустым — выкидываем ошибку». Пропуск, а не разделитель:
  // дефис на месте невидимой буквы выглядел бы как часть слова.
  const skipped: ReadonlyArray<readonly [string, string, string]> = [
    ['армянский', 'Բարև открытки', 'otkrytki'],
    ['грузинский', 'გილოცავ открытки', 'otkrytki'],
    ['греческий', 'Καλά открытки', 'otkrytki'],
    ['CJK', '生日快乐 открытки', 'otkrytki'],
  ];

  for (const [script, title, expected] of skipped) {
    it(`${script}: «${title}» → ${expected}`, () => {
      expect(slugify(title)).toBe(expected);
      expect(isValidSlug(slugify(title))).toBe(true);
    });
  }

  it('пропуск не оставляет дефиса на месте буквы', () => {
    expect(slugify('открытки Բարև маме')).toBe('otkrytki-mame');
    expect(slugify('открытки გილოცავ маме')).toBe('otkrytki-mame');
  });

  it('пустой результат отклоняется валидатором — здесь и возникает ошибка', () => {
    // Функция остаётся чистой и не бросает: «выкидываем ошибку» реализовано на
    // границе использования (isValidSlug === false, а вызывающий код в
    // packages/images и в хуках Payload бросает внятное исключение).
    for (const title of ['Բարև', 'Շնորհավոր', 'გილოცავ', 'Καλά', '生日快乐']) {
      expect(slugify(title), title).toBe('');
      expect(isValidSlug(slugify(title)), title).toBe(false);
    }
  });

  it('принимаемый риск зафиксирован: пропуск даёт правдоподобный slug', () => {
    // Осознанная цена решения (docs/otkrytye-voprosy.md, К-3): результат выглядит
    // валидным, хотя часть слова исчезла. Тест не «одобряет» риск, а фиксирует
    // его: если поведение изменится, изменение будет замечено.
    expect(slugify('Ελλάδα otkrytki')).toBe('otkrytki');
    expect(isValidSlug(slugify('Ελλάδα otkrytki'))).toBe(true);
  });
});

describe('slugify: регрессии, которых решение Ч-25 не отменяет', () => {
  it('одиночная комбинирующая метка отбрасывается, а не становится дефисом', () => {
    // `İ` U+0130 после toLowerCase распадается на `i` + U+0307, и составной
    // строчной формы у него нет — NFC не собирает её обратно. Метка
    // отбрасывается: базовая литера `i` допустимый символ дала, слово остаётся
    // целым и верным (`İki` по-турецки и по-азербайджански читается «iki»).
    // Чего быть НЕ должно — `i-stanbul-otkrytki`.
    expect(slugify('İstanbul otkrytki')).toBe('istanbul-otkrytki');
    expect(slugify('İki')).toBe('iki');
    // Прямой вход из кодовых точек: тест не зависит от того, как редактор
    // сохранил файл и нормализовал ли он строку.
    expect(slugify('i̇stanbul otkrytki')).toBe('istanbul-otkrytki');
    expect(slugify('i̇ki')).toBe('iki');
    expect(slugify('̇')).toBe('');
  });

  it('знак ударения в русском тексте не разрывает слово', () => {
    // «поздравления» со знаком ударения: у `о` + U+0301 составной формы нет, метка отбрасывается.
    expect(slugify('по́здравления')).toBe('pozdravleniya');
    expect(slugify('откры́тки маме')).toBe('otkrytki-mame');
  });

  it('апострофы и кавычки дают слитное слово: ни пропуска слова, ни дефиса', () => {
    // От порядка «DROPPED_CHARS раньше проверки на литеру» зависит, что `ʼ`
    // U+02BC — формально \p{Lm}, то есть литера — не пропадает вместе с буквами.
    expect(slugify('oʼbrien otkrytki')).toBe('obrien-otkrytki');
    expect(slugify("O'Brien")).toBe('obrien');
    expect(slugify('O’Хара')).toBe('okhara'); // O’Хара
    expect(slugify('don’t')).toBe('dont');
    expect(slugify('«Открытки» "маме"')).toBe('otkrytki-mame');
    expect(slugify('“Открытки” маме')).toBe('otkrytki-mame');
    for (const value of ['oʼbrien', "O'Brien", 'don’t', '«Открытки»']) {
      expect(slugify(value), value).not.toBe('');
      expect(isValidSlug(slugify(value)), value).toBe(true);
    }
  });

  it('латиница с диакритикой теряет диакритику', () => {
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('Café Déjà')).toBe('cafe-deja');
    expect(slugify('Garçon')).toBe('garcon');
  });

  it('цифры, дефисы и пробелы поведение не меняют', () => {
    expect(slugify('8 Марта 2027')).toBe('8-marta-2027');
    expect(slugify('otkrytka - a4')).toBe('otkrytka-a4');
  });

  it('полный русский алфавит транслитерируется без потерь', () => {
    expect(slugify('абвгдеёжзийклмнопрстуфхцчшщъыьэюя')).toBe(
      'abvgdeezhziyklmnoprstufkhtschshshchyeyuya',
    );
    expect(slugify('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')).toBe(
      slugify('абвгдеёжзийклмнопрстуфхцчшщъыьэюя'),
    );
  });

  it('Пасха и Паша остаются разными slug', () => {
    expect(slugify('Пасха')).toBe('paskha');
    expect(slugify('Паша')).toBe('pasha');
    expect(slugify('Пасха')).not.toBe(slugify('Паша'));
  });

  it('мягкий и твёрдый знак остаются пустой передачей по таблице', () => {
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
    expect(isValidSlug('1-sentyabrya')).toBe(true);
    expect(isValidSlug('otkrytka-a4')).toBe(true);
    expect(isValidSlug('9-maya-2027')).toBe(true);
  });

  it('отклоняет slug из одних цифр (решение Ч-27)', () => {
    // Ч-27 закрыт: отклонять. Год и ID в пути неотличимы от осмысленного числа,
    // а URL не должен зависеть ни от ID, ни от даты публикации.
    for (const value of ['2027', '8', '0', '12345']) {
      expect(isValidSlug(value), value).toBe(false);
    }
  });

  it('запрещён slug ТОЛЬКО из цифр, а не цифры в slug (Ч-27)', () => {
    expect(isValidSlug('8-marta')).toBe(true);
    expect(isValidSlug('14-fevralya')).toBe(true);
    expect(isValidSlug('a4')).toBe(true);
  });

  it('isValidSlug — политика, SLUG_PATTERN — форма (граница для технических сегментов)', () => {
    // Ч-27 запрещает slug из одних цифр как АДРЕС записи. Технические сегменты
    // пути под этот запрет не попадают: ревизия производной — короткий хеш
    // байтов оригинала (решение Ч-28), и хеш из одних цифр законен, потому что
    // адресом страницы не является. Такие сегменты обязаны проверяться
    // SLUG_PATTERN, а не isValidSlug: иначе часть хешей отклонялась бы без
    // причины. Граница названа здесь, потому что валидатор один на монорепо.
    expect(SLUG_PATTERN.test('12345678')).toBe(true);
    expect(isValidSlug('12345678')).toBe(false);
  });

  it('slugify даёт форму, допустимость проверяет валидатор (Ч-27)', () => {
    // slugify остаётся чистой и политику не знает: `2027` — корректная ФОРМА
    // сегмента, отказ выносит isValidSlug, а внятную ошибку — вызывающий код.
    expect(slugify('2027')).toBe('2027');
    expect(isValidSlug(slugify('2027'))).toBe(false);
    expect(slugify('8')).toBe('8');
    expect(isValidSlug(slugify('8'))).toBe(false);
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

/**
 * Год в slug (условие C3, `CLAUDE.md` → «Правила URL»: «Год не добавляется в
 * URL ежегодных праздников»).
 *
 * Правило живёт ЗДЕСЬ, а не в хуке коллекции, потому что оно про содержимое
 * сегмента адреса — там же, где длина (Ч-26) и запрет slug из одних цифр
 * (Ч-27). Область применения (у каких записей год запрещён) — дело
 * вызывающего: `isValidSlug` года не отклоняет, иначе технические сегменты и
 * записи, которым год не запрещён, попали бы под запрет заодно.
 *
 * Диапазон YEAR_IN_SLUG_MIN..YEAR_IN_SLUG_MAX — выбор агента (обоснование в
 * докстринге `packages/shared/src/slug.ts`): он отделяет год от чисел, которые
 * законно встречаются в адресе («8 марта», «формат 1920x1080»).
 */
describe('год в slug (условие C3)', () => {
  it('находит год как число внутри сегмента', () => {
    expect(findYearInSlug('novyy-god-2027')).toBe('2027');
    expect(findYearInSlug('2027-novyy-god')).toBe('2027');
    expect(findYearInSlug('otkrytki-2030-na-novyy-god')).toBe('2030');
    // Без разделителя — тот же год, спрятанный в слове.
    expect(findYearInSlug('novyygod2027')).toBe('2027');
    expect(hasYearInSlug('novyy-god-2027')).toBe(true);
  });

  it('принимает на вход и целый путь: проверять надо ИТОГОВЫЙ адрес', () => {
    expect(findYearInSlug('/podborki/prazdniki/novyy-god-2027')).toBe('2027');
    expect(findYearInSlug('/otkrytki/8-marta')).toBeNull();
  });

  it('числа в датах праздников и в описании годом не считаются', () => {
    for (const slug of [
      '8-marta',
      '1-sentyabrya',
      '23-fevralya',
      '9-maya',
      'otkrytka-a4',
      'otkrytka-1920x1080',
      'novyy-god',
      'den-rozhdeniya-100-let',
    ]) {
      expect(findYearInSlug(slug), slug).toBeNull();
      expect(hasYearInSlug(slug), slug).toBe(false);
    }
  });

  it('границы диапазона проверяются буквально', () => {
    expect(hasYearInSlug(`prazdnik-${String(YEAR_IN_SLUG_MIN)}`)).toBe(true);
    expect(hasYearInSlug(`prazdnik-${String(YEAR_IN_SLUG_MAX)}`)).toBe(true);
    expect(hasYearInSlug(`prazdnik-${String(YEAR_IN_SLUG_MIN - 1)}`)).toBe(false);
    expect(hasYearInSlug(`prazdnik-${String(YEAR_IN_SLUG_MAX + 1)}`)).toBe(false);
  });

  it('isValidSlug года НЕ отклоняет: область применения задаёт вызывающий', () => {
    // Иначе под запрет попали бы технические сегменты (ревизия производной,
    // Ч-28) и записи, для которых год не запрещён.
    expect(isValidSlug('novyy-god-2027')).toBe(true);
  });
});
