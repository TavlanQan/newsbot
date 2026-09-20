// db.js
const sqlite3 = require('sqlite3').verbose();
const { dbLogger } = require('./utils/logger');
const config = require('./config');

const db = new sqlite3.Database(config.DB_PATH);

// Включаем WAL-режим
db.run('PRAGMA journal_mode = WAL;');

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
function ensureAccessRequestsTable() {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS access_requests (
        user_id      INTEGER PRIMARY KEY,
        username     TEXT,
        first_name   TEXT,
        requested_at INTEGER DEFAULT (strftime('%s','now')),
        status       TEXT DEFAULT 'pending'
      )`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

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
// если её ещё нет. SQLite не поддерживает ADD COLUMN IF NOT EXISTS,
// поэтому глотаем только ошибку 'duplicate column name' (норма при
// повторных запусках бота). Любую другую ошибку пробрасываем — это
// может быть реальная проблема со схемой.
//
// Возвращает true, если колонка была добавлена (первый запуск),
// false — если уже существовала.
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
function ensureSystemFeedsTable() {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS system_feeds (
        feed_url TEXT PRIMARY KEY,
        added_at INTEGER DEFAULT (strftime('%s','now'))
      )`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

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
// Замена in-memory lastItemsCache из newsService. Ключ — пара (user_id, item_link),
// поэтому одна и та же ссылка не будет отправлена пользователю дважды, даже если
// она пришла из нескольких эквивалентных фидов (например, двух YouTube-хендлов
// одного и того же канала).
function ensureSentRssItemsTable() {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS sent_rss_items (
        user_id   INTEGER NOT NULL,
        feed_url  TEXT    NOT NULL,
        item_link TEXT    NOT NULL,
        sent_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (user_id, item_link)
      )`,
      (err) => {
        if (err) return reject(err);
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_sent_rss_items_sent_at
           ON sent_rss_items(sent_at)`,
          (idxErr) => (idxErr ? reject(idxErr) : resolve())
        );
      }
    );
  });
}

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
// Отличает «первый парсинг фида у пользователя» (сидируем без отправки)
// от последующих (отправляем только новое). Без этой таблицы либо зальём
// пользователя всей историей при добавлении фида, либо потеряем записи,
// появившиеся во время простоя.
function ensureFeedStateTable() {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS feed_state (
        user_id         INTEGER NOT NULL,
        feed_url        TEXT    NOT NULL,
        first_seen_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        last_checked_at INTEGER,
        PRIMARY KEY (user_id, feed_url)
      )`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

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
  // утилиты
  run,
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
  ensureAccessRequestsTable,
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
  ensureSystemFeedsTable,
  getSystemFeeds,
  addSystemFeed,
  removeSystemFeed,
  // отправленные RSS-записи (дедуп)
  ensureSentRssItemsTable,
  isRssItemSent,
  markRssItemSent,
  markRssItemsSentBulk,
  cleanOldSentItems,
  // состояние фида (сидирование)
  ensureFeedStateTable,
  hasFeedState,
  initFeedState,
  touchFeedState,
  removeFeedState,
  // пересылка
  isMessageForwarded,
  addForwardedMessage,
  cleanOldForwarded
};