const { Telegraf } = require('telegraf');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const queue = require('./queue');
const errorHandler = require('./errorHandler');
const { botLogger } = require('./utils/logger');
const helpers = require('./helpers');
const { registerHandlers } = require('./handlers');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map();
const isForwardingActive = { value: false };

// ---------- Функция завершения ----------
async function shutdown() {
  botLogger.info('🔴 Завершение работы бота...');
  try {
    await bot.stop();
    process.exit(0);
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: shutdown');
    process.exit(1);
  }
}

// Очистка устаревших состояний
setInterval(() => {
  const now = Date.now();
  let clearedCount = 0;
  for (const [userId, stateData] of userStates.entries()) {
    if (now - stateData.timestamp > 30 * 60 * 1000) {
      userStates.delete(userId);
      clearedCount++;
    }
  }
  if (clearedCount > 0) {
    botLogger.info(`🧹 Очищено ${clearedCount} устаревших состояний пользователей`);
  }
}, 5 * 60 * 1000);

// Регистрируем все обработчики
registerHandlers({
  bot,
  db,
  config,
  newsService,
  queue,
  errorHandler,
  logger: { botLogger },
  userStates,
  isForwardingActive,
  helpers
});

// ---------- Запуск бота ----------
async function startBot() {
  try {
    botLogger.info('🚀 Запуск бота...');
    let dbInitialized = false;
    let attempts = 0;
    while (!dbInitialized && attempts < 3) {
      try {
        await db.initializeDB();
        dbInitialized = true;
        botLogger.info('✅ База данных инициализирована');
      } catch (error) {
        attempts++;
        errorHandler.handleError(error, `bot.js: startBot (DB init attempt ${attempts})`);
        botLogger.warn(`⚠️ Попытка инициализации БД #${attempts} не удалась`);
        if (attempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    if (!dbInitialized) {
      botLogger.error('❌ Не удалось инициализировать БД после 3 попыток. Завершаем работу.');
      process.exit(1);
    }
    await newsService.initialize();
    await bot.launch();
    botLogger.info('✅ Бот запущен и готов к работе.');
    newsService.setSendFunction((msg, opts) => helpers.sendMessageToTargetChannels(bot, msg, opts));
    botLogger.info('✅ Функция отправки установлена');
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: startBot (outer)');
    botLogger.error('❌ Критическая ошибка при запуске бота. Завершаем работу.');
    process.exit(1);
  }
}

// Глобальные обработчики
process.on('unhandledRejection', (reason) => {
  errorHandler.handleError(reason, 'GLOBAL: unhandledRejection');
});
process.on('uncaughtException', (error) => {
  errorHandler.handleError(error, 'GLOBAL: uncaughtException');
  setTimeout(() => process.exit(1), 1000);
});

startBot();

process.once('SIGINT', () => {
  botLogger.info('⏹️ Остановка бота по SIGINT');
  shutdown();
});
process.once('SIGTERM', () => {
  botLogger.info('⏹️ Остановка бота по SIGTERM');
  shutdown();
});