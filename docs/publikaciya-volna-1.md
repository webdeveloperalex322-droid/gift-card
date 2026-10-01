# Волна 1: публикация до порога Ч-06 и открытие тем в index,follow

Документ подготовлен агентом 2026-09-03 по решению человека: «сначала добить темы до 20+,
публикацию применяет человек в админке, агент готовит список». Публикация и открытие в
`index,follow` не бывают автоматическими (п. 7.1, п. 23 ТЗ) — здесь только ВЫБОРКА и порядок
действий, ни одного действия агент не выполнил.

Цель по каждой теме — **24 опубликованных открыток** (порог Ч-06 — минимум 20, ориентир 20–40;
24 выбрано потому, что это размер страницы каталога `DEFAULT_CARDS_PER_PAGE`, то есть первая
страница темы заполняется ровно целиком, без «хвоста» на второй странице).

## Как отбирались карточки

Фильтр машинный, без ручного вкуса: статус `review`, ноль конфликтов метатегов
(`meta_conflict_total = 0`), непустой `metaDescription`, привязанное изображение. Порядок — по
`slug` по возрастанию, чтобы выборка была воспроизводима: повторный запуск даёт тот же список.
Карточки в `draft` не берутся вовсе — это отказы по визуальным дублям, ждущие решения редактора.

## Порядок действий

1. **Опубликовать карточки** по списку ниже — пакетно, по явному списку id, от роли `admin`
   (Ч-07). Порядок тем значения не имеет.
2. **Опубликовать узел `den-rozhdeniya`** (id 309): он единственный из шести стоит в `review`.
   Остальные пять узлов уже опубликованы.
3. **Проверить, что каждая тема отдаёт 200** и показывает 24 открытки.
4. **Только после этого** выставить `robots = index,follow` шести узлам (id ниже). До шага 3
   этого делать нельзя: индексируемая страница обязана отвечать 200 (п. 5.1).
5. Сказать агенту — он прогонит приёмку, обновит объявленные ожидания в `tests/seo` (сейчас там
   зафиксировано `noindex,follow` у всех страниц, и это сторож: приёмка УПАДЁТ, пока ожидание не
   приведено в соответствие с вашим решением) и проверит, что в sitemap попали ровно эти шесть
   адресов и ни одного лишнего.

## Что публиковать

### /otkrytki/prazdniki/8-marta

Узел: id **307**, статус `published`. Опубликовано открыток сейчас: 5. Нужно добавить: **19**.

Список id для пакетной публикации:

