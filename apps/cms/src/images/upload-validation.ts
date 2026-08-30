/**
 * Приём файла: тип, размер, минимальная ширина (задача Э2-05).
 *
 * Все три проверки идут ДО генерации производных и до обращения к хранилищу.
 * Порядок не косметика: sharp декодирует изображение целиком, поэтому мусорный
 * или заведомо мелкий файл обязан отклоняться по метаданным, а не после работы
 * пайплайна.
 *
 * Про минимальную ширину отдельно. Порог 640 px (решение Ч-09 и блок 5 п. 2)
 * проверяется здесь по метаданным Payload, а внутри `generateDerivatives` — по
 * ОРИЕНТИРОВАННОЙ ширине из sharp. Две проверки не дублируют друг друга:
 * метаданные Payload могут быть получены без учёта тега EXIF Orientation, и у
 * повёрнутого кадра 400x800 видимая ширина равна 800. Поэтому ранняя проверка
 * сознательно берёт БОЛЬШУЮ сторону: она обязана не отклонить законный файл, а
 * окончательное решение принимает пайплайн, который ориентацию уже применил.
 * Обратный порядок (проверять `width`) отклонял бы правильные портретные
 * исходники с EXIF-поворотом — то есть был бы не строже, а просто неверен.
 */
import { MIN_SOURCE_IMAGE_WIDTH, assertSourceImageWidth } from '@otkritka/images';

/**
 * Принимаемые типы. Набор совпадает с тем, что понимает пайплайн, и закрыт.
 *
 * SVG отсутствует намеренно: у вектора нет ширины в пикселях для `srcset`, нет
 * осмысленного pHash (дедупликация по нему не работает), зато есть исполняемое
 * содержимое. GIF отсутствует потому, что анимация в каталог открыток не идёт, а
 * первый кадр — это уже другое изображение, чем загрузил редактор.
 */
export const ACCEPTED_IMAGE_MIME_TYPES: readonly string[] = Object.freeze([
  'image/avif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Предел размера загружаемого файла — **25 МиБ**.
 *
 * ПРОВЕНАНС ЗНАЧЕНИЯ: выбор агента, не решение человека (кандидат в реестр
 * решений вместе с `MAX_BATCH_SELECTION`, `SIMILARITY_SCAN_LIMITS` и диапазоном
 * года в slug). Человеком задано только то, что предел нужен: ТЗ §6.1 требует
 * отклонять неподходящий исходник до обращения к хранилищу.
 *
 * Константа, а не параметр окружения: это защита от заведомо неподходящего
 * входа, а не настройка качества. Величина взята с запасом к реальным исходникам
 * генерации (обычно единицы мегабайт) и заведомо ниже того, на чём процесс
 * начинает упираться в память при декодировании.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;

export interface UploadCandidate {
  readonly byteSize: number;
  /** Высота из метаданных; `null`, если Payload её не определил. */
  readonly declaredHeight: number | null | undefined;
  /** Ширина из метаданных; `null`, если Payload её не определил. */
  readonly declaredWidth: number | null | undefined;
  readonly mimeType: string;
}

/**
 * Проверяет файл до запуска пайплайна.
 *
 * @throws Error с текстом для редактора: сообщение доходит до внешнего клиента
 *   дословно (см. `toApiError` в `content-hooks.ts`), поэтому в нём названы и
 *   причина, и допустимые значения.
 */
export function assertAcceptedUpload(candidate: UploadCandidate): void {
  const mimeType = candidate.mimeType.trim().toLowerCase();

  if (!ACCEPTED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new Error(
      `Тип файла «${candidate.mimeType}» не принимается. Допустимы только ` +
        `${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}: пайплайн делает из исходника AVIF/WebP/JPEG ` +
        'и считает перцептивный хеш, а вектор и анимация ни для того, ни для другого не годятся.',
    );
  }

  if (!Number.isInteger(candidate.byteSize) || candidate.byteSize <= 0) {
    throw new Error(
      `Размер файла «${String(candidate.byteSize)}» байт недопустим: пустой или неизвестный ` +
        'по размеру файл в пайплайн не идёт.',
    );
  }

  if (candidate.byteSize > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Файл весит ${(candidate.byteSize / MEGABYTE).toFixed(1)} МиБ, предел — ` +
        `${String(MAX_UPLOAD_BYTES / MEGABYTE)} МиБ. Такой исходник для страницы открытки ` +
        'избыточен: производные всё равно строятся до 1920 px по ширине.',
    );
  }

  // Ранняя проверка порога 640 px — по большей стороне (см. докстринг модуля).
  const largestSide = Math.max(candidate.declaredWidth ?? 0, candidate.declaredHeight ?? 0);
  if (largestSide > 0) {
    assertSourceImageWidth(Math.max(largestSide, 0));
  }
}

/** Порог из `@otkritka/images`: переэкспорт для сообщений и тестов. */
export { MIN_SOURCE_IMAGE_WIDTH };
