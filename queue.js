// queue.js — очередь задач с retry, backpressure и graceful drain

const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const config = require('./config');

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------
const DEFAULT_DELAY_MS = 1500;         // если QUEUE_DELAY_MS не задан в .env
const MIN_DELAY_MS = 500;              // ниже — риск словить 429 от Telegram
const MAX_DELAY_MS = 5000;             // выше — бот становится неотзывчивым

const WARN_QUEUE_SIZE = 250;           // при пересечении порога снизу — warning
const MAX_QUEUE_SIZE = 1000;           // выше — новые задачи отклоняются

const MAX_ATTEMPTS = 10;               // общее число попыток (включая первую)
const MAX_CUMULATIVE_WAIT_MS = 30000;  // суммарный retry-wait на одну задачу
const DEFAULT_RETRY_AFTER_MS = 2000;   // если Telegram не сказал retry_after
const ABORT_RETRY_AFTER_MS = 60000;    // retry_after > 60с → retry бессмыслен

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Извлекает HTTP-код из ошибки, поддерживая несколько shape'ов:
// - Telegraf TelegramError: err.response.error_code
// - axios: err.response.status
// - прочие: err.error_code / err.status / err.statusCode
function getHttpStatus(err) {
  if (!err) return null;
  return (
    err?.response?.error_code ??
    err?.response?.status ??
    err?.error_code ??
    err?.status ??
    err?.statusCode ??
    null
  );
}

// Извлекает retry_after (в миллисекундах) из ошибки.
// Telegram для 429 кладёт секунды в response.parameters.retry_after.
// Дополнительно поддерживаем headers['retry-after'] (axios-стиль).
function getRetryAfterMs(err) {
  if (!err) return null;
  const raw =
    err?.response?.parameters?.retry_after ??
    err?.response?.data?.parameters?.retry_after ??
    err?.parameters?.retry_after ??
    err?.response?.headers?.['retry-after'];
  if (raw === undefined || raw === null) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function isRetriableStatus(status) {
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Очередь
// ---------------------------------------------------------------------------
class MessageQueue {
  constructor(delay) {
    this.queue = [];
    this.isProcessing = false;
    this.delay = delay;
    this.closing = false;

    // Счётчик отброшенных из-за overflow задач — для rate-limited логирования
    this._droppedCount = 0;
  }

  // Добавить задачу. Возвращает:
  //   true  — принята
  //   false — отклонена (closing или overflow)
  //
  // options.context — строка контекста для errorHandler (по умолчанию
  // 'queue.js: task execution'). Используется при окончательном провале,
  // чтобы в errors-*.log было понятно, ЧТО упало.
  add(task, options = {}) {
    if (typeof task !== 'function') {
      errorHandler.handleError(
        new Error('queue.add: переданный аргумент не является функцией'),
        'queue.js: add'
      );
      return false;
    }

    if (this.closing) {
      botLogger.warn('⚠️ queue.add после drain() — задача отклонена');
      return false;
    }

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this._droppedCount += 1;
      // Rate-limited логирование: первое падение + каждое 100-е
      if (this._droppedCount === 1 || this._droppedCount % 100 === 0) {
        botLogger.error(
          `❌ Очередь переполнена (${this.queue.length} ≥ ${MAX_QUEUE_SIZE}), ` +
            `задача отброшена. Всего отброшено: ${this._droppedCount}`
        );
      }
      return false;
    }

    const prevSize = this.queue.length;
    this.queue.push({
      task,
      context: options.context || 'queue.js: task execution',
      attemptsLeft: MAX_ATTEMPTS,
      cumulativeWaitMs: 0
    });

    // Warning ровно один раз при пересечении порога снизу вверх
    if (prevSize < WARN_QUEUE_SIZE && this.queue.length >= WARN_QUEUE_SIZE) {
      const etaSec = Math.round((this.queue.length * this.delay) / 1000);
      botLogger.warn(
        `⚠️ Очередь выросла до ${this.queue.length} задач (порог ${WARN_QUEUE_SIZE}). ` +
          `При задержке ${this.delay} мс это ~${etaSec} сек отставания.`
      );
    }

    // Запускаем обработку асинхронно — add() не блокирует вызывающий код
    this.process();
    return true;
  }

  // Диагностика: сколько в очереди + сколько обрабатывается.
  // ВАЖНО: раньше возвращалось число, теперь объект. Существующие вызовы
  // (если есть) надо адаптировать. В текущем коде никто не вызывает.
  getSize() {
    return {
      queued: this.queue.length,
      processing: this.isProcessing ? 1 : 0
    };
  }

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        let retried = false;

        try {
          await entry.task();
          // Успех — задача завершена, ничего больше не делаем
        } catch (err) {
          const status = getHttpStatus(err);
          const retriable = isRetriableStatus(status);

          if (retriable && entry.attemptsLeft > 1) {
            let waitMs = null;

            if (status === 429) {
              const ra = getRetryAfterMs(err);
              if (ra !== null) {
                if (ra > ABORT_RETRY_AFTER_MS) {
                  botLogger.warn(
                    `⚠️ retry_after=${Math.round(ra / 1000)}с > ` +
                      `${Math.round(ABORT_RETRY_AFTER_MS / 1000)}с — retry отменён`
                  );
                } else {
                  waitMs = ra;
                }
              } else {
                waitMs = DEFAULT_RETRY_AFTER_MS;
              }
            } else {
              // 5xx — фиксированная пауза
              waitMs = DEFAULT_RETRY_AFTER_MS;
            }

            if (waitMs !== null) {
              // Кумулятивный лимит на задачу
              if (entry.cumulativeWaitMs + waitMs > MAX_CUMULATIVE_WAIT_MS) {
                botLogger.warn(
                  `⚠️ Кумулятивный retry-wait превысил ${MAX_CUMULATIVE_WAIT_MS} мс — сдаёмся ` +
                    `(потрачено ${entry.cumulativeWaitMs} мс)`
                );
              } else {
                // Ждём, обновляем метрики, возвращаем задачу В НАЧАЛО очереди.
                // unshift — намеренно: rate-limit от Telegram глобальный,
                // пропускать вперёд другие задачи бессмысленно.
                await sleep(waitMs);
                entry.attemptsLeft -= 1;
                entry.cumulativeWaitMs += waitMs;
                this.queue.unshift(entry);
                retried = true;

                botLogger.warn(
                  `🔁 Retry ${entry.context}: status=${status}, ` +
                    `wait=${waitMs}мс, осталось попыток=${entry.attemptsLeft}, ` +
                    `суммарно ждали=${entry.cumulativeWaitMs}мс`
                );
              }
            }
          }

          if (!retried) {
            // Окончательный провал (не retriable / кончились попытки /
            // превышен кумулятивный лимит)
            errorHandler.handleError(err, entry.context);
          }
        }

        // Inter-task delay. Условия:
        // - retried=true → НЕ ждём: retry-задача уже подождала свой retry_after,
        //   дополнительная задержка дала бы двойное ожидание.
        // - очередь пуста → не ждём: нечего «разряжать».
        if (!retried && this.queue.length > 0) {
          await sleep(this.delay);
        }
      }
    } finally {
      // Защита от «залипания»: даже если что-то вылетело из while
      // (например, сам errorHandler бросит из-за сломанного logger'а) —
      // isProcessing сбросится, и следующий add() снова запустит process().
      this.isProcessing = false;
    }
  }

  // Graceful shutdown: запрещает новые add(), ждёт слива текущих задач
  // либо истечения timeoutMs. Возвращает { drained, remaining, stillProcessing }.
  //
  // ВАЖНО: если какая-то задача сейчас в retry-sleep с retry_after=30с —
  // drain может истечь раньше. Тогда drained=false, remaining=0,
  // stillProcessing=true. Задача будет потеряна при process.exit() —
  // это осознанный trade-off: ждать 30 секунд на shutdown нельзя.
  async drain(timeoutMs = 10000) {
    this.closing = true;
    const deadline = Date.now() + timeoutMs;

    // Polling — простой и достаточный. process() сам завершится,
    // когда очередь опустеет; нам нужно лишь дождаться этого.
    while ((this.isProcessing || this.queue.length > 0) && Date.now() < deadline) {
      await sleep(100);
    }

    if (this.queue.length > 0 || this.isProcessing) {
      return {
        drained: false,
        remaining: this.queue.length,
        stillProcessing: this.isProcessing
      };
    }
    return { drained: true, remaining: 0, stillProcessing: false };
  }
}

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