```
1513, 1511, 1503, 1526, 1518, 1498, 1490, 1516, 1506, 1486, 1491, 1496, 1509, 1492, 1502, 1487, 1520, 1494, 1489
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1513 — `otkrytka-8-marta-8-abstraktnymi-lentami-formami`
- 1511 — `otkrytka-8-marta-8-krokusami-probivayushchimisya-skvoz`
- 1503 — `otkrytka-8-marta-8-polem-raznotsvetnykh-tyulpanov`
- 1526 — `otkrytka-8-marta-8-progulkoy-podrug-raznykh-vozrastov`
- 1518 — `otkrytka-8-marta-8-solnechnymi-shtorami-kreslom`
- 1498 — `otkrytka-8-marta-8-stile-guashi-kameliyami`
- 1490 — `otkrytka-8-marta-8-stile-sovetskogo-ofseta-chaynym`
- 1516 — `otkrytka-8-marta-8-tsvetushchey-magnoliey-svetlom-fone`
- 1506 — `otkrytka-8-marta-8-velosipedom-korzinoy-vesennikh`
- 1486 — `otkrytka-8-marta-akvarelnaya-8-devochkoy-daryashchey`
- 1491 — `otkrytka-8-marta-akvarelnaya-8-mamoy-dochkoy-tsvety`
- 1496 — `otkrytka-8-marta-akvarelnaya-8-zhenshchinoy-velosipede`
- 1509 — `otkrytka-8-marta-akvarelnymi-lastochkami-tsvetushchimi`
- 1492 — `otkrytka-8-marta-bumazhnaya-8-tyulpanami-nartsissami`
- 1502 — `otkrytka-8-marta-bumazhnaya-8-venkom-tyulpanov-mimozy`
- 1487 — `otkrytka-8-marta-bumazhnaya-retro-otkrytka-8-mimozoy`
- 1520 — `otkrytka-8-marta-dorozhkoy-tsvetushchem-vesennem-sadu`
- 1494 — `otkrytka-8-marta-graficheskaya-8-gvozdikami-tsvetnymi`
- 1489 — `otkrytka-8-marta-graficheskaya-8-krasnymi-tyulpanami`

</details>

### /otkrytki/prazdniki/23-fevralya

Узел: id **306**, статус `published`. Опубликовано открыток сейчас: 5. Нужно добавить: **19**.

Список id для пакетной публикации:

```
1569, 1564, 1539, 1533, 1556, 1544, 1551, 1549, 1566, 1561, 1571, 1559, 1528, 1548, 1537, 1547, 1572, 1538, 1543
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1569 — `otkrytka-23-fevralya-23-abstraktnymi-shesterenkami`
- 1564 — `otkrytka-23-fevralya-23-fotoapparatom-dorozhnoy-sumkoy`
- 1539 — `otkrytka-23-fevralya-23-masterom-delayushchim`
- 1533 — `otkrytka-23-fevralya-23-mayakom-morem-gorami-dubovymi`
- 1556 — `otkrytka-23-fevralya-23-mayakom-skalistom-morskom-beregu`
- 1544 — `otkrytka-23-fevralya-23-ottsom-synom-sazhayushchimi-dub`
- 1551 — `otkrytka-23-fevralya-23-parusnikom-spokoynoy-vode`
- 1549 — `otkrytka-23-fevralya-23-pokhodnym-ryukzakom-gornoy`
- 1566 — `otkrytka-23-fevralya-23-puteshestvennikom-sobakoy-gornom`
- 1561 — `otkrytka-23-fevralya-23-rezboy-derevyannoy-lozhki`
- 1571 — `otkrytka-23-fevralya-23-sborkoy-nebolshogo-uchebnogo`
- 1559 — `otkrytka-23-fevralya-23-sportivnymi-krossovkami-butylkoy`
- 1528 — `otkrytka-23-fevralya-23-tvorcheskim-stolom-keramicheskoy`
- 1548 — `otkrytka-23-fevralya-abstraktnaya-bumazhnaya-arkami`
- 1537 — `otkrytka-23-fevralya-akvarelnaya-23-druzyami-lyzhnoy`
- 1547 — `otkrytka-23-fevralya-akvarelnaya-druzyami-kostra-lesnogo`
- 1572 — `otkrytka-23-fevralya-alpinistskoy-verevkoy-karabinami`
- 1538 — `otkrytka-23-fevralya-bumazhnaya-23-arochnym-mostom-rekoy`
- 1543 — `otkrytka-23-fevralya-bumazhnaya-23-parusnikom-morem`

</details>

### /otkrytki/prazdniki/9-maya

Узел: id **308**, статус `published`. Опубликовано открыток сейчас: 5. Нужно добавить: **19**.

Список id для пакетной публикации:

