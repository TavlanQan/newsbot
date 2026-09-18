// bot.js
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const helpers = require('./helpers');
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
    `CREATE TABLE IF NOT EXISTS system_feeds (
        feed_url TEXT PRIMARY KEY,
        added_at INTEGER DEFAULT (strftime('%s','now'))
    );`,
    `CREATE TABLE IF NOT EXISTS forwarded_messages (
        message_id INTEGER,
        channel_id TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (message_id, channel_id)
    );`,
    `CREATE TABLE IF NOT EXISTS access_requests (
        user_id      INTEGER PRIMARY KEY,
        username     TEXT,
        first_name   TEXT,
        requested_at INTEGER DEFAULT (strftime('%s', 'now')),
        status       TEXT DEFAULT 'pending'
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

// ---------- Bootstrap главного администратора ----------
// Идемпотентно: при каждом старте гарантирует, что главный админ из .env
// существует, имеет is_admin=1 и бессрочный доступ (subscription_end=NULL).
async function bootstrapAdmins() {
  const adminIdRaw = process.env.ADMIN_CHAT_ID || config.ADMIN_CHAT_ID;
  const adminId = parseInt(adminIdRaw, 10);

  if (!adminIdRaw || isNaN(adminId)) {
    botLogger.error(
      '❌ ADMIN_CHAT_ID не задан (или не число) — главный администратор не будет создан.\n' +
      '   Управление админами и выдача доступов будут недоступны.'
    );
    return;
  }

  try {
    const existing = await db.getUser(adminId);

    if (!existing) {
      await db.addUser(adminId, true, null);
      botLogger.info(`👑 Создан главный администратор ${adminId} (бессрочный доступ)`);
      return;
    }

    if (existing.is_admin !== 1 || existing.subscription_end !== null) {
      await db.run(
        'UPDATE users SET is_admin = 1, subscription_end = NULL WHERE user_id = ?',
        [adminId]
      );
      botLogger.info(`👑 Права главного администратора для ${adminId} подтверждены`);
    } else {
      botLogger.info(`👑 Главный администратор ${adminId} уже настроен корректно`);
    }
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: bootstrapAdmins');
  }
}

// ---------- Миграция системных RSS-лент из .env в БД ----------
// Однократная и идемпотентная:
//  - если в system_feeds уже есть записи — ничего не делаем;
//  - иначе читаем RSS_FEEDS из .env и переносим в БД.
// После этого переменная RSS_FEEDS в .env больше не используется
// (можно оставить её как «архив» или удалить — на работу бота не влияет).
async function migrateSystemFeeds() {
  try {
    const existing = await db.getSystemFeeds();
    if (existing.length > 0) {
      botLogger.info(`🌐 Системные ленты уже в БД: ${existing.length} шт. Миграция не нужна.`);
      return;
    }

    const fromEnv = helpers.getSystemFeedUrls();
    if (fromEnv.length === 0) {
      botLogger.info('🌐 В .env нет RSS_FEEDS — миграция не требуется.');
      return;
    }

    let added = 0;
    for (const url of fromEnv) {
      const ok = await db.addSystemFeed(url);
      if (ok) added++;
    }
    botLogger.info(
      `🌐 Мигрировано системных лент из .env в БД: ${added}/${fromEnv.length}`
    );
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: migrateSystemFeeds');
  }
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
    await bootstrapAdmins();
    await migrateSystemFeeds();

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