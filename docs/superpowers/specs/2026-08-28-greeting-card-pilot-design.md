# Пилот первоначального наполнения: 50 поздравительных открыток

Дата: 2026-08-28  
Статус: дизайн утверждён человеком, до производства  
Объём: 10 поисковых тем × 5 открыток = 50 финальных изображений

## 1. Цель и границы

Пилот проверяет визуальное качество, разнообразие сюжетов, читаемость русских
надписей и пригодность изображений для текущего пайплайна сайта. Он не является
подтверждением поискового спроса, не создаёт URL, подборки или записи CMS и не
публикует контент. Если карточки позднее будут импортированы, они создаются только
в `draft` с `noindex`; перевод в `published` выполняет человек с ролью `admin`.

По просьбе человека первоначальный объём 500 изображений уменьшен до 50.

## 2. Основание выбора тем

Пилот сочетает внесезонные широкие интенты и основные праздничные темы:

1. открытки с днём рождения женщине;
2. открытки с днём рождения мужчине;
3. картинки с добрым утром;
4. картинки хорошего дня;
5. картинки спокойной ночи;
6. открытки с Новым годом;
7. открытки с 8 Марта;
8. открытки с 23 Февраля;
9. открытки с 9 Мая;
10. открытки на 14 Февраля.

Выбор основан на наблюдаемой выдаче и сторонних оценках видимости конкурентов.
Условие «подтверждённый спрос» из SEO-ТЗ пока не выполнено: для него нужна
сохранённая выгрузка Яндекс Wordstat или другого утверждённого источника
частотности. Поэтому темы используются только для производства тестового контента,
а не как основание для `index,follow`.

Исследованные пулы и сводные страницы:

- https://instapik.ru/pozdravleniya/s-dnem-rozhdeniya/zhenshchine/otkrytki/
- https://happypik.ru/cards/c-dnjom-rozhdenija/muzhchine/
- https://instapik.ru/ejednevnie/utro/pozitivnye-otkrytki/
- https://kartinka.top/otkrytki/otkrytki-horoshhego-dnja.kartinki
- https://lenta.ru/articles/2026/04/09/otkrytki-spokoynoy-nochi/
- https://ria.ru/otkrytki/otkrytki-k-novomu-godu-2026/
- https://happypik.ru/cards/prazdniki/8-marta/
- https://www.imagetext.ru/wiew-den_23_fevral-1.php
- https://rg.ru/post/otkrytki-s-dnem-pobedy-na-9-maia-krasivye-kartinki-s-pozdravleniiami-dlia-skachivaniia-i-pechati.html
- https://lenta.ru/articles/2026/02/14/otkrytki-na-14-fevralya/
- https://yandex.ru/support2/wordstat/ru/interface/new

У конкурентов заимствуются только устойчивые признаки категории: цветы и светлая
элегантность для женского дня рождения; горы, дорога, море и предметный натюрморт
для мужского; кофе, выпечка, животные и природа для ежедневных пожеланий; луна,
звёзды и уют для ночных; цветочные, зимние и мемориальные символы для праздников.
Конкретные композиции, персонажи, надписи и узнаваемая авторская стилизация не
копируются.

## 3. Общий контракт изображения

- Итоговый формат — вертикальный 4:5, рабочий мастер 1024 × 1280 px или больше.
- Апскейл запрещён. Если генератор отдаёт другое соотношение сторон, используется
  безопасный crop до 4:5 без обрезания главного объекта.
- Фон генерируется без букв, слов, цифр, логотипов, подписей, водяных знаков,
  рамок интерфейса и товарных знаков.
- Верхняя либо центральная треть оставляется визуально спокойной под текст.
- На финал отдельно накладываются точные русские строки: заголовок и одно короткое
  пожелание. Генератор не отвечает за орфографию.
- Предпочтительная типографика пилота: выразительный кириллический serif или
  рукописный заголовок без чрезмерных завитков; пожелание — нейтральный читаемый
  sans-serif. Шрифт должен поддерживать кириллицу.
- Цвет текста выбирается по контрасту с фоном; допустимы деликатная тень или
  полупрозрачная подложка. Текст не перекрывает лица, цветы и главный объект.
