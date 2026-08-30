/**
 * Чистое ядро ограничения частоты (задача Э6-03, решение Ч-14).
 *
 * Здесь нет ни HTTP, ни Payload, ни `Date.now()`: время — аргумент. Иначе
 * проверить «через минуту пополнилось ровно на 60» можно было бы только
 * ожиданием в минуту, и такой тест либо не пишут, либо он делает прогон
 * непереносимым.
 */
import { describe, expect, it } from 'vitest';

import {
  type TokenBucketSettings,
  consumeToken,
  createRateLimitStore,
  fullBucket,
  refillBucket,
} from './token-bucket';

/** Значения Ч-14: 60 запросов в минуту на ключ, всплеск 120, окно 60 с. */
const CH14: TokenBucketSettings = {
  capacity: 120,
  refillTokens: 60,
  refillWindowMs: 60_000,
};

const START = 1_700_000_000_000;

/** Сколько запросов подряд пропустит бакет, начиная с состояния `state`. */
function drain(
  state: ReturnType<typeof fullBucket>,
  settings: TokenBucketSettings,
  nowMs: number,
): { readonly passed: number; readonly state: ReturnType<typeof fullBucket> } {
  let current = state;
  let passed = 0;
  for (let attempt = 0; attempt < settings.capacity + 10; attempt += 1) {
    const step = consumeToken(current, settings, nowMs);
    if (!step.decision.allowed) {
      // Состояние отказавшего шага НЕ забирается: он поднимает признак
      // `limited`, и тест про «первый отказ в эпизоде» проверял бы тогда
      // продолжение чужого эпизода.
      break;
    }
    current = step.next;
    passed += 1;
  }
  return { passed, state: current };
}

describe('Э6-03: токен-бакет', () => {
  it('всплеск равен ёмкости: 120 запросов в один момент проходят, 121-й — нет', () => {
    const { passed, state } = drain(fullBucket(CH14, START), CH14, START);

    expect(passed).toBe(120);
    // Следующая попытка в тот же момент времени отказывается, и отказ приходит с
    // указанием, когда повторять: решение без `Retry-After` предлагало бы клиенту
    // ровно то поведение, из-за которого он и получил отказ.
    const denied = consumeToken(state, CH14, START);
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('устойчивая скорость — ровно квота за окно: пустой бакет за минуту пропускает 60', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;

    // Ровно окно спустя: пополнение — 60 токенов, не 61 и не 59.
    const afterWindow = drain(emptied, CH14, START + CH14.refillWindowMs);
    expect(afterWindow.passed).toBe(60);
  });

  it('пополнение не превышает ёмкость, сколько бы ключ ни молчал', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;

    // Сутки простоя. Без потолка накопилось бы 86 400 токенов, и первый же
    // всплеск после паузы прошёл бы весь целиком: ограничение перестало бы
    // существовать ровно для того клиента, который дольше всех молчал.
    const idle = refillBucket(emptied, CH14, START + 24 * 60 * 60 * 1000);
    expect(idle.tokens).toBe(CH14.capacity);
  });

  it('Retry-After — целые секунды и никогда не ноль', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;
    const denied = consumeToken(emptied, CH14, START);

    expect(denied.decision.allowed).toBe(false);
    expect(Number.isInteger(denied.decision.retryAfterSeconds)).toBe(true);
    // При 60 токенах в минуту токен появляется раз в секунду.
    expect(denied.decision.retryAfterSeconds).toBe(1);

    // Медленное пополнение: один токен в 10 с — клиенту сообщается 10, а не 1.
    const slow: TokenBucketSettings = { capacity: 5, refillTokens: 6, refillWindowMs: 60_000 };
    const slowEmpty = drain(fullBucket(slow, START), slow, START).state;
    expect(consumeToken(slowEmpty, slow, START).decision.retryAfterSeconds).toBe(10);
  });

  it('Retry-After округляется ВВЕРХ: ответ 0 означал бы «повторяй немедленно»', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;

    // 900 мс из нужной секунды уже прошли — до токена осталось 100 мс.
    const denied = consumeToken(emptied, CH14, START + 900);
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.retryAfterSeconds).toBe(1);
  });

  it('часы, ушедшие назад, не замораживают пополнение', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;

    // Системное время прыгнуло на час назад (перевод часов, синхронизация NTP).
    const backwards = refillBucket(emptied, CH14, START - 60 * 60 * 1000);
    expect(backwards.tokens).toBe(0);
    // Отметка времени переставлена на текущее, поэтому следующая секунда уже
    // считается от него: иначе ключ был бы заблокирован на весь час прыжка.
    expect(backwards.updatedAtMs).toBe(START - 60 * 60 * 1000);
    expect(refillBucket(backwards, CH14, START - 60 * 60 * 1000 + 1000).tokens).toBe(1);
  });

  it('признак firstDenial поднимается один раз на эпизод, а не на каждый отказ', () => {
    const emptied = drain(fullBucket(CH14, START), CH14, START).state;

    const first = consumeToken(emptied, CH14, START);
    expect(first.decision.firstDenial).toBe(true);

    const second = consumeToken(first.next, CH14, START);
    expect(second.decision.allowed).toBe(false);
    expect(second.decision.firstDenial).toBe(false);

    // Пополнились — эпизод закончился; следующий отказ снова первый.
    const recovered = consumeToken(second.next, CH14, START + 1000);
    expect(recovered.decision.allowed).toBe(true);
    const denialAgain = consumeToken(recovered.next, CH14, START + 1000);
    expect(denialAgain.decision.allowed).toBe(false);
    expect(denialAgain.decision.firstDenial).toBe(true);
  });
});

