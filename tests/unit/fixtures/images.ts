/**
 * Эталонные изображения для тестов пайплайна: генерируются программно, чтобы в
 * репозитории не лежали бинарники, а содержимое было детерминированным —
 * pHash-тесты сравнивают хеши между прогонами.
 *
 * Композиций две, и они устроены СТРУКТУРНО по-разному, а не отличаются
 * перестановкой одного и того же:
 *
 *   - `tiles` — сетка 4x4 из плашек с фиксированной яркостью. Даёт устойчивые
 *     низкочастотные коэффициенты DCT, на которых держится pHash;
 *   - `rings` — концентрические кольца от центра плюс вертикальный градиент.
 *     Спектр другой по построению: радиальная структура против прямоугольной
 *     сетки. Это и есть «другое изображение».
 *
 * Отдельно от композиций существует {@link ROTATED_180_TILE_LUMINANCE} —
 * обратный порядок плашек. Это НЕ другая композиция, а поворот той же сетки на
 * 180°, то есть визуальный дубль. Путать эти два случая нельзя: расстояние до
 * повёрнутого дубля меньше расстояния до другой картинки, и если выдать первое
 * за второе, порог похожести (Ч-08) будет выбран заниженным — реальные дубли
 * начнут проходить проверку.
 *
 * Ко всем композициям добавляется одна и та же мелкая регулярная текстура: она
 * даёт материал для потерь при JPEG-сжатии, но структуру не перебивает.
 */
import sharp, { type Sharp } from 'sharp';

/** Яркости плашек 4x4 слева-направо, сверху-вниз. */
export const BASE_TILE_LUMINANCE: readonly number[] = [
  20, 210, 60, 180, 150, 35, 235, 90, 75, 120, 15, 200, 245, 55, 165, 105,
];

/**
 * Обратный порядок плашек = поворот сетки на 180°. Тот же кадр, повёрнутый, —
 * материал для проверки устойчивости pHash к повороту, а НЕ образец «другой
 * картинки». Для другой картинки берите композицию `rings`.
 */
export const ROTATED_180_TILE_LUMINANCE: readonly number[] = [...BASE_TILE_LUMINANCE].reverse();

/** Структура узора. `tiles` — прямоугольная сетка, `rings` — радиальная. */
export type PatternComposition = 'tiles' | 'rings';

const TILES_PER_SIDE = 4;
const CHANNELS = 3;
/** Число колец на полудиагонали: столько же порядков крупности, сколько у сетки 4x4. */
const RING_PERIODS = 3;

function clampByte(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return Math.round(value);
}

/** Одинаковая для всех композиций мелкая текстура. */
function texture(x: number, y: number): number {
  return ((x * 7 + y * 13) % 17) - 8;
}

function tileLuminance(x: number, y: number, width: number, height: number, tiles: readonly number[]): number {
  const tileRow = Math.min(TILES_PER_SIDE - 1, Math.floor(y / (height / TILES_PER_SIDE)));
  const tileColumn = Math.min(TILES_PER_SIDE - 1, Math.floor(x / (width / TILES_PER_SIDE)));
  return tiles[tileRow * TILES_PER_SIDE + tileColumn] ?? 0;
}

/**
 * Концентрические кольца от центра плюс вертикальный градиент: структура,
 * которую нельзя получить из сетки плашек ни перестановкой, ни поворотом, ни
 * отражением.
 */
function ringLuminance(x: number, y: number, width: number, height: number): number {
  const dx = (x - width / 2) / (width / 2);
  const dy = (y - height / 2) / (height / 2);
  const radius = Math.sqrt(dx * dx + dy * dy);
  const rings = 0.5 + 0.5 * Math.cos(RING_PERIODS * Math.PI * radius);
  const gradient = y / height;
  return 25 + 170 * rings + 50 * gradient;
}

export interface PatternPixelOptions {
  readonly composition?: PatternComposition;
  readonly tiles?: readonly number[];
}

/** Сырые RGB-пиксели узора: детерминированы, без обращения к случайности. */
export function createPatternPixels(
  width: number,
  height: number,
  options: PatternPixelOptions = {},
): Buffer {
  const { composition = 'tiles', tiles = BASE_TILE_LUMINANCE } = options;
  const pixels = Buffer.alloc(width * height * CHANNELS);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base =
        composition === 'rings'
          ? ringLuminance(x, y, width, height)
          : tileLuminance(x, y, width, height, tiles);
      const value = clampByte(base + texture(x, y));
      const offset = (y * width + x) * CHANNELS;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }

  return pixels;
}

export interface PatternOptions extends PatternPixelOptions {
  readonly width: number;
  readonly height: number;
}

function rawPipeline(options: PatternOptions): Sharp {
  const { width, height, ...pixelOptions } = options;
  return sharp(createPatternPixels(width, height, pixelOptions), {
    raw: { width, height, channels: CHANNELS },
  });
}

export async function createPatternPng(options: PatternOptions): Promise<Buffer> {
  return rawPipeline(options).png({ compressionLevel: 6 }).toBuffer();
}

export async function createPatternJpeg(
  options: PatternOptions & { readonly quality?: number },
): Promise<Buffer> {
  const { quality = 80, ...pattern } = options;
  return rawPipeline(pattern).jpeg({ quality }).toBuffer();
}

export async function createPatternWebpLossless(options: PatternOptions): Promise<Buffer> {
  return rawPipeline(options).webp({ lossless: true }).toBuffer();
}

/**
 * JPEG с записанным тегом EXIF Orientation и НЕ повёрнутыми пикселями — так
 * отдаёт файлы камера и так их присылает редактор. Пиксели остаются
 * ландшафтными, а показывать браузер обязан повёрнутое изображение.
 */
export async function createPatternJpegWithExifOrientation(
  options: PatternOptions & { readonly orientation: number; readonly quality?: number },
): Promise<Buffer> {
  const { orientation, quality = 90, ...pattern } = options;
  return rawPipeline(pattern).withMetadata({ orientation }).jpeg({ quality }).toBuffer();
}

/**
 * Эталон «как это обязано выглядеть»: поворот запечён в пиксели, EXIF не нужен.
 * Угол соответствует тегу Orientation: 6 — на 90° по часовой, 8 — против, 3 — 180°.
 */
export async function createRotatedPatternPng(
  options: PatternOptions & { readonly angle: number },
): Promise<Buffer> {
  const { angle, ...pattern } = options;
  return rawPipeline(pattern).rotate(angle).png({ compressionLevel: 6 }).toBuffer();
}