// Определяет задержку из config.QUEUE_DELAY_MS с клампингом [MIN, MAX].
// config.js больше НЕ клампит значение (это убирается в PR #7) — единственный
// источник правды здесь, чтобы warning о выходе за пределы был виден в логах.
function resolveDelay() {
  const fromConfig = parseInt(config.QUEUE_DELAY_MS, 10);

  if (isNaN(fromConfig) || fromConfig <= 0) {
    botLogger.info(
      `📬 QUEUE_DELAY_MS не задан в .env — использую значение по умолчанию ${DEFAULT_DELAY_MS} мс`
    );
    return DEFAULT_DELAY_MS;
  }

  if (fromConfig < MIN_DELAY_MS) {
    botLogger.warn(
      `⚠️ QUEUE_DELAY_MS=${fromConfig} < ${MIN_DELAY_MS} — поднимаю до ${MIN_DELAY_MS} мс`
    );
    return MIN_DELAY_MS;
  }

  if (fromConfig > MAX_DELAY_MS) {
    botLogger.warn(
      `⚠️ QUEUE_DELAY_MS=${fromConfig} > ${MAX_DELAY_MS} — опускаю до ${MAX_DELAY_MS} мс`
    );
    return MAX_DELAY_MS;
  }

  return fromConfig;
}

const queue = new MessageQueue(resolveDelay());
botLogger.info(`📬 Очередь сообщений инициализирована (задержка ${queue.delay} мс)`);

module.exports = queue;