- В сюжетах нет известных персонажей, знаменитостей, узнаваемых частных лиц,
  брендов и копий существующих открыток.
- Для 23 Февраля запрещены современная военная агитация, оружие крупным планом,
  государственные гербы, действующие военные знаки и лозунги.
- Для 9 Мая используется уважительный язык памяти: без политической агитации,
  натуралистических сцен, поддельных исторических портретов и спорных лозунгов.
- Для Нового года не указывается номер года: изображения остаются актуальными.

Общий хвост каждого генеративного промпта:

> Original portrait greeting-card background, 4:5 aspect ratio, polished editorial
> illustration or photography as specified, calm uncluttered upper third reserved
> for a later Russian headline and one short wish, balanced negative space, no text,
> no letters, no numbers, no logo, no watermark, no signature, no border, no brand,
> no copyrighted character, not a copy of an existing greeting card.

## 4. Производственная матрица

`Промпт-сцена` объединяется с общим хвостом из раздела 3. `Имя` — базовое имя
финального JPEG; производные AVIF/WebP/JPEG создаются штатным пайплайном позднее.

### 4.1. День рождения женщине

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 01 | `den-rozhdeniya-zhenshchine-piony.jpg` | **С днём рождения!**<br>Пусть каждый день дарит радость и вдохновение! | Праздничная открытка с пионами и розами на пудровом фоне | Luxurious bouquet of blush peonies and garden roses, subtle champagne-gold accents, powder-pink background, soft studio light, elegant premium floral editorial style, flowers concentrated in the lower and side areas. |
| 02 | `den-rozhdeniya-zhenshchine-akvarel.jpg` | **С днём рождения!**<br>Желаю счастья, тепла и исполнения желаний! | Акварельная открытка с тюльпанами и полевыми цветами | Airy watercolor tulips and delicate wildflowers, translucent pigments, ivory paper texture, fresh spring palette, generous light and soft edges. |
| 03 | `den-rozhdeniya-zhenshchine-buket.jpg` | **С праздником!**<br>Пусть жизнь расцветает прекрасными событиями! | Современная открытка с лаконичным цветочным букетом | Modern minimal floral still life, one sculptural bouquet in a matte ceramic vase, cream and muted coral palette, refined geometric shadows, contemporary magazine styling. |
| 04 | `den-rozhdeniya-zhenshchine-applikatsiya.jpg` | **С днём рождения!**<br>Улыбок, гармонии и любви каждый день! | Открытка с объёмными бумажными цветами ручной работы | Layered paper-cut flowers with tactile handcrafted petals, warm peach, rose and cream paper, gentle dimensional shadows, tasteful artisanal composition. |
| 05 | `den-rozhdeniya-zhenshchine-sad.jpg` | **Счастливого дня рождения!**<br>Пусть впереди будет много светлых моментов! | Праздничная открытка с цветущим садом и подарком | Sunlit flowering garden, elegant wrapped gift on a small table, restrained confetti, joyful morning atmosphere, dreamy photographic realism, no people. |

### 4.2. День рождения мужчине

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 06 | `den-rozhdeniya-muzhchine-gory.jpg` | **С днём рождения!**<br>Желаю уверенно покорять новые вершины! | Открытка с рассветом над горными вершинами | Majestic mountain peaks at sunrise, subtle trail leading forward, crisp atmosphere, deep blue and warm amber palette, cinematic landscape photography, no person. |
| 07 | `den-rozhdeniya-muzhchine-avtomobil.jpg` | **С праздником!**<br>Пусть удача сопровождает на каждом повороте! | Открытка с классическим автомобилем у мастерской | Original unbranded vintage roadster beside a tasteful workshop, no recognizable make or emblem, warm late-afternoon light, refined automotive editorial photography. |
| 08 | `den-rozhdeniya-muzhchine-parusnik.jpg` | **С днём рождения!**<br>Попутного ветра и больших возможностей! | Открытка с парусником на спокойном море | Graceful sailboat on calm open water, distant horizon, noble navy and silver palette, clean cinematic realism, feeling of freedom and direction. |
| 09 | `den-rozhdeniya-muzhchine-natyurmort.jpg` | **С днём рождения!**<br>Здоровья, достатка и времени для важного! | Тёмная открытка с книгой, часами и чашкой кофе | Sophisticated dark still life with a closed book, unbranded classic wristwatch and espresso cup, walnut surface, warm side light, premium but understated. |
| 10 | `den-rozhdeniya-muzhchine-tort.jpg` | **Поздравляю!**<br>Пусть каждый год открывает новые горизонты! | Современная открытка с праздничным тортом и гирляндой | Stylish birthday cake, abstract garland and restrained paper confetti, bold teal, ochre and burgundy graphic palette, contemporary editorial illustration, no gender stereotype. |

