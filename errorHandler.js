// errorHandler.js — централизованный обработчик ошибок с интеграцией winston
const { botLogger } = require('./utils/logger');

/**
 * Централизованная обработка ошибок
 * @param {Error|string} error - объект ошибки или сообщение
 * @param {string} context - описание контекста (например, 'bot: start')
 * @param {string} level - уровень ('error', 'warn', 'info', 'debug') – если не указан, определяется автоматически
 */
function handleError(error, context = '', level = null) {
  if (!error) return;

  const message = error instanceof Error ? error.stack || error.message : String(error);

  // Определяем уровень, если не передан явно
  let determinedLevel = level ? level.toLowerCase() : 'error';
  
  if (!level) {
    // Автоматическая классификация по тексту
    if (message.includes('SQL') || message.includes('database')) {
      determinedLevel = 'error';
    } else if (message.includes('timeout') || message.includes('network')) {
      determinedLevel = 'warn';
    } else if (message.includes('not found') || message.includes('undefined')) {
      determinedLevel = 'error';
    } else {
      determinedLevel = 'info';
    }
  }

  // Убеждаемся, что уровень допустим для winston
  const validLevels = ['error', 'warn', 'info', 'debug'];
  if (!validLevels.includes(determinedLevel)) {
    determinedLevel = 'error';
  }

  // Логируем через winston (запись попадёт в bot.log и errors.log)
  botLogger.log({
    level: determinedLevel,
    message: message,
    context: context
  });

  // Если уровень критический, можно добавить уведомление (реализуется позже)
  if (determinedLevel === 'error' && message.includes('CRITICAL')) {
    // например, отправить алерт администратору
    botLogger.error(`⚠️ CRITICAL ERROR: ${message}`, { context });
  }
}

module.exports = { handleError };