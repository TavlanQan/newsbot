// db.js
const sqlite3 = require('sqlite3').verbose();
const { dbLogger } = require('./utils/logger');
const config = require('./config');

const db = new sqlite3.Database(config.DB_PATH);

// Включаем WAL-режим
db.run('PRAGMA journal_mode = WAL;');

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
    db.run(sql, [userId, isAdmin ? 1 : 0, subscriptionEnd], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function updateUserSubscription(userId, days) {
  return new Promise((resolve, reject) => {
    const end = days === null ? null : Math.floor(Date.now() / 1000) + days * 86400;
    db.run('UPDATE users SET subscription_end = ? WHERE user_id = ?', [end, userId], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function deleteUser(userId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM users WHERE user_id = ?', [userId], function(err) {
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
    db.get('SELECT subscription_end FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else if (!row) resolve(false);
      else if (row.subscription_end === null) resolve(true); // бессрочно (админ)
      else resolve(row.subscription_end > Math.floor(Date.now() / 1000));
    });
  });
}

// ------------------- КЛЮЧЕВЫЕ СЛОВА -------------------
function addKeyword(userId, keyword) {
  return new Promise((resolve, reject) => {
    const sql = 'INSERT OR IGNORE INTO keywords (user_id, keyword) VALUES (?, ?)';
    db.run(sql, [userId, keyword], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeKeyword(userId, keyword) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM keywords WHERE user_id = ? AND keyword = ?', [userId, keyword], function(err) {
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
    db.run(sql, [userId, channelId, username, title], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeTargetChannel(userId, channelId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM target_channels WHERE user_id = ? AND channel_id = ?', [userId, channelId], function(err) {
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
    db.run(sql, [userId, channelId, username, title], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeMonitoredChannel(userId, channelId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM monitored_channels WHERE user_id = ? AND channel_id = ?', [userId, channelId], function(err) {
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
function addUserFeed(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    const sql = 'INSERT OR IGNORE INTO user_feeds (user_id, feed_url) VALUES (?, ?)';
    db.run(sql, [userId, feedUrl], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

function removeUserFeed(userId, feedUrl) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM user_feeds WHERE user_id = ? AND feed_url = ?', [userId, feedUrl], function(err) {
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

// Получить все ленты всех пользователей (для глобального парсинга)
function getAllFeeds() {
  return new Promise((resolve, reject) => {
    db.all('SELECT user_id, feed_url FROM user_feeds', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
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
    db.run('INSERT OR IGNORE INTO forwarded_messages (message_id, channel_id) VALUES (?, ?)', [messageId, channelId], function(err) {
      if (err) reject(err);
      else resolve(this.changes > 0);
    });
  });
}

// Очистка старых записей (по желанию)
function cleanOldForwarded(days = 30) {
  const threshold = Math.floor(Date.now() / 1000) - days * 86400;
  db.run('DELETE FROM forwarded_messages WHERE timestamp < ?', [threshold]);
}

module.exports = {
  getUser,
  addUser,
  updateUserSubscription,
  deleteUser,
  listUsers,
  hasActiveSubscription,
  addKeyword,
  removeKeyword,
  getKeywords,
  addTargetChannel,
  removeTargetChannel,
  getTargetChannels,
  addMonitoredChannel,
  removeMonitoredChannel,
  getMonitoredChannels,
  addUserFeed,
  removeUserFeed,
  getUserFeeds,
  getAllFeeds,
  isMessageForwarded,
  addForwardedMessage,
  cleanOldForwarded
};