```
1614, 1604, 1594, 1617, 1592, 1582, 1587, 1577, 1595, 1593, 1583, 1580, 1590, 1585, 1611, 1601, 1578, 1599, 1600
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1614 — `otkrytka-9-maya-9-maya-botanicheskoy-ramkoy-krasnykh`
- 1604 — `otkrytka-9-maya-9-maya-gvozdikami-podokonnike-rannem`
- 1594 — `otkrytka-9-maya-9-maya-krasnymi-gvozdikami-odnoy-svechoy`
- 1617 — `otkrytka-9-maya-abstraktnymi-belymi-formami-krasnymi`
- 1592 — `otkrytka-9-maya-akvarelnaya-babushkoy-rebenkom-belykh`
- 1582 — `otkrytka-9-maya-akvarelnaya-dedushkoy-vnukom-derevo`
- 1587 — `otkrytka-9-maya-akvarelnaya-pozhiloy-zhenshchinoy`
- 1577 — `otkrytka-9-maya-akvarelnaya-rebenkom-dedushkoy-kamnya`
- 1595 — `otkrytka-9-maya-belymi-golubyami-rekoy-rassvete`
- 1593 — `otkrytka-9-maya-bumazhnaya-venkom-gvozdik-golubyami`
- 1583 — `otkrytka-9-maya-bumazhnaya-zhuravlyami-gvozdikami`
- 1580 — `otkrytka-9-maya-graficheskaya-belymi-golubyami-mirnym`
- 1590 — `otkrytka-9-maya-graficheskaya-mirnoy-rekoy-tsvetushchey`
- 1585 — `otkrytka-9-maya-graficheskaya-rassvetom-mirnoy-derevney`
- 1611 — `otkrytka-9-maya-gvozdikami-svechoy-otrazheniem-temnom`
- 1601 — `otkrytka-9-maya-lugom-krasnykh-makov-belykh-polevykh`
- 1578 — `otkrytka-9-maya-otkrytka-kollazh-gvozdikami-sirenyu`
- 1599 — `otkrytka-9-maya-pokolenya-molodoe-derevo`
- 1600 — `otkrytka-9-maya-prostym-vechnym-ognem-sredi-vesennikh`

</details>

### /otkrytki/prazdniki/14-fevralya

Узел: id **305**, статус `published`. Опубликовано открыток сейчас: 5. Нужно добавить: **19**.

Список id для пакетной публикации:

```
1420, 1409, 1416, 1427, 1419, 1410, 1414, 1396, 1421, 1422, 1412, 1401, 1411, 1426, 1434, 1406, 1393, 1418, 1436
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1420 — `otkrytka-14-fevralya-buket-sadovykh-roz-kraftovoy-bumage`
- 1409 — `otkrytka-14-fevralya-dva-bokala-yagodnym-napitkom-roz`
- 1416 — `otkrytka-14-fevralya-dva-bumazhnykh-golubya-polete`
- 1427 — `otkrytka-14-fevralya-dva-krolika-sidyat-pole-klevera`
- 1419 — `otkrytka-14-fevralya-dva-malenkikh-silueta-idut-beregu`
- 1410 — `otkrytka-14-fevralya-dva-neytralnykh-litsa-profil-odnoy`
- 1414 — `otkrytka-14-fevralya-dva-neytralnykh-silueta-idut-odnim`
- 1396 — `otkrytka-14-fevralya-dva-neytralnykh-silueta-sidyat`
- 1421 — `otkrytka-14-fevralya-dva-perepletennykh-koltsa-rozovoy`
- 1422 — `otkrytka-14-fevralya-dva-pingvina-stoyat-tikhom-ledyanom`
- 1412 — `otkrytka-14-fevralya-dva-poluprozrachnykh-steklyannykh`
- 1401 — `otkrytka-14-fevralya-dva-pustykh-kresla-balkone-obshchim`
- 1411 — `otkrytka-14-fevralya-dva-ryzhikh-lisa-idut-zasnezhennomu`
- 1426 — `otkrytka-14-fevralya-dva-teplykh-okna-naprotiv-drug-loza`
- 1434 — `otkrytka-14-fevralya-dva-tsvetnykh-polukruga-tselnuyu`
- 1406 — `otkrytka-14-fevralya-dva-velosipeda-stoyat-tsvetushchim`
- 1393 — `otkrytka-14-fevralya-dva-zhuravlya-rozovoy-vode-sredi`
- 1418 — `otkrytka-14-fevralya-dve-bordovye-linii-postepenno`
- 1436 — `otkrytka-14-fevralya-dve-bumazhnye-babochki-otdykhayut`

</details>

### /otkrytki/prazdniki/novyy-god

Узел: id **312**, статус `published`. Опубликовано открыток сейчас: 5. Нужно добавить: **19**.

Список id для пакетной публикации:

