/**
 * Перцептивный хеш (pHash) и сравнение с порогом — ТЗ §6.4, §8.3.2.
 *
 * Разделение обязанностей, которое здесь принципиально:
 *   - РАСЧЁТ хеша работает всегда и ничего не требует от конфигурации;
 *   - СРАВНЕНИЕ с порогом требует `PHASH_DISTANCE_THRESHOLD` и без него
 *     отказывает: числа в источниках нет (Ч-08 открыт), а догаданный порог
 *     решал бы за редактора, что считать дублем. Дедупликация по ТЗ
 *     предупреждает человека, а не удаляет и не блокирует сама.
 *
 * Круг поиска задан ТЗ §6 п.4: похожие ищутся среди ОПУБЛИКОВАННЫХ И
 * находящихся в `review`. Сузить его до одних опубликованных нельзя — тогда два
 * похожих черновика доходят до публикации, не увидев друг друга. Сам отбор
 * кандидатов делает вызывающий код (Э2-05): пакет не знает про статусы.
 *
 * Алгоритм — классический DCT-pHash: серый кадр 32x32, двумерное DCT,
 * низкочастотный блок 8x8, сравнение каждого коэффициента с медианой блока
 * (медиана считается без DC-коэффициента, иначе он перетягивает её на себя).
 * Отсюда устойчивость к смене формата контейнера, сжатию, масштабу и
 * умеренному изменению яркости.
 */
import sharp from 'sharp';
import {
  type ImagesEnv,
  PHASH_BITS,
  resolvePhashDistanceThreshold,
} from './config.js';
import { type ImageSource, readSource } from './source.js';

/** Сторона кадра, с которого считается DCT. */
const SAMPLE_SIDE = 32;
/** Сторона низкочастотного блока: 8x8 = PHASH_BITS бит. */
const HASH_SIDE = 8;
const HEX_LENGTH = PHASH_BITS / 4;
const PHASH_PATTERN = /^[0-9a-f]+$/i;

const cosineTable: readonly Float64Array[] = buildCosineTable(SAMPLE_SIDE);

function buildCosineTable(size: number): readonly Float64Array[] {
  const table: Float64Array[] = [];
  for (let u = 0; u < size; u += 1) {
    const row = new Float64Array(size);
    for (let x = 0; x < size; x += 1) {
      row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
    }
    table.push(row);
  }
  return table;
}

function cosine(u: number, x: number): number {
  return cosineTable[u]?.[x] ?? 0;
}

