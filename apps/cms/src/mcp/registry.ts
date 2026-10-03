/**
 * Реестр инструментов и ответы служебных методов MCP.
 *
 * Один список на весь слой: `tools/list` и `tools/call` обязаны видеть ровно
 * одинаковый набор. Два списка разошлись бы молча, и клиент получал бы
 * «инструмент не найден» на то, что ему только что предложили.
 *
 * ОПИСАНИЯ ИНСТРУМЕНТОВ НЕСУТ ПРАВИЛА ПРОЕКТА. Это не оформление: единственное,
 * что внешняя модель читает перед вызовом, — это описание, и «публикует человек»,
 * «порог 20 открыток», «год в адрес не добавляется» должны стоять там, а не
 * только в отказах. Отказ учит после ошибки, описание — до.
 */
import { toJsonSchema } from './schema';
import { CARD_TOOLS } from './tools/card-tools';
import { COLLECTION_TOOLS } from './tools/collection-tools';
import { READ_TOOLS } from './tools/read-tools';
import type { ToolDefinition } from './tools/types';
import { SUPPORTED_PROTOCOL_VERSIONS } from './protocol';

export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...READ_TOOLS,
  ...CARD_TOOLS,
  ...COLLECTION_TOOLS,
];

export const SERVER_INFO = {
  name: 'otkritka-content',
  title: 'Открытки: контент',
  version: '1.0.0',
} as const;

export function findTool(name: unknown): ToolDefinition | null {
  if (typeof name !== 'string') {
    return null;
  }
  return ALL_TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Ответ `tools/list`.
 *
 * `readOnlyHint` выставляется у читающих инструментов, и это не косметика: по
 * нему клиент решает, спрашивать ли у человека подтверждение. Инструмент без
 * подсказки клиент обязан считать пишущим — то есть забытая подсказка делает
 * чтение «опасным», а не наоборот. Безопасная сторона по умолчанию здесь и
 * выбрана.
 */
export function listToolsResult(): Record<string, unknown> {
  return {
    tools: ALL_TOOLS.map((tool) => ({
      annotations: { readOnlyHint: tool.readOnly, title: tool.title },
      description: tool.description,
      inputSchema: toJsonSchema(tool.schema),
      name: tool.name,
      title: tool.title,
    })),
  };
}

/** Ответ `server/discover` — обязателен в ревизии 2026-07-28. */
export function discoverResult(): Record<string, unknown> {
  return {
    capabilities: { tools: {} },
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    serverInfo: SERVER_INFO,
  };
}

/** Ответ legacy-рукопожатия `initialize`. */
export function initializeResult(protocolVersion: string): Record<string, unknown> {
  return {
    capabilities: { tools: {} },
    instructions:
      'Инструменты правят каталог открыток. Граница зафиксирована: записи создаются и ' +
      'правятся в статусе draft, перевод в review доступен, а публикация и открытие в ' +
      'index,follow — решение человека и через этот сервер невозможны ни одним инструментом. ' +
      'Перед наполнением темы вызывай catalog_overview, перед записью текстов — ' +
      'check_duplicates: совпадение title или meta description блокирует индексацию.',
    protocolVersion,
    serverInfo: SERVER_INFO,
  };
}
