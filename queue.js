// queue.js — простая очередь задач для отправки сообщений

const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const config = require('./config');

class MessageQueue {
  constructor(delay = 700) {
    this.queue = [];
    this.isProcessing = false;
    this.delay = delay; // задержка между отправками (мс)
  }

  add(task) {
    if (typeof task !== 'function') {
      errorHandler.handleError(
        new Error('queue.add: переданный аргумент не является функцией'),
        'queue.js: add'
      );
      return;
    }
    this.queue.push(task);
    // Запускаем обработку асинхронно — add() не блокирует вызывающий код
    this.process();
  }

  // Текущий размер очереди (для диагностики и логов)
  getSize() {
    return this.queue.length;
  }

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();

      try {
        await task();
      } catch (err) {
        // Финальная страховка: большинство задач внутри уже обёрнуты в try/catch,
        // но если что-то проскочит — попадёт в errors-YYYY-MM-DD.log
        errorHandler.handleError(err, 'queue.js: process (task execution)');
      }

      // Задержка нужна только если есть СЛЕДУЮЩАЯ задача.
      // После последней — не ждём, чтобы не «простаивать» впустую.
      if (this.queue.length > 0) {
        await new Promise((res) => setTimeout(res, this.delay));
      }
    }

    this.isProcessing = false;
  }
}

// Определяем задержку: приоритет — config.QUEUE_DELAY_MS, иначе 700 мс.
// Telegram допускает ~30 сообщений в секунду на бота, 700 мс даёт ~1.4 msg/s —
// с большим запасом. Слишком большие значения (> 5 сек) игнорируем,
// так как они делают бота неотзывчивым при потоке новостей.
function resolveDelay() {
  const DEFAULT_DELAY = 700;
  const MAX_REASONABLE_DELAY = 5000;

  const fromConfig = parseInt(config.QUEUE_DELAY_MS, 10);

  if (isNaN(fromConfig) || fromConfig <= 0) {
    return DEFAULT_DELAY;
  }

  if (fromConfig > MAX_REASONABLE_DELAY) {
    botLogger.warn(
      `⚠️ QUEUE_DELAY_MS=${fromConfig} мс слишком велик — использую ${DEFAULT_DELAY} мс. ` +
        `Уменьшите значение в .env, если нужна тонкая настройка.`
    );
    return DEFAULT_DELAY;
  }

  return fromConfig;
}

const queue = new MessageQueue(resolveDelay());
botLogger.info(`📬 Очередь сообщений инициализирована (задержка ${queue.delay} мс)`);

module.exports = queue;