### 4.3. Доброе утро

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 11 | `dobroe-utro-kofe-kruassan.jpg` | **Доброе утро!**<br>Пусть день начнётся с улыбки! | Утренняя открытка с кофе и круассаном у окна | Fresh croissant and steaming coffee on a small table by a sunlit window, linen napkin, gentle morning shadows, cozy natural food photography. |
| 12 | `dobroe-utro-chay-romashki.jpg` | **С добрым утром!**<br>Желаю лёгкого и радостного дня! | Открытка с чашкой чая среди ромашек | Porcelain teacup among dew-covered daisies in a garden, soft watercolor and gouache illustration, fresh green and white palette, luminous morning air. |
| 13 | `dobroe-utro-kot-u-okna.jpg` | **Доброе утро!**<br>Пусть сегодня всё складывается удачно! | Добрая открытка с котом в солнечном окне | Original fluffy cat sitting by a bright window and greeting the first sunbeam, warm cozy storybook illustration, expressive but natural animal anatomy. |
| 14 | `dobroe-utro-rassvet-ozero.jpg` | **Бодрого утра!**<br>Пусть новый день принесёт приятные открытия! | Открытка с рассветом над тихим озером | Misty lake at dawn, golden sun rising behind a pine forest, mirror-like water, tranquil cinematic landscape photography, fresh cool air. |
| 15 | `dobroe-utro-svetlyy-stol.jpg` | **С добрым утром!**<br>Пусть впереди ждёт только хорошее! | Минималистичная открытка со светлым утренним столом | Bright modern desk with a simple notebook, ceramic cup and green branch, Scandinavian calm, clean soft daylight, refined lifestyle photography. |

### 4.4. Хорошего дня

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 16 | `horoshego-dnya-romashki-yagody.jpg` | **Хорошего дня!**<br>Пусть он будет добрым и солнечным! | Летняя открытка с ромашками и свежими ягодами | Fresh summer still life with daisies, strawberries and currants in natural sunlight, lively but uncluttered composition, crisp photographic realism. |
| 17 | `horoshego-dnya-solnechnyy-lug.jpg` | **Прекрасного дня!**<br>Пусть настроение будет на высоте! | Открытка с солнечным лугом и бабочками | Sunny meadow with wildflowers, a winding path and a few delicate butterflies, optimistic painterly realism, blue sky and warm light. |
| 18 | `horoshego-dnya-gorodskoe-kafe.jpg` | **Удачного дня!**<br>Пусть всё задуманное получится! | Открытка с уютным столиком в городском кафе | Charming city café terrace, cup of tea, small flowers and sun patterns on the table, welcoming European street atmosphere, no readable signs. |
| 19 | `horoshego-dnya-zverek-na-share.jpg` | **Чудесного дня!**<br>Пусть он подарит повод для улыбки! | Весёлая открытка со зверьком на воздушном шаре | Original cheerful small animal traveling in a whimsical hot-air balloon above soft clouds, colorful children's-book illustration, no known character. |
| 20 | `horoshego-dnya-abstraktnoe-solntse.jpg` | **Хорошего дня!**<br>Больше света, радости и вдохновения! | Яркая открытка с абстрактным солнцем | Contemporary abstract sun made of clean organic shapes, energetic yellow, sky-blue and coral rhythm, modern screen-print texture, ample negative space. |

