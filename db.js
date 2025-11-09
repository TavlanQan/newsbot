const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'news_bot.db');
const db = new sqlite3.Database(dbPath);

function initializeDB() {
  return new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sent_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS monitored_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE NOT NULL,
      channel_username TEXT,
      channel_title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS target_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE NOT NULL,
      channel_username TEXT,
      channel_title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS forwarded_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_message_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      forwarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(original_message_id, channel_id)
    )`, (err) => {
      if (err) {
        reject(err);
      } else {
        const defaultSettings = [
          ['auto_post_enabled', 'true'],
          ['check_interval', '30'],
          ['channel_monitoring_enabled', 'true']
        ];
        
        const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        defaultSettings.forEach(([key, value]) => stmt.run(key, value));
        stmt.finalize();
        
        resolve();
      }
    });
  });
}

function addKeyword(keyword) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [keyword], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function removeKeyword(keyword) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM keywords WHERE keyword = ?', [keyword], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function getKeywords() {
  return new Promise((resolve, reject) => {
    db.all('SELECT keyword FROM keywords ORDER BY keyword', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => row.keyword));
    });
  });
}

function addSentNews(newsId, title, url) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO sent_news (news_id, title, url) VALUES (?, ?, ?)',
      [newsId, title, url],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function isNewsSent(newsId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM sent_news WHERE news_id = ?', [newsId], (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

function addTargetChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    console.log(`➕ Добавление целевого канала: "${channelId}"`);
    
    db.run(
      'INSERT OR IGNORE INTO target_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          console.error('❌ Ошибка добавления целевого канала:', err);
          reject(err);
        } else {
          console.log(`✅ Добавлено целевых каналов: ${this.changes}`);
          resolve(this.changes);
        }
      }
    );
  });
}

function removeTargetChannel(channelId) {
  return new Promise((resolve, reject) => {
    console.log(`🗑️ УДАЛЕНИЕ целевого канала ID: "${channelId}"`);
    
    db.run('DELETE FROM target_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        console.error('❌ Ошибка при удалении целевого канала:', err);
        reject(err);
      } else {
        console.log(`✅ Удалено целевых каналов: ${this.changes}`);
        resolve(this.changes);
      }
    });
  });
}

function getTargetChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM target_channels ORDER BY channel_id', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function addMonitoredChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    console.log(`➕ Добавление отслеживаемого канала: "${channelId}"`);
    
    db.run(
      'INSERT OR IGNORE INTO monitored_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          console.error('❌ Ошибка добавления отслеживаемого канала:', err);
          reject(err);
        } else {
          console.log(`✅ Добавлено отслеживаемых каналов: ${this.changes}`);
          resolve(this.changes);
        }
      }
    );
  });
}

function removeMonitoredChannel(channelId) {
  return new Promise((resolve, reject) => {
    console.log(`🗑️ УДАЛЕНИЕ отслеживаемого канала ID: "${channelId}"`);
    
    db.run('DELETE FROM monitored_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        console.error('❌ Ошибка при удалении отслеживаемого канала:', err);
        reject(err);
      } else {
        console.log(`✅ Удалено отслеживаемых каналов: ${this.changes}`);
        resolve(this.changes);
      }
    });
  });
}

function getMonitoredChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM monitored_channels ORDER BY channel_id', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function addForwardedMessage(originalMessageId, channelId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO forwarded_messages (original_message_id, channel_id) VALUES (?, ?)',
      [originalMessageId, channelId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function isMessageForwarded(originalMessageId, channelId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM forwarded_messages WHERE original_message_id = ? AND channel_id = ?',
      [originalMessageId, channelId],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });
}

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
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function countForwardedMessages() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM forwarded_messages', (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function countSentNews() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM sent_news', (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

module.exports = {
  initializeDB,
  addKeyword,
  removeKeyword,
  getKeywords,
  addSentNews,
  isNewsSent,
  addTargetChannel,
  removeTargetChannel,
  getTargetChannels,
  addMonitoredChannel,
  removeMonitoredChannel,
  getMonitoredChannels,
  addForwardedMessage,
  isMessageForwarded,
  getSetting,
  setSetting,
  countForwardedMessages,
  countSentNews
};