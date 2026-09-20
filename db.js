// db.js
const sqlite3 = require('sqlite3').verbose();
const { dbLogger } = require('./utils/logger');
const config = require('./config');

const db = new sqlite3.Database(config.DB_PATH);

// ------------------- УТИЛИТЫ -------------------
// Универсальная обёртка над db.run (для точечных запросов из других модулей)
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

// ------------------- ИНИЦИАЛИЗАЦИЯ СХЕМЫ -------------------
// Создаёт все таблицы и индексы. Идемпотентно (CREATE IF NOT EXISTS).
//
// ВАЖНО: раньше эту работу делал bot.js::initDatabase() — но через СВОЁ
// соединение (sqlite3.Database(DB_FILE)), независимое от модуля db.js.
// Два соединения к одной SQLite не синхронизированы: запрос из db.js
// (например, isRssItemSent) мог прилететь раньше, чем второе соединение
// успевало создать sent_rss_items → 'no such table: main.sent_rss_items'.
//
// Теперь всё идёт через ЕДИНОЕ соединение модуля db.js. Плюс каждый шаг
// выполняется последовательно (await), чтобы порядок CREATE TABLE → CREATE
// INDEX гарантированно соблюдался.
//
// PRAGMA journal_mode = WAL тоже ждём — иначе первый же write мог бы
// прилететь до переключения режима.
async function initSchema() {
  await run('PRAGMA journal_mode = WAL;');

  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
       user_id INTEGER PRIMARY KEY,
       subscription_end INTEGER,
       is_admin INTEGER DEFAULT 0,
       created_at INTEGER DEFAULT (strftime('%s', 'now'))
     )`,
    `CREATE TABLE IF NOT EXISTS keywords (
       user_id INTEGER,
       keyword TEXT,
       PRIMARY KEY (user_id, keyword)
     )`,
    `CREATE TABLE IF NOT EXISTS monitored_channels (
       user_id INTEGER,
       channel_id TEXT,
       channel_username TEXT,
       channel_title TEXT,
       PRIMARY KEY (user_id, channel_id)
     )`,
    `CREATE TABLE IF NOT EXISTS target_channels (
       user_id INTEGER,
       channel_id TEXT,
       channel_username TEXT,
       channel_title TEXT,
       PRIMARY KEY (user_id, channel_id)
     )`,
    // feed_title — человекочитаемое название фида (для YouTube-каналов —
    // название канала). Может быть NULL. Для старых БД колонка добавляется
    // отдельной идемпотентной миграцией migrateUserFeedsAddTitle().
    `CREATE TABLE IF NOT EXISTS user_feeds (
       user_id INTEGER,
       feed_url TEXT,
       feed_title TEXT,
       PRIMARY KEY (user_id, feed_url)
     )`,
    `CREATE TABLE IF NOT EXISTS system_feeds (
       feed_url TEXT PRIMARY KEY,
       added_at INTEGER DEFAULT (strftime('%s','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS forwarded_messages (
       message_id INTEGER,
       channel_id TEXT,
       timestamp INTEGER DEFAULT (strftime('%s', 'now')),
       PRIMARY KEY (message_id, channel_id)
     )`,
    `CREATE TABLE IF NOT EXISTS access_requests (
       user_id      INTEGER PRIMARY KEY,
       username     TEXT,
       first_name   TEXT,
       requested_at INTEGER DEFAULT (strftime('%s', 'now')),
       status       TEXT DEFAULT 'pending'
     )`,
    // Персистентное состояние бота (forwarding_active и т.п.)
    `CREATE TABLE IF NOT EXISTS settings (
       key   TEXT PRIMARY KEY,
       value TEXT
     )`,
    // Дедуп отправленных RSS-записей. Заменяет in-memory lastItemsCache:
    // переживает рестарт, устраняет флуд и дубли между эквивалентными фидами.
    `CREATE TABLE IF NOT EXISTS sent_rss_items (
       user_id   INTEGER NOT NULL,
       feed_url  TEXT    NOT NULL,
       item_link TEXT    NOT NULL,
       sent_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
       PRIMARY KEY (user_id, item_link)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sent_rss_items_sent_at
       ON sent_rss_items(sent_at)`,
    // Флаг «фид уже инициализирован для пользователя». Отличает первый
    // парсинг (сидируем без отправки) от последующих (шлём только новое).
    `CREATE TABLE IF NOT EXISTS feed_state (
       user_id         INTEGER NOT NULL,
       feed_url        TEXT    NOT NULL,
       first_seen_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
       last_checked_at INTEGER,
       PRIMARY KEY (user_id, feed_url)
     )`
  ];

  for (const sql of schema) {
    await run(sql);
  }
}

// ------------------- НАСТРОЙКИ (settings) -------------------
// Обёртки над таблицей key-value. Заменяют персональные соединения,
// которые bot.js открывал для load/save forwarding_active.
function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.value : null);
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
      function (err) {
        if (err) reject(err);
        else resolve(true);
      }
    );
  });
}

// ------------------- ТРАНЗАКЦИИ -------------------
// Оборачивает fn() в BEGIN/COMMIT, при ошибке — ROLLBACK.
// fn должна возвращать Promise. Возвращает результат fn.
//
// Пока не используется, но понадобится для Задачи 4 (мягкая миграция
// легаси-фидов: removeUserFeed + removeFeedState + addUserFeed + initFeedState
// должны быть атомарны).
//
// ВНИМАНИЕ: SQLite не поддерживает вложенные транзакции. Не вызывать
// withTransaction внутри withTransaction.
function withTransaction(fn) {
  return new Promise((resolve, reject) => {
    db.run('BEGIN', (err) => {
      if (err) return reject(err);
      Promise.resolve()
        .then(() => fn())
        .then((result) => {
          db.run('COMMIT', (err) => {
            if (err) return reject(err);
            resolve(result);
          });
        })
        .catch((err) => {
          db.run('ROLLBACK', () => reject(err));
        });
    });
  });
}

// ------------------- ПОЛЬЗОВАТЕЛИ -------------------
function getUser(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function addUser(userId, isAdmin = false, subscriptionEnd = null) {
  return new Promise((resolve, reject) => {
    const sql = `INSERT OR IGNORE INTO users (user_id, is_admin, subscription_end) VALUES (?, ?, ?)`;
    db.run(sql, [userId, isAdmin ? 1 : 0, subscriptionEnd], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function updateUserSubscription(userId, days) {
  return new Promise((resolve, reject) => {
    // Админам подписку не трогаем — у них бессрочный доступ
    db.get('SELECT is_admin FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(false);
      if (row.is_admin === 1) return resolve(true); // no-op
      const end = days === null ? null : Math.floor(Date.now() / 1000) + days * 86400;
      db.run('UPDATE users SET subscription_end = ? WHERE user_id = ?', [end, userId], function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      });
    });
  });
}

function deleteUser(userId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM users WHERE user_id = ?', [userId], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function listUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT user_id, subscription_end, is_admin, created_at FROM users ORDER BY created_at', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Проверка подписки (true – если есть доступ)
function hasActiveSubscription(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT subscription_end, is_admin FROM users WHERE user_id = ?',
      [userId],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(false);
        // Админ всегда имеет доступ, независимо от subscription_end
        if (row.is_admin === 1) return resolve(true);
        // Бессрочная подписка
        if (row.subscription_end === null) return resolve(true);
        // Обычная подписка по времени
        resolve(row.subscription_end > Math.floor(Date.now() / 1000));
      }
    );
  });
}

// ------------------- УПРАВЛЕНИЕ АДМИНАМИ -------------------
function setAdmin(userId, isAdmin) {
  return new Promise((resolve, reject) => {
    const sql = isAdmin
      ? 'UPDATE users SET is_admin = 1, subscription_end = NULL WHERE user_id = ?'
      : 'UPDATE users SET is_admin = 0 WHERE user_id = ?';
    db.run(sql, [userId], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function listAdmins() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT user_id, subscription_end, created_at FROM users
       WHERE is_admin = 1 ORDER BY created_at`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// ------------------- ЗАПРОСЫ НА ДОСТУП -------------------
function addAccessRequest(userId, username, firstName) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO access_requests (user_id, username, first_name, requested_at, status)
      VALUES (?, ?, ?, strftime('%s','now'), 'pending')
      ON CONFLICT(user_id) DO UPDATE SET
        username     = excluded.username,
        first_name   = excluded.first_name,
        requested_at = excluded.requested_at,
        status       = 'pending'
    `;
    db.run(sql, [userId, username || null, firstName || null], (err) =>
      err ? reject(err) : resolve(true)
    );
  });
}

function getAccessRequest(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM access_requests WHERE user_id = ?', [userId], (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });
}

function getPendingAccessRequests() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM access_requests WHERE status = 'pending' ORDER BY requested_at ASC`,
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function resolveAccessRequest(userId, status) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE access_requests SET status = ? WHERE user_id = ?',
      [status, userId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

// ------------------- КЛЮЧЕВЫЕ СЛОВА -------------------
function addKeyword(userId, keyword) {
  return new Promise((resolve, reject) => {
    const sql = 'INSERT OR IGNORE INTO keywords (user_id, keyword) VALUES (?, ?)';
    db.run(sql, [userId, keyword], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeKeyword(userId, keyword) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM keywords WHERE user_id = ? AND keyword = ?', [userId, keyword], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function getKeywords(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT keyword FROM keywords WHERE user_id = ?', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.keyword));
    });
  });
}

// ------------------- ЦЕЛЕВЫЕ КАНАЛЫ -------------------
function addTargetChannel(userId, channelId, username, title) {
  return new Promise((resolve, reject) => {
    const sql = `INSERT OR IGNORE INTO target_channels (user_id, channel_id, channel_username, channel_title)
                 VALUES (?, ?, ?, ?)`;
    db.run(sql, [userId, channelId, username, title], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeTargetChannel(userId, channelId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM target_channels WHERE user_id = ? AND channel_id = ?', [userId, channelId], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function getTargetChannels(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM target_channels WHERE user_id = ?', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ------------------- МОНИТОРИНГ КАНАЛОВ -------------------
function addMonitoredChannel(userId, channelId, username, title) {
  return new Promise((resolve, reject) => {
    const sql = `INSERT OR IGNORE INTO monitored_channels (user_id, channel_id, channel_username, channel_title)
                 VALUES (?, ?, ?, ?)`;
    db.run(sql, [userId, channelId, username, title], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeMonitoredChannel(userId, channelId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM monitored_channels WHERE user_id = ? AND channel_id = ?', [userId, channelId], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function getMonitoredChannels(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM monitored_channels WHERE user_id = ?', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ------------------- RSS/YouTube ЛЕНТЫ (user_feeds) -------------------
// feed_title — человекочитаемое название фида (для YouTube-каналов это
// название канала, полученное из RSS-ответа микросервиса или заданное
// вручную пользователем). Может быть NULL — для фидов, добавленных до
// миграции, или для обычных RSS, где название не извлекается.
function addUserFeed(userId, feedUrl, feedTitle = null) {
  return new Promise((resolve, reject) => {
    const sql = 'INSERT OR IGNORE INTO user_feeds (user_id, feed_url, feed_title) VALUES (?, ?, ?)';
    db.run(sql, [userId, feedUrl, feedTitle], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeUserFeed(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM user_feeds WHERE user_id = ? AND feed_url = ?', [userId, feedUrl], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function getUserFeeds(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT feed_url FROM user_feeds WHERE user_id = ?', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.feed_url));
    });
  });
}

// Возвращает фиды вместе с названиями: [{feed_url, feed_title}, ...].
// Порядок тот же, что и у getUserFeeds (без ORDER BY — стабильно по rowid).
function getUserFeedsWithMeta(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT feed_url, feed_title FROM user_feeds WHERE user_id = ?',
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Ручное обновление названия фида (кнопка «✏️ Задать название» для YouTube).
// Возвращает true, если строка была обновлена (фид существует у пользователя).
function updateUserFeedTitle(userId, feedUrl, feedTitle) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE user_feeds SET feed_title = ? WHERE user_id = ? AND feed_url = ?',
      [feedTitle, userId, feedUrl],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

// Идемпотентная миграция: добавляет колонку feed_title в user_feeds,
// если её ещё нет. Нужна для БД, созданных ДО того, как feed_title была
// добавлена в initSchema(). SQLite не поддерживает ADD COLUMN IF NOT
// EXISTS, поэтому глотаем только ошибку 'duplicate column name'.
//
// Возвращает true, если колонка была добавлена (старая БД),
// false — если уже существовала (свежая БД или повторный запуск).
function migrateUserFeedsAddTitle() {
  return new Promise((resolve, reject) => {
    db.run('ALTER TABLE user_feeds ADD COLUMN feed_title TEXT', (err) => {
      if (err) {
        if (String(err.message).includes('duplicate column name')) {
          return resolve(false); // колонка уже есть — это норма
        }
        return reject(err);
      }
      resolve(true); // колонка добавлена
    });
  });
}

// Получить все ленты всех пользователей (для глобального парсинга)
function getAllFeeds() {
  return new Promise((resolve, reject) => {
    db.all('SELECT user_id, feed_url FROM user_feeds', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ------------------- СИСТЕМНЫЕ ЛЕНТЫ (system_feeds) -------------------
// Глобальные RSS-ленты, доступные только главному администратору.
// Парсятся для всех активных пользователей в newsService (с фильтром по ключевым словам).
// Изначально мигрируются из .env (RSS_FEEDS) при первом запуске, потом управляются через бота.
function getSystemFeeds() {
  return new Promise((resolve, reject) => {
    db.all('SELECT feed_url FROM system_feeds ORDER BY added_at ASC', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map((r) => r.feed_url));
    });
  });
}

function addSystemFeed(feedUrl) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO system_feeds (feed_url) VALUES (?)', [feedUrl], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeSystemFeed(feedUrl) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM system_feeds WHERE feed_url = ?', [feedUrl], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

// ------------------- ОТПРАВЛЕННЫЕ RSS-ЗАПИСИ (sent_rss_items) -------------------
function isRssItemSent(userId, itemLink) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM sent_rss_items WHERE user_id = ? AND item_link = ? LIMIT 1',
      [userId, itemLink],
      (err, row) => (err ? reject(err) : resolve(!!row))
    );
  });
}

function markRssItemSent(userId, feedUrl, itemLink) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO sent_rss_items (user_id, feed_url, item_link)
       VALUES (?, ?, ?)`,
      [userId, feedUrl, itemLink],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

// Пакетная пометка — используется при сидировании нового фида
// и при массовом проходе по свежим записям. Ускорено prepared statement.
function markRssItemsSentBulk(userId, feedUrl, itemLinks) {
  return new Promise((resolve, reject) => {
    if (!itemLinks || itemLinks.length === 0) return resolve(0);

    const stmt = db.prepare(
      'INSERT OR IGNORE INTO sent_rss_items (user_id, feed_url, item_link) VALUES (?, ?, ?)'
    );

    let pending = itemLinks.length;
    let errored = false;

    for (const link of itemLinks) {
      stmt.run([userId, feedUrl, link], (err) => {
        if (errored) return;
        if (err) {
          errored = true;
          stmt.finalize(() => reject(err));
          return;
        }
        if (--pending === 0) {
          stmt.finalize((finalizeErr) => {
            if (finalizeErr) reject(finalizeErr);
            else resolve(itemLinks.length);
          });
        }
      });
    }
  });
}

// Удаление записей старше N дней. Вызывается из cron в bot.js.
function cleanOldSentItems(days = 30) {
  return new Promise((resolve, reject) => {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    db.run(
      'DELETE FROM sent_rss_items WHERE sent_at < ?',
      [cutoff],
      function (err) {
        if (err) reject(err);
        else {
          dbLogger.info(`🧹 Удалено старых sent_rss_items: ${this.changes}`);
          resolve(this.changes);
        }
      }
    );
  });
}

// ------------------- СОСТОЯНИЕ ФИДА (feed_state) -------------------
function hasFeedState(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM feed_state WHERE user_id = ? AND feed_url = ? LIMIT 1',
      [userId, feedUrl],
      (err, row) => (err ? reject(err) : resolve(!!row))
    );
  });
}

function initFeedState(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO feed_state (user_id, feed_url) VALUES (?, ?)',
      [userId, feedUrl],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function touchFeedState(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE feed_state
       SET last_checked_at = strftime('%s','now')
       WHERE user_id = ? AND feed_url = ?`,
      [userId, feedUrl],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function removeFeedState(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM feed_state WHERE user_id = ? AND feed_url = ?',
      [userId, feedUrl],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

// ------------------- ПРОЧЕЕ (для совместимости) -------------------
// Для проверки дубликатов пересылки (оставляем глобальным)
function isMessageForwarded(messageId, channelId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM forwarded_messages WHERE message_id = ? AND channel_id = ?', [messageId, channelId], (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

function addForwardedMessage(messageId, channelId) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO forwarded_messages (message_id, channel_id) VALUES (?, ?)', [messageId, channelId], function (err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

// Очистка старых записей (по желанию)
function cleanOldForwarded(days = 30) {
  return new Promise((resolve, reject) => {
    const threshold = Math.floor(Date.now() / 1000) - days * 86400;
    db.run('DELETE FROM forwarded_messages WHERE timestamp < ?', [threshold], function (err) {
      if (err) reject(err);
      else {
        dbLogger.info(`🧹 Удалено старых forwarded_messages: ${this.changes}`);
        resolve(this.changes);
      }
    });
  });
}

module.exports = {
  // утилиты + схема
  run,
  initSchema,
  // настройки
  getSetting,
  setSetting,
  // транзакции
  withTransaction,
  // пользователи
  getUser,
  addUser,
  updateUserSubscription,
  deleteUser,
  listUsers,
  hasActiveSubscription,
  // управление админами
  setAdmin,
  listAdmins,
  // запросы на доступ
  addAccessRequest,
  getAccessRequest,
  getPendingAccessRequests,
  resolveAccessRequest,
  // ключевые слова
  addKeyword,
  removeKeyword,
  getKeywords,
  // целевые каналы
  addTargetChannel,
  removeTargetChannel,
  getTargetChannels,
  // мониторинг каналов
  addMonitoredChannel,
  removeMonitoredChannel,
  getMonitoredChannels,
  // ленты
  addUserFeed,
  removeUserFeed,
  getUserFeeds,
  getUserFeedsWithMeta,
  updateUserFeedTitle,
  migrateUserFeedsAddTitle,
  getAllFeeds,
  // системные ленты
  getSystemFeeds,
  addSystemFeed,
  removeSystemFeed,
  // отправленные RSS-записи (дедуп)
  isRssItemSent,
  markRssItemSent,
  markRssItemsSentBulk,
  cleanOldSentItems,
  // состояние фида (сидирование)
  hasFeedState,
  initFeedState,
  touchFeedState,
  removeFeedState,
  // пересылка
  isMessageForwarded,
  addForwardedMessage,
  cleanOldForwarded
};