### 4.5. Спокойной ночи

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 21 | `spokoynoy-nochi-luna-oblaka.jpg` | **Спокойной ночи!**<br>Пусть сон будет лёгким и добрым! | Ночная открытка с луной и мягкими облаками | Gentle crescent moon resting above soft clouds, tiny stars and subtle glow, dreamy watercolor, deep blue and lavender palette. |
| 22 | `spokoynoy-nochi-okno-pled.jpg` | **Доброй ночи!**<br>Пусть вечер наполнится тишиной и уютом! | Уютная открытка с пледом и ночным окном | Cozy armchair with a folded blanket beside a night window, distant city lights, warm lamp glow, intimate cinematic interior, no person. |
| 23 | `spokoynoy-nochi-zvezdnoe-ozero.jpg` | **Спокойной ночи!**<br>Пусть звёзды берегут твой сон! | Открытка со звёздным небом над озером | Star-filled sky reflected in a still lake, thin forest silhouette, subtle Milky Way, serene realistic night landscape, no artificial neon. |
| 24 | `spokoynoy-nochi-sonnyy-lisenok.jpg` | **Сладких снов!**<br>Пусть утро встретит хорошим настроением! | Милая открытка со спящим лисёнком | Original sleepy fox cub curled under a small knitted blanket, moonlit nursery atmosphere, tender storybook illustration, natural paws and face. |
| 25 | `spokoynoy-nochi-polumesyats.jpg` | **Доброй ночи!**<br>Отдыхай и набирайся сил! | Минималистичная открытка с полумесяцем и звёздами | Minimal celestial composition with one elegant crescent and sparse stars on a velvet indigo background, subtle paper grain, refined graphic design. |

### 4.6. Новый год

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 26 | `novyy-god-el-shary.jpg` | **С Новым годом!**<br>Пусть он принесёт счастье и добрые перемены! | Новогодняя открытка с еловыми ветками и стеклянными шарами | Snow-dusted fir branches and elegant glass ornaments, classic red, green and champagne-gold palette, soft festive bokeh, premium holiday photography. |
| 27 | `novyy-god-kamin-podarki.jpg` | **С Новым годом!**<br>Тепла, уюта и исполнения желаний! | Уютная новогодняя открытка с камином и подарками | Cozy fireplace, tasteful wrapped gifts, candles and knitted blanket, warm amber light, inviting winter interior, no stockings with letters. |
| 28 | `novyy-god-snezhnyy-gorodok.jpg` | **С Новым годом!**<br>Пусть впереди ждёт много чудес! | Акварельная открытка со снежным городком | Small snow-covered town with glowing lanterns and gentle falling snow, lyrical watercolor illustration, blue evening and warm windows, no signs. |
| 29 | `novyy-god-polnochnye-iskry.jpg` | **Счастливого Нового года!**<br>Радости, удачи и ярких событий! | Минималистичная новогодняя открытка с золотыми искрами | Minimal midnight-blue composition with a fir sprig, restrained golden sparks and soft light, elegant contemporary festive design, no clock or numbers. |
| 30 | `novyy-god-snegovik-les.jpg` | **С Новым годом!**<br>Пусть праздник подарит настоящее волшебство! | Добрая новогодняя открытка со снеговиком и лесными зверями | Original friendly snowman with small woodland animals in a snowy forest clearing, magical warm lantern light, painterly storybook style, no known character. |

### 4.7. 8 Марта

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 31 | `8-marta-tyulpany.jpg` | **С 8 Марта!**<br>Пусть весна подарит радость и вдохновение! | Весенняя открытка с ярким букетом тюльпанов | Fresh vibrant tulip bouquet on a light background, soft realistic shadows, coral, pink and yellow flowers, elegant spring photography. |
| 32 | `8-marta-mimoza.jpg` | **С 8 Марта!**<br>Тепла, улыбок и солнечного настроения! | Открытка с веточками мимозы на фоне весеннего неба | Delicate yellow mimosa branches against a pale spring-blue background, airy sunlight, fine botanical detail, fresh optimistic editorial style. |
| 33 | `8-marta-piony-podarok.jpg` | **С праздником весны!**<br>Пусть каждый день будет наполнен красотой! | Открытка с пионами и подарком с шёлковой лентой | Lush peonies beside a refined gift box with an unmarked silk ribbon, cream and dusty rose palette, soft luxury still-life photography. |
| 34 | `8-marta-vesennyaya-akvarel.jpg` | **С 8 Марта!**<br>Счастья, гармонии и прекрасных мгновений! | Акварельная открытка с нарциссами и весенними веточками | Watercolor daffodils and tender spring branches, translucent yellow and green washes on textured ivory paper, light graceful composition. |
| 35 | `8-marta-botanicheskiy-venok.jpg` | **С 8 Марта!**<br>Пусть всё вокруг расцветает вместе с тобой! | Минималистичная открытка с ботаническим цветочным венком | Elegant asymmetrical botanical wreath of leaves and small spring flowers, clean warm-white background, modern minimal illustration, open center. |

