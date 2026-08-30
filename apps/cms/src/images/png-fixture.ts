/**
 * Синтетический PNG без внешних зависимостей — материал для тестов и смоука
 * этапа 2.
 *
 * Зачем свой кодировщик, если в репозитории есть sharp. Он есть в
 * `packages/images` и в корневых devDependencies (фикстуры `tests/unit/`), но у
 * `apps/cms` своей зависимости от sharp нет и появляться ей не за чем: CMS
 * обращается к пайплайну через `@otkritka/images`, а не кодирует изображения
 * сама. Ради двух картинок в тесте добавлять нативный модуль в приложение —
 * значит завести вторую точку, где версия sharp может разойтись с пакетом.
 * PNG-кодировщик из `node:zlib` укладывается в несколько десятков строк, даёт
 * детерминированный результат и работает и в vitest, и в `payload run`.
 *
 * Продуктовый путь этот модуль не использует: он нужен там, где требуется
 * настоящий файл изображения — то есть в проверках, а не в работе CMS.
 */
import { deflateSync } from 'node:zlib';

/**
 * Композиция узора: три структурно разные, а не одна с перестановкой.
 *
 * Различие принципиальное: `grid` — прямоугольная сетка, `rings` — радиальная
 * структура, `stripes` — диагональные полосы. Спектры DCT у них разные, поэтому
 * перцептивные хеши расходятся далеко за порог похожести (замерено: попарно 30+
 * бит при пороге 14), а сдвиг яркости внутри одной композиции даёт 4–6 бит, то
 * есть «похоже». Отсюда два разных сценария в проверках: «другая картинка» —
 * другая композиция, «визуальный дубль» — та же композиция со сдвигом.
 */
export type FixtureComposition = 'grid' | 'rings' | 'stripes';

export interface PngFixtureOptions {
  readonly composition?: FixtureComposition;
  readonly height: number;
  /** Сдвиг яркости в единицах 0..255: даёт «похожую, но не ту же» картинку. */
  readonly luminanceShift?: number;
  readonly width: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable: readonly number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function clampByte(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return Math.round(value);
}

/** Яркость пикселя: сетка 4x4 плашек или концентрические кольца. */
function luminance(
  x: number,
  y: number,
  width: number,
  height: number,
  composition: FixtureComposition,
): number {
  const texture = ((x >> 2) + (y >> 2)) % 2 === 0 ? 8 : -8;

  if (composition === 'grid') {
    const column = Math.floor((x / width) * 4);
    const row = Math.floor((y / height) * 4);
    const tiles = [20, 210, 60, 180, 150, 35, 235, 90, 75, 120, 15, 200, 245, 55, 165, 105];
    return (tiles[row * 4 + column] ?? 128) + texture;
  }

  if (composition === 'stripes') {
    const period = Math.max(width, height) / 9;
    return 128 + 110 * Math.sin(((x + y) / period) * Math.PI) + texture;
  }

  const dx = x - width / 2;
  const dy = y - height / 2;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const period = Math.max(width, height) / 6;
  return 128 + 110 * Math.sin((radius / period) * Math.PI) + texture;
}

/**
 * PNG 8 бит на канал, truecolor. Содержимое зависит только от аргументов,
 * поэтому pHash и ревизия одного набора аргументов воспроизводимы между
 * прогонами.
 */
export function createPngFixture(options: PngFixtureOptions): Buffer {
  const { height, width } = options;
  const composition = options.composition ?? 'grid';
  const shift = options.luminanceShift ?? 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // фильтр строки: none
    for (let x = 0; x < width; x += 1) {
      const value = clampByte(luminance(x, y, width, height, composition) + shift);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = value;
      raw[offset + 1] = clampByte(value * 0.85);
      raw[offset + 2] = clampByte(value * 0.7);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // truecolor
  header[10] = 0; // сжатие: deflate
  header[11] = 0; // фильтрация: адаптивная
  header[12] = 0; // без интерлейса

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
