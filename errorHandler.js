// errorHandler.js — централизованный обработчик ошибок с интеграцией winston
const { botLogger } = require('./utils/logger');

// Паттерны, которые считаем «ожидаемыми» сбоями — они идут в warn, а не в error.
// Всё, что не подходит ни под один паттерн, считается настоящей ошибкой.
// Классифицируем ТОЛЬКО по error.message (короткая, осмысленная строка),
// а не по stack — иначе результат будет случайным.
const WARN_PATTERNS = [
  'timeout',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  '429',
  'Too Many Requests',
  'socket hang up',
  'request to', // axios: "Request failed with status code 4xx/5xx"
  'status code 4',
  'status code 5'
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

  // Извлекаем короткое сообщение и стек отдельно.
  // error.message может содержать \n — это допустимо в логах, но не для классификации.
  let shortMessage;
  let stack;

  if (error instanceof Error) {
    shortMessage = error.message || String(error);
    stack = error.stack || null;
  } else {
    shortMessage = String(error);
    stack = null;
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

  // Собираем финальное сообщение.
  // Префикс [context] — гарантирует, что контекст попадёт в лог даже если
  // winston-формат в utils/logger.js не читает поле context.
  const prefixedMessage = context ? `[${context}] ${shortMessage}` : shortMessage;

  // Отправляем в winston. Поля context и stack сохраняем отдельно —
  // winston запишет их, если формат это поддерживает; иначе они будут проигнорированы,
  // но prefix в message не даст потерять контекст.
  const payload = {
    level: determinedLevel,
    message: prefixedMessage,
    context: context || undefined
  };
  if (stack) payload.stack = stack;

  botLogger.log(payload);
}

module.exports = { handleError };