### 4.8. 23 Февраля

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 36 | `23-fevralya-stalnaya-grafika.jpg` | **С 23 Февраля!**<br>Желаю силы, уверенности и удачи! | Строгая открытка с сине-стальной геометрической композицией | Abstract steel-blue and warm copper ribbons, precise geometric rays, restrained modern graphic design expressing strength, no flag, no crest, no military insignia. |
| 37 | `23-fevralya-kompas-marshrut.jpg` | **С праздником!**<br>Пусть выбранный путь ведёт к успеху! | Открытка с компасом и походным блокнотом | Unbranded brass compass, closed field notebook and neutral map without labels, textured wood, warm directional light, refined adventure still life. |
| 38 | `23-fevralya-parus-gorizont.jpg` | **С 23 Февраля!**<br>Стойкости, спокойствия и попутного ветра! | Открытка с парусником и морским горизонтом | Strong single sail against a broad calm horizon, cool navy palette and clear light, visual metaphor of steadiness, no navy emblems or flags. |
| 39 | `23-fevralya-masterskaya.jpg` | **Поздравляю!**<br>Здоровья, энергии и новых достижений! | Открытка с аккуратными инструментами в тёплой мастерской | Tastefully arranged unbranded hand tools in a clean woodworking studio, oak textures, warm window light, craftsmanship and reliability, no weapon-like objects. |
| 40 | `23-fevralya-abstraktnyy-shchit.jpg` | **С 23 Февраля!**<br>Пусть рядом всегда будут надёжные люди! | Современная открытка с абстрактной формой щита | Abstract shield-like form built from layered blue and bronze paper geometry, contemporary emblematic design, no weapon, no eagle, no state or military symbol. |

### 4.9. 9 Мая

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 41 | `9-maya-gvozdiki-ogon.jpg` | **С Днём Победы!**<br>Мирного неба и светлой памяти! | Памятная открытка с красными гвоздиками и мемориальным огнём | Red carnations beside a soft abstract memorial flame, dark stone, quiet dawn light, solemn respectful photographic realism, no flag, no slogan. |
| 42 | `9-maya-rassvet-memorial.jpg` | **С Днём Победы!**<br>Пусть память объединяет поколения! | Открытка с тихим мемориалом в лучах рассвета | Distant generic memorial silhouette at sunrise, empty peaceful square, long warm light and quiet atmosphere, no identifiable monument, inscription or emblem. |
| 43 | `9-maya-pismo-pamyati.jpg` | **9 Мая — день памяти.**<br>Благодарим за мир и храним историю! | Памятная открытка с фронтовым письмом и гвоздикой | Generic folded wartime triangular letter with no readable writing, single carnation on aged wooden table, gentle natural light, historically respectful still life. |
| 44 | `9-maya-belyy-golub.jpg` | **С Днём Победы!**<br>Мира, добра и спокойствия каждому дому! | Светлая открытка с белым голубем и красными цветами | White dove in a bright open sky above subtle red carnations, peaceful luminous painterly realism, restrained symbolism, no flags or political marks. |
| 45 | `9-maya-semeynaya-pamyat.jpg` | **Помним. Благодарим.**<br>Пусть в мире всегда будет место добру! | Открытка с семейным альбомом, цветами и свечой | Closed vintage family album with no visible faces, carnations and one warm remembrance candle, intimate respectful still life, no medals or readable documents. |

### 4.10. 14 Февраля

