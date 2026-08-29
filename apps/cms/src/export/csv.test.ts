import { describe, expect, it } from 'vitest';

import { CSV_BOM, CSV_EOL, csvDocument, csvField, csvRow } from './csv';

describe('поле CSV', () => {
  it('обычное значение не обрамляется', () => {
    expect(csvField('Открытка')).toBe('Открытка');
  });

  it('запятая, кавычка и перевод строки обрамляются, кавычка удваивается', () => {
    expect(csvField('Мама, папа')).toBe('"Мама, папа"');
    expect(csvField('Открытка «8 марта» и "кавычки"')).toBe(
      '"Открытка «8 марта» и ""кавычки"""',
    );
    expect(csvField('первая\nвторая')).toBe('"первая\nвторая"');
  });

  it('пусто и null дают пустую ячейку, а не строку «null»', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField('')).toBe('');
  });

  /**
   * Заголовки записей заполняет в том числе внешний AI-редактор через API.
   * Ячейка, начинающаяся с `=`, в Excel — формула: открытие выгрузки стало бы
   * выполнением кода на машине редактора.
   */
  it('формула обезвреживается ведущим апострофом', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('+79990000000')).toBe("'+79990000000");
  });

  it('обезвреженное значение с запятой всё равно обрамляется', () => {
    expect(csvField('=HYPERLINK("a","b")')).toBe('"\'=HYPERLINK(""a"",""b"")"');
  });
});

describe('строка и документ CSV', () => {
  it('строка склеивается запятой', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,');
  });

  it('документ начинается с BOM и заканчивается переводом строки', () => {
    const csv = csvDocument(['URL', 'title'], [['/otkrytki/a', 'Открытка']]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.endsWith(CSV_EOL)).toBe(true);
    expect(csv.slice(CSV_BOM.length)).toBe(
      `URL,title${CSV_EOL}/otkrytki/a,Открытка${CSV_EOL}`,
    );
  });

  it('документ без строк — это только заголовки', () => {
    expect(csvDocument(['URL'], [])).toBe(`${CSV_BOM}URL${CSV_EOL}`);
  });
});