/** DCT-II по строкам, затем по столбцам; масштабные множители не нужны — сравниваются знаки относительно медианы. */
function dct2d(pixels: Float64Array, size: number): Float64Array {
  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let u = 0; u < size; u += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        sum += (pixels[y * size + x] ?? 0) * cosine(u, x);
      }
      rows[y * size + u] = sum;
    }
  }

  const result = new Float64Array(size * size);
  for (let u = 0; u < size; u += 1) {
    for (let v = 0; v < size; v += 1) {
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        sum += (rows[y * size + u] ?? 0) * cosine(v, y);
      }
      result[v * size + u] = sum;
    }
  }

  return result;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function toHex(bits: readonly boolean[]): string {
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    let nibble = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      nibble = (nibble << 1) | (bits[index + offset] === true ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Хеш изображения: 16 шестнадцатеричных символов (64 бита).
 * Детерминирован — одно и то же содержимое всегда даёт одну и ту же строку.
 */
export async function computePerceptualHash(source: ImageSource): Promise<string> {
  const input = await readSource(source);

  const { data, info } = await sharp(input, { autoOrient: true })
    // autoOrient — обязательное условие того, что хеш описывает то, что видит
    // человек: копия с EXIF-поворотом и копия с запечённым поворотом обязаны
    // дать один хеш, иначе повёрнутый дубль пройдёт проверку на похожесть.
    //
    // fastShrinkOnLoad: false — обязательное условие независимости хеша от
    // формата контейнера. Ускоренное уменьшение при декодировании доступно
    // только JPEG и WebP, поэтому с ним одно и то же содержимое в PNG и в WebP
    // даёт разные пиксели кадра 32x32 и, как следствие, разные хеши.
    .resize(SAMPLE_SIDE, SAMPLE_SIDE, {
      fit: 'fill',
      kernel: 'lanczos3',
      fastShrinkOnLoad: false,
    })
    // Прозрачность приводится к белому фону: иначе хеш зависел бы от того, что
    // окажется под альфа-каналом.
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const pixels = new Float64Array(SAMPLE_SIDE * SAMPLE_SIDE);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = data[index * channels] ?? 0;
  }

  const coefficients = dct2d(pixels, SAMPLE_SIDE);
  const block: number[] = [];
  for (let v = 0; v < HASH_SIDE; v += 1) {
    for (let u = 0; u < HASH_SIDE; u += 1) {
      block.push(coefficients[v * SAMPLE_SIDE + u] ?? 0);
    }
  }

  // Медиана без DC-коэффициента (block[0]): он отражает общую яркость кадра.
  const threshold = median(block.slice(1));
  return toHex(block.map((value) => value > threshold));
}

function assertPerceptualHash(value: string, argument: string): void {
  if (value.length !== HEX_LENGTH || !PHASH_PATTERN.test(value)) {
    throw new Error(
      `Значение «${value}» (${argument}) не является pHash: ожидается ${String(HEX_LENGTH)} ` +
        'шестнадцатеричных символов.',
    );
  }
}

/** Расстояние Хэмминга в битах: 0 — идентичные хеши, PHASH_BITS — полностью противоположные. */
export function hammingDistance(left: string, right: string): number {
  assertPerceptualHash(left, 'left');
  assertPerceptualHash(right, 'right');

  let distance = 0;
  for (let index = 0; index < HEX_LENGTH; index += 1) {
    const difference =
      Number.parseInt(left[index] ?? '0', 16) ^ Number.parseInt(right[index] ?? '0', 16);
    for (let bit = 0; bit < 4; bit += 1) {
      if ((difference & (1 << bit)) !== 0) {
        distance += 1;
      }
    }
  }
  return distance;
}

export interface PerceptualHashThresholdOptions {
  /** Явный порог: важнее окружения. Нужен тестам и разовым прогонам. */
  readonly threshold?: number;
  /** Срез окружения для чтения `PHASH_DISTANCE_THRESHOLD`. */
  readonly env?: ImagesEnv;
}

function resolveThreshold(options: PerceptualHashThresholdOptions): number {
  const explicit = options.threshold;
  if (explicit === undefined) {
    return resolvePhashDistanceThreshold(options.env);
  }
  if (!Number.isInteger(explicit) || explicit < 0 || explicit > PHASH_BITS) {
    throw new Error(
      `Порог pHash должен быть целым числом от 0 до ${String(PHASH_BITS)}, получено: ${String(explicit)}.`,
    );
  }
  return explicit;
}

export interface PerceptualHashComparison {
  readonly distance: number;
  /** Порог, по которому вынесен вердикт: попадает в предупреждение редактору. */
  readonly threshold: number;
  /** Вердикт «похоже» — повод предупредить человека, а не удалять или блокировать. */
  readonly similar: boolean;
}

export function comparePerceptualHashes(
  left: string,
  right: string,
  options: PerceptualHashThresholdOptions = {},
): PerceptualHashComparison {
  const threshold = resolveThreshold(options);
  const distance = hammingDistance(left, right);
  return { distance, threshold, similar: distance <= threshold };
}

export interface PerceptualHashCandidate {
  /** Идентификатор записи, которой принадлежит хеш (карточка открытки). */
  readonly id: string;
  readonly hash: string;
}

export interface PerceptualHashMatch extends PerceptualHashCandidate {
  readonly distance: number;
}

/**
 * Похожие кандидаты в порядке возрастания расстояния. Отбор — материал для
 * предупреждения редактору: решение о дубле принимает человек.
 */
export function findSimilarPerceptualHashes(
  hash: string,
  candidates: readonly PerceptualHashCandidate[],
  options: PerceptualHashThresholdOptions = {},
): readonly PerceptualHashMatch[] {
  const threshold = resolveThreshold(options);
  assertPerceptualHash(hash, 'hash');

  return candidates
    .map((candidate) => ({ ...candidate, distance: hammingDistance(hash, candidate.hash) }))
    .filter((candidate) => candidate.distance <= threshold)
    .sort((left, right) => {
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      // Тай-брейк по кодовым точкам, а не localeCompare: результат не должен
      // зависеть от локали и сборки ICU — модуль обещает детерминизм.
      if (left.id === right.id) {
        return 0;
      }
      return left.id < right.id ? -1 : 1;
    });
}
