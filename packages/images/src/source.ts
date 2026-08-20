/**
 * Чтение исходного изображения.
 *
 * Единственное место, где пайплайн касается входа. Вход всегда копируется в
 * собственный буфер: оригинал (файл в хранилище или буфер вызывающего) не
 * мутируется и не перезаписывается — оптимизированные копии живут отдельно от
 * оригиналов (ТЗ §6.1, §6.7).
 */
import { readFile } from 'node:fs/promises';

/** Источник: путь к файлу (только чтение) или буфер с содержимым. */
export type ImageSource = string | Buffer | Uint8Array;

export async function readSource(source: ImageSource): Promise<Buffer> {
  if (typeof source === 'string') {
    return readFile(source);
  }
  return Buffer.from(source);
}