describe('Э6-03: хранилище бакетов', () => {
  it('у каждого ключа свой счёт', () => {
    const store = createRateLimitStore({ maxKeys: 10, settings: CH14 });

    for (let request = 0; request < CH14.capacity; request += 1) {
      expect(store.consume('первый', START).allowed).toBe(true);
    }
    expect(store.consume('первый', START).allowed).toBe(false);
    // Второй ключ не пострадал: лимит «на ключ», а не на процесс.
    expect(store.consume('второй', START).allowed).toBe(true);
  });

  it('размер ограничен: поток неизвестных ключей не съедает память', () => {
    const store = createRateLimitStore({ maxKeys: 50, settings: CH14 });

    for (let key = 0; key < 5000; key += 1) {
      store.consume(`ключ-${String(key)}`, START);
    }

    expect(store.size()).toBeLessThanOrEqual(50);
  });

  it('вытесняется самый полный бакет, а не текущий нарушитель', () => {
    const store = createRateLimitStore({ maxKeys: 3, settings: CH14 });

    // Нарушитель выбирает всю ёмкость и попадает под отказ.
    for (let request = 0; request < CH14.capacity; request += 1) {
      store.consume('нарушитель', START);
    }
    expect(store.consume('нарушитель', START).allowed).toBe(false);

    // Поток чужих ключей в тот же момент времени переполняет хранилище.
    for (let key = 0; key < 20; key += 1) {
      store.consume(`шум-${String(key)}`, START);
    }

    // Нарушитель обращался последним из «старых», но чаще всех — и его бакет
    // пуст, то есть несёт информацию. Вытеснение пустого бакета выдало бы
    // нарушителю новую полную ёмкость, то есть сняло бы ограничение потоком
    // мусорных ключей — ровно тем, от чего хранилище и ограничивают.
    expect(store.consume('нарушитель', START).allowed).toBe(false);
  });

  it('полные бакеты убираются сами: они неотличимы от отсутствующих', () => {
    const store = createRateLimitStore({ maxKeys: 100, settings: CH14 });

    for (let key = 0; key < 20; key += 1) {
      store.consume(`ключ-${String(key)}`, START);
    }
    expect(store.size()).toBe(20);

    // Проходит время, за которое любой бакет успевает пополниться до потолка.
    const later = START + (CH14.capacity * CH14.refillWindowMs) / CH14.refillTokens + 1;
    store.consume('свежий', later);

    // Хранилище держит только то, что несёт информацию.
    expect(store.size()).toBeLessThan(20);
  });
});
