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
const sqlite3 = require('sqlite3').verbose();

// Маркер загрузки файла в PM2 stdout. Если этого лога нет после
// `pm2 restart newsbot` — значит PM2 запускает НЕ ЭТОТ файл.
console.log(`[bot.js] module loaded at ${new Date().toISOString()}, RSS_UPDATE_INTERVAL=${config.RSS_UPDATE_INTERVAL}`);

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map();

// ---------- Персистентный флаг «пересылка активна» ----------
// Значение хранится в БД (таблица settings) и восстанавливается при старте.
// `handlers.js` продолжает писать `isForwardingActive.value = true/false` —
// это работает через Proxy, запись в БД происходит прозрачно.
const DB_FILE = config.DB_PATH || './news_bot.db';

async function loadForwardingState() {
  return new Promise((resolve) => {
    const dbLocal = new sqlite3.Database(DB_FILE);
    dbLocal.get(
      `SELECT value FROM settings WHERE key = 'forwarding_active'`,
      (err, row) => {
        dbLocal.close();
        if (err) {
          botLogger.warn(`⚠️ Не удалось прочитать forwarding_active: ${err.message}. По умолчанию — ВКЛ.`);
          return resolve(true); // безопасный дефолт: лучше цикл, чем тишина
        }
        if (!row) return resolve(true); // первый запуск — включаем по умолчанию
        resolve(row.value === '1');
      }
    );
  });
}

async function saveForwardingState(value) {
  return new Promise((resolve, reject) => {
    const dbLocal = new sqlite3.Database(DB_FILE);
    dbLocal.run(
      `INSERT INTO settings (key, value) VALUES ('forwarding_active', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value ? '1' : '0'],
      (err) => {
        dbLocal.close();
        err ? reject(err) : resolve();
      }
    );
  });
}

// Proxy вместо объекта — set на .value автоматически сохраняет в БД.
const _forwardingStore = { value: true };
const isForwardingActive = new Proxy(_forwardingStore, {
  set(target, prop, value) {
    target[prop] = value;
    if (prop === 'value') {
      saveForwardingState(value).catch((e) =>
        errorHandler.handleError(e, 'bot.js: saveForwardingState')
      );
    }
    return true;
  }
});

// ---------- Инициализация БД ----------
async function initDatabase() {
  return new Promise((resolve, reject) => {
    const dbLocal = new sqlite3.Database(DB_FILE);
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
      );`,
      // Таблица для персистентного состояния бота
      `CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT
      );`,
      // ---------------------------------------------------------------
      // Дедуп отправленных RSS-записей. Заменяет in-memory lastItemsCache
      // из newsService.js: переживает рестарт, устраняет флуд при первом
      // запуске и дубли между эквивалентными фидами (один YouTube-канал,
      // два разных URL).
      // ---------------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS sent_rss_items (
          user_id   INTEGER NOT NULL,
          feed_url  TEXT    NOT NULL,
          item_link TEXT    NOT NULL,
          sent_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (user_id, item_link)
      );`,
      `CREATE INDEX IF NOT EXISTS idx_sent_rss_items_sent_at
          ON sent_rss_items(sent_at);`,
      // ---------------------------------------------------------------
      // Флаг «фид уже инициализирован для пользователя».
      // Отличает первый парсинг (сидируем без отправки, чтобы не залить
      // пользователя историей) от последующих (отправляем только новое).
      // ---------------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS feed_state (
          user_id         INTEGER NOT NULL,
          feed_url        TEXT    NOT NULL,
          first_seen_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          last_checked_at INTEGER,
          PRIMARY KEY (user_id, feed_url)
      );`
    ];

    let pending = queries.length;
    let failed = false;

    for (const sql of queries) {
      dbLocal.run(sql, (err) => {
        if (failed) return;
        if (err) {
          failed = true;
          dbLocal.close();
          return reject(err);
        }
        if (--pending === 0) {
          dbLocal.close((closeErr) => {
            if (closeErr) return reject(closeErr);
            resolve();
          });
        }
      });
    }
  });
}

// ---------- Bootstrap главного администратора ----------
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

// ---------- Миграция системных лент ----------
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

// ---------- Завершение работы ----------
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

// ---------- Периодическая очистка userStates ----------
setInterval(() => {
  const now = Date.now();
  let cleared = 0;
  for (const [userId, stateData] of userStates.entries()) {
    const ts = (stateData && typeof stateData === 'object' && stateData.timestamp)
      ? stateData.timestamp
      : (typeof stateData === 'number' ? stateData : null);
    if (ts && now - ts > 30 * 60 * 1000) {
      userStates.delete(userId);
      cleared++;
    }
  }
  if (cleared > 0) {
    botLogger.info(`🧹 Очищено ${cleared} устаревших состояний пользователей`);
  }
}, 5 * 60 * 1000);

