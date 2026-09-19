// errorHandler.js — централизованный обработчик ошибок с интеграцией winston
const { botLogger } = require('./utils/logger');

// Паттерны, которые считаем «ожидаемыми» сбоями — они идут в warn, а не в error.
// Всё, что не подходит ни под один паттерн, считается настоящей ошибкой.
//
// Классифицируем ТОЛЬКО по error.message (короткая, осмысленная строка),
// а не по stack — иначе результат будет случайным.
//
// ВАЖНО: список намеренно узкий. Каждый паттерн должен быть специфичным.
// Если добавить голое '429' — оно сматчит "line 429", "user 429123",
// "429 items failed" и любой другой текст с этой подстрокой. Аналогично
// 'status code 4' ловит 400/401/403/404 — а это чаще всего реальные баги
// (неверный chat_id, отозванный токен, удалённый канал), которые
// должны попадать в error, а не в warn.
const WARN_PATTERNS = [
  // Сетевые — обычно временные
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  // Rate limit — ожидаемо и восстановимо
  'status code 429',
  'HTTP 429',
  'Too Many Requests',
  // 5xx удалённых серверов — временные (Telegram, микросервисы).
  // Регистр разный у разных клиентов: axios/rss-parser отдают "Status code 5xx".
  'status code 5',
  'Status code 5',
  // Умышленно НЕ включены (слишком широкие):
  //   '429'           — ловит любое вхождение числа
  //   'status code 4' — ловит 400/401/403/404, это реальные ошибки
  //   'request to'    — ловит любой axios-fail, включая 4xx
  //   'timeout'       — слишком общее; ETIMEDOUT покрывает таймауты соединения
];

function isWarnLevel(message) {
  if (!message) return false;
  return WARN_PATTERNS.some((p) => message.includes(p));
}

/**
 * Централизованная обработка ошибок.
 *
 * @param {Error|string} error     - объект ошибки или сообщение
 * @param {string}       context   - контекст (например, 'bot.js: startBot')
 * @param {string|null}  level     - явный уровень ('error' | 'warn' | 'info' | 'debug').
 *                                   Если не указан — определяется автоматически.
 */
function handleError(error, context = '', level = null) {
  if (!error) return;

  // Извлекаем короткое сообщение отдельно от объекта Error.
  // error.message может содержать \n — это допустимо в логах, но не для классификации.
  let shortMessage;
  let errorObject = null;

  if (error instanceof Error) {
    shortMessage = error.message || String(error);
    errorObject = error;
  } else {
    shortMessage = String(error);
  }

  // Определяем уровень.
  // По умолчанию — 'error' (безопаснее: непонятное всегда уходит в errors.log).
  // Явный level побеждает. Автоклассификация срабатывает только если level не задан.
  let determinedLevel;
  if (level) {
    determinedLevel = String(level).toLowerCase();
  } else if (isWarnLevel(shortMessage)) {
    determinedLevel = 'warn';
  } else {
    determinedLevel = 'error';
  }

  const validLevels = ['error', 'warn', 'info', 'debug'];
  if (!validLevels.includes(determinedLevel)) {
    determinedLevel = 'error';
  }

  // Префикс контекста — в message, а НЕ в поле {context}.
  // Поле {context} перебивает defaultMeta логгера и теряет метку модуля
  // ([BOT] / [RSS] / [DB]). Наш printf в utils/logger.js рендерит
  // info.context как есть, поэтому передавать туда context не нужно —
  // см. комментарий в createLogger().
  const prefixedMessage = context ? `[${context}] ${shortMessage}` : shortMessage;

  // Передаём Error-объект отдельным полем — winston.format.errors({stack:true})
  // корректно извлечёт .stack и добавит его к логу. Если передавать stack
  // строкой в payload.stack, формат его проигнорирует (он ищет Error),
  // и стек попадёт в лог только потому, что printf рендерит info.stack как есть.
  // Явный Error надёжнее и не сломается при рефакторинге формата.
  const payload = {
    level: determinedLevel,
    message: prefixedMessage,
  };
  if (errorObject) {
    payload.error = errorObject;
  }

  botLogger.log(payload);
}

module.exports = { handleError };