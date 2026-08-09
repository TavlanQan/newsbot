const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const { registerHandlers } = require('./handlers');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map();
const isForwardingActive = { value: false };

// ---------- Инициализация БД (создание таблиц) ----------
async function initDatabase() {
  const sqlite3 = require('sqlite3').verbose();
  const dbFile = config.DB_PATH || './news_bot.db';
  const dbLocal = new sqlite3.Database(dbFile);
  dbLocal.run('PRAGMA journal_mode = WAL;');

  const queries = [
    `CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        subscription_end INTEGER,
        is_admin INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );`,
    `CREATE TABLE IF NOT EXISTS keywords (
        user_id INTEGER,
        keyword TEXT,
        PRIMARY KEY (user_id, keyword)
    );`,
    `CREATE TABLE IF NOT EXISTS monitored_channels (
        user_id INTEGER,
        channel_id TEXT,
        channel_username TEXT,
        channel_title TEXT,
        PRIMARY KEY (user_id, channel_id)
    );`,
    `CREATE TABLE IF NOT EXISTS target_channels (
        user_id INTEGER,
        channel_id TEXT,
        channel_username TEXT,
        channel_title TEXT,
        PRIMARY KEY (user_id, channel_id)
    );`,
    `CREATE TABLE IF NOT EXISTS user_feeds (
        user_id INTEGER,
        feed_url TEXT,
        PRIMARY KEY (user_id, feed_url)
    );`,
    `CREATE TABLE IF NOT EXISTS forwarded_messages (
        message_id INTEGER,
        channel_id TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (message_id, channel_id)
    );`
  ];

  for (const sql of queries) {
    await new Promise((resolve, reject) => {
      dbLocal.run(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  dbLocal.close((err) => {
    if (err) botLogger.error(`Ошибка закрытия БД: ${err.message}`);
    else botLogger.info('✅ База данных инициализирована (таблицы созданы)');
  });
}

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

// Очистка устаревших состояний (каждые 5 минут)
setInterval(() => {
  const now = Date.now();
  let clearedCount = 0;
  for (const [userId, stateData] of userStates.entries()) {
    const timestamp = stateData.timestamp || stateData;
    if (now - timestamp > 30 * 60 * 1000) {
      userStates.delete(userId);
      clearedCount++;
    }
  }
  if (clearedCount > 0) {
    botLogger.info(`🧹 Очищено ${clearedCount} устаревших состояний пользователей`);
  }
}, 5 * 60 * 1000);

// Регистрируем все обработчики
registerHandlers({ bot, userStates, isForwardingActive });

// ---------- Запуск бота ----------
async function startBot() {
  try {
    botLogger.info('🚀 Запуск бота...');
    await initDatabase();

    await bot.launch();
    botLogger.info('✅ Бот запущен и готов к работе.');

    const intervalMinutes = config.RSS_UPDATE_INTERVAL || 10;
    cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
      if (isForwardingActive.value) {
        botLogger.info('🔄 Периодическая проверка RSS...');
        await newsService.checkAllFeeds(bot);
      } else {
        botLogger.info('⏸️ Мониторинг остановлен, RSS не проверяется');
      }
    });

    setTimeout(async () => {
      if (isForwardingActive.value) {
        botLogger.info('🔄 Первая проверка RSS после запуска...');
        await newsService.checkAllFeeds(bot);
      }
    }, 5000);

    botLogger.info(`✅ Мониторинг RSS настроен с интервалом ${intervalMinutes} мин`);
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: startBot (outer)');
    botLogger.error('❌ Критическая ошибка при запуске бота. Завершаем работу.');
    process.exit(1);
  }
}

// Глобальные обработчики ошибок
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