// ---------- Основной RSS-цикл ----------
// Вынесен в отдельную функцию с явным логированием в botLogger.
// Даже если rssTransport сломан — мы увидим начало и конец цикла в bot-*.log.
async function runRssCycle(sourceLabel) {
  const active = isForwardingActive.value;
  botLogger.info(`⏰ RSS TICK [${sourceLabel}] active=${active} (${new Date().toISOString()})`);

  if (!active) {
    botLogger.info('⏸️ Мониторинг остановлен, RSS не проверяется');
    return;
  }

  const started = Date.now();
  try {
    await newsService.checkAllFeeds(bot);
    botLogger.info(`✅ RSS-цикл [${sourceLabel}] завершён за ${Date.now() - started} мс`);
  } catch (error) {
    errorHandler.handleError(error, `bot.js: runRssCycle [${sourceLabel}]`);
  }
}

// ---------- Регистрация всех обработчиков ----------
registerHandlers({ bot, userStates, isForwardingActive });

// ---------- Запуск бота ----------
async function startBot() {
  try {
    botLogger.info('🚀 Запуск бота...');

    await initDatabase();
    botLogger.info('✅ База данных инициализирована (таблицы созданы)');

    await bootstrapAdmins();
    await migrateSystemFeeds();

    // Восстановление флага пересылки из БД
    const restored = await loadForwardingState();
    isForwardingActive.value = restored;
    botLogger.info(`📌 Состояние пересылки восстановлено: ${restored ? 'ВКЛ' : 'ВЫКЛ'}`);

    // ========================================================================
    // ВАЖНО: cron регистрируется ДО bot.launch().
    // Пересылка RSS не зависит от Telegram — если Telegram API недоступен,
    // RSS-цикл всё равно должен работать. Пусть cron стартует первым.
    // ========================================================================
    const intervalMinutes = config.RSS_UPDATE_INTERVAL || 10;
    const cronExpr = `*/${intervalMinutes} * * * *`;
    cron.schedule(cronExpr, () => runRssCycle('cron'));
    botLogger.info(`✅ Мониторинг RSS настроен: cron="${cronExpr}" (интервал ${intervalMinutes} мин)`);

    // Очистка устаревших записей БД: раз в сутки в 04:00.
    // Чистим и forwarded_messages (пересылка из Telegram-каналов),
    // и sent_rss_items (дедуп RSS) — иначе обе таблицы растут бесконечно.
    cron.schedule('0 4 * * *', async () => {
      try {
        const removedFwd = await db.cleanOldForwarded(30).catch(() => 0);
        const removedSent = await db.cleanOldSentItems(30).catch(() => 0);
        botLogger.info(
          `🧹 Очистка БД: forwarded_messages удалено=${removedFwd}, sent_rss_items удалено=${removedSent}`
        );
      } catch (error) {
        errorHandler.handleError(error, 'bot.js: cron.cleanup');
      }
    });

    // ========================================================================
    // КРИТИЧЕСКИЙ ФИКС:
    // В Telegraf 4.x bot.launch() возвращает Promise, который резолвится
    // ТОЛЬКО при bot.stop(). Если поставить `await bot.launch()` — весь код
    // ниже никогда не выполнится: cron не зарегистрируется, RSS-цикл не
    // запустится, "✅ Бот запущен" не залогируется. Бот при этом отвечает
    // на кнопки, потому что Telegraf живёт своей жизнью в фоне — и именно
    // это вводило в заблуждение при диагностике.
    //
    // Правильно: НЕ await. Ошибку ловим через .catch().
    // ========================================================================
    bot.launch().catch((err) => {
      errorHandler.handleError(err, 'bot.js: bot.launch');
      process.exit(1);
    });
    botLogger.info('✅ Бот запущен и готов к работе.');

    // Первая проверка RSS через 15 секунд после запуска
    setTimeout(() => {
      runRssCycle('startup').catch((e) =>
        errorHandler.handleError(e, 'bot.js: startup runRssCycle')
      );
    }, 15000);

  } catch (error) {
    errorHandler.handleError(error, 'bot.js: startBot (outer)');
    botLogger.error('❌ Критическая ошибка при запуске бота. Завершаем работу.');
    process.exit(1);
  }
}

// ---------- Глобальные обработчики ----------
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