| № | Имя | Точный текст | Alt | Промпт-сцена |
|---|---|---|---|---|
| 46 | `14-fevralya-bumazhnye-serdtsa.jpg` | **С Днём всех влюблённых!**<br>Пусть любовь согревает каждый день! | Романтическая открытка с бумажными сердцами | Layered handmade paper hearts casting soft shadows, modern coral, crimson and blush palette, elegant tactile craft aesthetic, no letters. |
| 47 | `14-fevralya-dve-chashki.jpg` | **С 14 Февраля!**<br>Как хорошо, что мы есть друг у друга! | Уютная открытка с двумя чашками и руками влюблённых | Two warm mugs on a cozy table, two adult hands gently touching, faces outside the frame, soft window light, intimate inclusive lifestyle photography. |
| 48 | `14-fevralya-akvarelnye-ptitsy.jpg` | **С Днём влюблённых!**<br>Пусть наши чувства становятся только крепче! | Акварельная открытка с двумя птицами на цветущей ветке | Two original small lovebirds on a flowering branch, delicate watercolor, blush and burgundy accents, tender balanced composition, natural bird anatomy. |
| 49 | `14-fevralya-shokolad-tsvety.jpg` | **С 14 Февраля!**<br>Нежности, тепла и счастливых моментов! | Открытка с шоколадом и нежным букетом | Artisanal unbranded chocolates, a small romantic bouquet and ribbon on linen, warm moody still-life photography, sophisticated and not commercial. |
| 50 | `14-fevralya-geometriya-lyubvi.jpg` | **Люблю тебя!**<br>Пусть у нашей истории будет счастливое продолжение! | Минималистичная открытка с красно-розовыми формами сердца | Abstract heart suggested by interlocking red, rose and burgundy geometric forms, contemporary editorial poster texture, expressive negative space, no typography. |

## 5. Артефакты пилота

Рабочая структура после производства:

```text
content/pilot-2026-08/
├── backgrounds/     # 50 исходных фонов без текста
├── final/           # 50 мастеров 4:5 с точной русской надписью
├── rejected/        # отбракованные варианты, не для импорта
└── manifest.csv     # тема, имя, текст, alt, промпт, размеры, QA-статус
```

Финальные мастера сохраняются в JPEG с расширением `.jpg`. Исходные фоны
сохраняются отдельно, чтобы исправлять текст без повторной генерации. Производные
AVIF/WebP/JPEG и набор `srcset` не создаются вручную в пилоте: при будущем импорте
их делает существующий пакет `packages/images` с текущими настройками проекта.

## 6. Контроль качества

Каждое изображение получает один из статусов `accepted` или `rejected`.

Обязательные проверки перед `accepted`:

1. Файл читается, имеет вертикальное соотношение 4:5 и ширину не меньше 640 px.
2. Точный заголовок и пожелание совпадают со спецификацией, включая `ё`, регистр и
   знаки препинания.
3. Текст читается в полном размере и в превью шириной 320 px.
4. Нет лишних букв, цифр, водяных знаков, логотипов и товарных знаков.
5. Главный объект не деформирован, не обрезан и не перекрыт текстом.
6. Изображение не копирует конкретную открытку конкурента и не имитирует
   узнаваемого живого художника.
7. Внутри одной темы пять работ различаются предметом, композицией и визуальной
   техникой. pHash-distance ниже проектного порога 14 — сигнал ручной проверки, а
   не автоматическая блокировка.
8. `alt` описывает видимое изображение естественно и не перечисляет ключевые слова.
9. Сюжеты 23 Февраля и 9 Мая проходят отдельную проверку на символику, этичность и
   отсутствие агитации.
10. Никакие CMS-записи, URL, sitemap или robots в ходе производства не меняются.

Если вариант не прошёл проверку, он перемещается в `rejected`, а для того же номера
делается одна новая генерация с уточнённым промптом. Человек получает только 50
принятых финальных мастеров и manifest со статусами.

## 7. Критерий завершения пилота

Пилот готов к передаче, когда существуют 50 принятых финальных мастеров, 50
редактируемых фонов, заполненный manifest и отчёт QA. Это всё ещё не разрешение на
публикацию или индексацию. Импорт в CMS и ручная модерация являются отдельной
задачей.
