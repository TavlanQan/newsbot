// bot.js
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const helpers = require('./helpers');
const queue = require('./queue');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const { registerHandlers } = require('./handlers');

// Маркер загрузки файла в PM2 stdout. Если этого лога нет после
// `pm2 restart newsbot` — значит PM2 запускает НЕ ЭТОТ файл.
console.log(`[bot.js] module loaded at ${new Date().toISOString()}, RSS_UPDATE_INTERVAL=${config.RSS_UPDATE_INTERVAL}`);

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map();

// ---------- Персистентный флаг «пересылка активна» ----------
// Значение хранится в БД (таблица settings) и восстанавливается при старте.
// handlers.js продолжает писать isForwardingActive.value = true/false —
// это работает через Proxy, запись в БД происходит прозрачно.
//
// Раньше этот файл открывал собственное соединение к sqlite3 ради
// settings — теперь всё идёт через единый модуль db.js.
async function loadForwardingState() {
  try {
    const value = await db.getSetting('forwarding_active');
    if (value === null || value === undefined) {
      return true; // первый запуск — включаем по умолчанию
    }
    return value === '1';
  } catch (err) {
    botLogger.warn(
      `⚠️ Не удалось прочитать forwarding_active: ${err.message}. По умолчанию — ВКЛ.`
    );
    return true; // безопасный дефолт: лучше цикл, чем тишина
  }
}

async function saveForwardingState(value) {
  return db.setSetting('forwarding_active', value ? '1' : '0');
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
// Порядок важен:
//   1. bot.stop() — Telegraf перестаёт принимать новые updates.
//      После этого новые queue.add(...) из handlers.js уже не приходят.
//   2. queue.drain() — ждём слива очереди до 10 сек. Новые задачи
//      (в том числе от ещё бегущего checkAllFeeds) отклоняются: у них
//      closing=true. Это осознанный trade-off — предсказуемый shutdown
//      важнее, чем «дожать всё любой ценой».
//   3. exit(0).
//
// kill-timeout в PM2 должен быть > drain timeout, иначе SIGKILL прилетит
// раньше, чем мы закончим. У нас drain=10000, kill-timeout=15000.
//
// Защита от повторного вызова (SIGINT + SIGTERM подряд) через
// isShuttingDown — иначе два параллельных drain'а будут драться за exit.
let isShuttingDown = false;
async function shutdown(signalLabel = 'SIGTERM') {
  if (isShuttingDown) {
    botLogger.info(`⚠️ shutdown уже выполняется, повторный ${signalLabel} игнорируется`);
    return;
  }
  isShuttingDown = true;

  botLogger.info(`🔴 Завершение работы бота (${signalLabel})...`);

  // 1. Останавливаем Telegraf. Даже если упадёт — всё равно пробуем drain.
  try {
    await bot.stop();
    botLogger.info('✅ Telegraf остановлен');
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: shutdown → bot.stop');
  }

  // 2. Ждём слива очереди.
  try {
    const result = await queue.drain(10000);
    if (result.drained) {
      botLogger.info('✅ Очередь слита');
    } else {
      botLogger.warn(
        `⚠️ Очередь не слита за 10 сек: remaining=${result.remaining}, ` +
          `stillProcessing=${result.stillProcessing}. ` +
          `Незавершённые задачи потеряются при exit.`
      );
    }
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: shutdown → queue.drain');
  }

  // 3. Выход. Всегда 0 — это плановое завершение по сигналу,
  //    PM2 перезапустит процесс штатно.
  botLogger.info('👋 Выход');
  process.exit(0);
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

    // Единая инициализация схемы через модуль db.js. Всё идёт через одно
    // соединение — race condition между CREATE TABLE и запросами из других
    // модулей (например, isRssItemSent) больше невозможен.
    await db.initSchema();
    botLogger.info('✅ Схема БД инициализирована (таблицы и индексы)');

    // Идемпотентная миграция: добавляет колонку user_feeds.feed_title,
    // если её ещё нет. Для свежих БД (initSchema создала колонку) —
    // вернёт false и тихо пропустит. Для старых — выполнит ALTER.
    try {
      const titleAdded = await db.migrateUserFeedsAddTitle();
      if (titleAdded) {
        botLogger.info('🔄 Миграция: добавлена колонка user_feeds.feed_title');
      }
    } catch (error) {
      errorHandler.handleError(error, 'bot.js: migrateUserFeedsAddTitle');
    }

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
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  botLogger.info('⏹️ Остановка бота по SIGTERM');
  shutdown('SIGTERM');
});