```
1441, 1446, 1456, 1451, 1447, 1465, 1474, 1467, 1481, 1469, 1449, 1454, 1459, 1478, 1462, 1470, 1471, 1477, 1476
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1441 — `otkrytka-novyy-god-akvarelnaya-belkoy-zaytsem-elki`
- 1446 — `otkrytka-novyy-god-akvarelnaya-detmi-sankakh-zimnem-lesu`
- 1456 — `otkrytka-novyy-god-akvarelnaya-detmi-stroyashchimi`
- 1451 — `otkrytka-novyy-god-akvarelnaya-semey-ukrashayushchey`
- 1447 — `otkrytka-novyy-god-bumazhnaya-snezhnoy-derevney-kometoy`
- 1465 — `otkrytka-novyy-god-bumazhnym-zimnim-gorodom-lunoy`
- 1474 — `otkrytka-novyy-god-bumazhnymi-ptitsami-sredi-zimnikh`
- 1467 — `otkrytka-novyy-god-derevyannymi-sanyami-podarkami`
- 1481 — `otkrytka-novyy-god-feyerverkom-zimney-rekoy`
- 1469 — `otkrytka-novyy-god-geometricheskoy-elkoy-tsvetnymi`
- 1449 — `otkrytka-novyy-god-graficheskaya-chasami-bez-tsifr`
- 1454 — `otkrytka-novyy-god-graficheskaya-prazdnichnym-salyutom`
- 1459 — `otkrytka-novyy-god-kaminnymi-chasami-elovoy-girlyandoy`
- 1478 — `otkrytka-novyy-god-kanatnoy-dorogoy-snezhnoy-dolinoy`
- 1462 — `otkrytka-novyy-god-katkom-vechernimi-ognyami-snezhnym`
- 1470 — `otkrytka-novyy-god-keramicheskimi-igrushkami-derevyannom`
- 1471 — `otkrytka-novyy-god-kotom-moroznogo-okna-zimnimi-ognyami`
- 1477 — `otkrytka-novyy-god-kreslom-chteniya-prazdnichnoy-elki`
- 1476 — `otkrytka-novyy-god-kristallami-snega-moroznymi-uzorami`

</details>

### /otkrytki/prazdniki/den-rozhdeniya

Узел: id **309**, статус `review`. Опубликовано открыток сейчас: 6. Нужно добавить: **18**.

Список id для пакетной публикации:

```
1636, 1646, 1656, 1666, 1626, 1634, 1644, 1654, 1664, 1624, 1622, 1632, 1642, 1652, 1662, 1628, 1638, 1648
```

<details><summary>Те же карточки со slug (для сверки в админке)</summary>

- 1636 — `otkrytka-den-rozhdeniya-mame-balkonnyy-stolik-18`
- 1646 — `otkrytka-den-rozhdeniya-mame-balkonnyy-stolik-28`
- 1656 — `otkrytka-den-rozhdeniya-mame-balkonnyy-stolik-38`
- 1666 — `otkrytka-den-rozhdeniya-mame-balkonnyy-stolik-48`
- 1626 — `otkrytka-den-rozhdeniya-mame-balkonnyy-stolik-chashkami`
- 1634 — `otkrytka-den-rozhdeniya-mame-domashnyaya-vypechka-16`
- 1644 — `otkrytka-den-rozhdeniya-mame-domashnyaya-vypechka-26`
- 1654 — `otkrytka-den-rozhdeniya-mame-domashnyaya-vypechka-36`
- 1664 — `otkrytka-den-rozhdeniya-mame-domashnyaya-vypechka-46`
- 1624 — `otkrytka-den-rozhdeniya-mame-domashnyaya-vypechka-yagody`
- 1622 — `otkrytka-den-rozhdeniya-mame-dorozhnyy-natyurmort`
- 1632 — `otkrytka-den-rozhdeniya-mame-dorozhnyy-natyurmort-14`
- 1642 — `otkrytka-den-rozhdeniya-mame-dorozhnyy-natyurmort-24`
- 1652 — `otkrytka-den-rozhdeniya-mame-dorozhnyy-natyurmort-34`
- 1662 — `otkrytka-den-rozhdeniya-mame-dorozhnyy-natyurmort-44`
- 1628 — `otkrytka-den-rozhdeniya-mame-izvilistaya-dorozhka-sadu`
- 1638 — `otkrytka-den-rozhdeniya-mame-izvilistaya-dorozhka-sadu-20`
- 1648 — `otkrytka-den-rozhdeniya-mame-izvilistaya-dorozhka-sadu-30`

</details>

## Открыть в index,follow (шаг 4)

Только узлы, только после шага 3:

```
307, 306, 308, 305, 312, 309
```

- 307 — `/otkrytki/prazdniki/8-marta`
- 306 — `/otkrytki/prazdniki/23-fevralya`
- 308 — `/otkrytki/prazdniki/9-maya`
- 305 — `/otkrytki/prazdniki/14-fevralya`
- 312 — `/otkrytki/prazdniki/novyy-god`
- 309 — `/otkrytki/prazdniki/den-rozhdeniya`

**Карточки в этой волне в индекс НЕ открываются.** У них останется `noindex,follow`, то есть в
sitemap уйдут только шесть посадочных. Открытие карточек — отдельное решение: их 1000+, и
вопрос «пускать ли в индекс каждую открытку» стоит решать на замерах первой волны, а не вслепую.

## Что проверено машинно перед выдачей списка

- отобрано карточек всего: **113**;
- у всех отобранных: непустой `metaDescription`, привязанное изображение, ноль конфликтов метатегов;
- дублирующихся title среди отобранных: **0**;
- дублирующихся title среди уже опубликованных: **0**;
- у всех шести узлов заполнены `title`, `h1`, `metaDescription` и вводный текст — то есть
  условие п. 5.1 «уникальные title/H1/вводный текст» имеет чем выполняться, а не пусто.

## Чего этот документ НЕ утверждает

- **«подтверждённый спрос» (условие 5.1.1) не выполнен** и выполненным не станет от публикации:
  частотностей нет, приоритет тем построен по календарю праздников как допущение (Ч-04-1).
  Открытие в индекс — ваше решение при незакрытом условии, и это стоит знать прямо;
- достижимость «≤ 4 перехода от главной» после открытия начнёт проверяться приёмкой
  (`no-orphans.spec.ts` сейчас печатает «проверено нечем» именно потому, что индексируемых
  страниц ноль). Возможны находки — они пойдут владельцу шаблона;
- `lastmod` у публикуемых карточек останется пустым: `updatedContentAt` не двигался, а
  публикация содержательным обновлением не считается.

