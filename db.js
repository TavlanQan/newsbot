const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const errorHandler = require('./errorHandler');
const { dbLogger } = require('./utils/logger');
const config = require('./config');
const dbPath = path.resolve(config.DB_PATH);
const db = new sqlite3.Database(dbPath);

// Включаем WAL-режим
db.run('PRAGMA journal_mode = WAL;');

// Обёртки (без логирования внутри)
function runSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAllSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function initializeDB() {
  return new Promise(async (resolve, reject) => {
    try {
      dbLogger.info('🔄 Инициализация базы данных...');

      await runSQL(`CREATE TABLE IF NOT EXISTS keywords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await runSQL(`CREATE TABLE IF NOT EXISTS sent_news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        news_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await runSQL(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);

      await runSQL(`CREATE TABLE IF NOT EXISTS monitored_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT UNIQUE NOT NULL,
        channel_username TEXT,
        channel_title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await runSQL(`CREATE TABLE IF NOT EXISTS target_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT UNIQUE NOT NULL,
        channel_username TEXT,
        channel_title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await runSQL(`CREATE TABLE IF NOT EXISTS forwarded_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_message_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        forwarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(original_message_id, channel_id)
      )`);

      // Индексы
      await runSQL('CREATE INDEX IF NOT EXISTS idx_sent_news_id ON sent_news(news_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_forwarded_messages_composite ON forwarded_messages(original_message_id, channel_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_monitored_channels_id ON monitored_channels(channel_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_target_channels_id ON target_channels(channel_id)');

      // Настройки по умолчанию
      const defaultSettings = [
        ['auto_post_enabled', 'true'],
        ['check_interval', '30'],
        ['channel_monitoring_enabled', 'true']
      ];

      const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

      for (const [key, value] of defaultSettings) {
        try {
          await new Promise((resolveStmt, rejectStmt) => {
            stmt.run(key, value, function(err) {
              if (err) rejectStmt(err);
              else resolveStmt(this);
            });
          });
        } catch (error) {
          errorHandler.handleError(
            error,
            `db: initializeDB setting insert failed for ${key}`,
            'WARN'
          );
          dbLogger.warn(`⚠️ Не удалось добавить настройку ${key}: ${error.message}`);
        }
      }

      stmt.finalize();

      dbLogger.info('✅ База данных успешно инициализирована');
      resolve();
    } catch (error) {
      errorHandler.handleError(error, 'db: initializeDB');
      reject(error);
    }
  });
}

function addKeyword(keyword) {
  return new Promise((resolve, reject) => {
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      const err = new Error('Ключевое слово не может быть пустым');
      errorHandler.handleError(err, 'db: addKeyword validation', 'WARN');
      return reject(err);
    }

    const trimmedKeyword = keyword.trim();

    db.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [trimmedKeyword], function(err) {
      if (err) {
        errorHandler.handleError(err, `db: addKeyword "${trimmedKeyword}"`);
        reject(err);
      } else {
        if (this.changes > 0) {
          dbLogger.info(`✅ Добавлено ключевое слово: "${trimmedKeyword}"`);
        }
        resolve(this.changes);
      }
    });
  });
}

function removeKeyword(keyword) {
  return new Promise((resolve, reject) => {
    if (!keyword || typeof keyword !== 'string') {
      const err = new Error('Неверный формат ключевого слова');
      errorHandler.handleError(err, 'db: removeKeyword validation', 'WARN');
      return reject(err);
    }

    db.run('DELETE FROM keywords WHERE keyword = ?', [keyword], function(err) {
      if (err) {
        errorHandler.handleError(err, `db: removeKeyword "${keyword}"`);
        reject(err);
      } else {
        if (this.changes > 0) {
          dbLogger.info(`✅ Удалено ключевое слово: "${keyword}"`);
        }
        resolve(this.changes);
      }
    });
  });
}

function getKeywords() {
  return new Promise((resolve, reject) => {
    db.all('SELECT keyword FROM keywords ORDER BY keyword', (err, rows) => {
      if (err) {
        errorHandler.handleError(err, 'db: getKeywords');
        reject(err);
      } else {
        resolve(rows.map(row => row.keyword));
      }
    });
  });
}

function addSentNews(newsId, title, url) {
  return new Promise((resolve, reject) => {
    if (!newsId || !title || !url) {
      const err = new Error('Неполные данные новости');
      errorHandler.handleError(err, 'db: addSentNews validation', 'WARN');
      return reject(err);
    }

    db.run(
      'INSERT OR IGNORE INTO sent_news (news_id, title, url) VALUES (?, ?, ?)',
      [newsId, title, url],
      function(err) {
        if (err) {
          errorHandler.handleError(err, `db: addSentNews ${newsId}`);
          reject(err);
        } else {
          if (this.changes > 0) {
            dbLogger.info(`✅ Добавлена отправленная новость: ${title.substring(0, 50)}...`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function isNewsSent(newsId) {
  return new Promise((resolve, reject) => {
    if (!newsId) {
      return resolve(false);
    }

    db.get('SELECT 1 FROM sent_news WHERE news_id = ?', [newsId], (err, row) => {
      if (err) {
        errorHandler.handleError(err, `db: isNewsSent ${newsId}`);
        reject(err);
      } else {
        resolve(!!row);
      }
    });
  });
}

function addTargetChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    if (!channelId || typeof channelId !== 'string') {
      const err = new Error('Неверный ID канала');
      errorHandler.handleError(err, 'db: addTargetChannel validation', 'WARN');
      return reject(err);
    }

    dbLogger.info(`➕ Добавление целевого канала: "${channelId}"`);

    db.run(
      'INSERT OR IGNORE INTO target_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          errorHandler.handleError(err, `db: addTargetChannel ${channelId}`);
          reject(err);
        } else {
          if (this.changes > 0) {
            dbLogger.info(`✅ Добавлен целевой канал: "${channelId}"`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function removeTargetChannel(channelId) {
  return new Promise((resolve, reject) => {
    if (!channelId) {
      const err = new Error('ID канала не может быть пустым');
      errorHandler.handleError(err, 'db: removeTargetChannel validation', 'WARN');
      return reject(err);
    }

    dbLogger.info(`🗑️ Удаление целевого канала ID: "${channelId}"`);

    db.run('DELETE FROM target_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        errorHandler.handleError(err, `db: removeTargetChannel ${channelId}`);
        reject(err);
      } else {
        if (this.changes > 0) {
          dbLogger.info(`✅ Удален целевой канал: "${channelId}"`);
        }
        resolve(this.changes);
      }
    });
  });
}

function getTargetChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM target_channels ORDER BY channel_id', (err, rows) => {
      if (err) {
        errorHandler.handleError(err, 'db: getTargetChannels');
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function addMonitoredChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    if (!channelId || typeof channelId !== 'string') {
      const err = new Error('Неверный ID канала');
      errorHandler.handleError(err, 'db: addMonitoredChannel validation', 'WARN');
      return reject(err);
    }

    dbLogger.info(`➕ Добавление отслеживаемого канала: "${channelId}"`);

    db.run(
      'INSERT OR IGNORE INTO monitored_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          errorHandler.handleError(err, `db: addMonitoredChannel ${channelId}`);
          reject(err);
        } else {
          if (this.changes > 0) {
            dbLogger.info(`✅ Добавлен отслеживаемый канал: "${channelId}"`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function removeMonitoredChannel(channelId) {
  return new Promise((resolve, reject) => {
    if (!channelId) {
      const err = new Error('ID канала не может быть пустым');
      errorHandler.handleError(err, 'db: removeMonitoredChannel validation', 'WARN');
      return reject(err);
    }

    dbLogger.info(`🗑️ Удаление отслеживаемого канала ID: "${channelId}"`);

    db.run('DELETE FROM monitored_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        errorHandler.handleError(err, `db: removeMonitoredChannel ${channelId}`);
        reject(err);
      } else {
        if (this.changes > 0) {
          dbLogger.info(`✅ Удален отслеживаемый канал: "${channelId}"`);
        }
        resolve(this.changes);
      }
    });
  });
}

function getMonitoredChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM monitored_channels ORDER BY channel_id', (err, rows) => {
      if (err) {
        errorHandler.handleError(err, 'db: getMonitoredChannels');
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function addForwardedMessage(originalMessageId, channelId) {
  return new Promise((resolve, reject) => {
    if (!originalMessageId || !channelId) {
      const err = new Error('Неполные данные для пересылаемого сообщения');
      errorHandler.handleError(err, 'db: addForwardedMessage validation', 'WARN');
      return reject(err);
    }

    db.run(
      'INSERT OR IGNORE INTO forwarded_messages (original_message_id, channel_id) VALUES (?, ?)',
      [originalMessageId, channelId],
      function(err) {
        if (err) {
          errorHandler.handleError(err, `db: addForwardedMessage ${originalMessageId}, ${channelId}`);
          reject(err);
        } else {
          if (this.changes > 0) {
            dbLogger.info(`✅ Добавлено пересланное сообщение: ${originalMessageId} из канала ${channelId}`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function isMessageForwarded(originalMessageId, channelId) {
  return new Promise((resolve, reject) => {
    if (!originalMessageId || !channelId) {
      return resolve(false);
    }

    db.get(
      'SELECT 1 FROM forwarded_messages WHERE original_message_id = ? AND channel_id = ?',
      [originalMessageId, channelId],
      (err, row) => {
        if (err) {
          errorHandler.handleError(err, `db: isMessageForwarded ${originalMessageId}, ${channelId}`);
          reject(err);
        } else {
          resolve(!!row);
        }
      }
    );
  });
}

function getSetting(key) {
  return new Promise((resolve, reject) => {
    if (!key) {
      const err = new Error('Ключ настройки не может быть пустым');
      errorHandler.handleError(err, 'db: getSetting validation', 'WARN');
      return reject(err);
    }

    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) {
        errorHandler.handleError(err, `db: getSetting ${key}`);
        reject(err);
      } else {
        resolve(row ? row.value : null);
      }
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    if (!key || value === undefined || value === null) {
      const err = new Error('Неполные данные для настройки');
      errorHandler.handleError(err, 'db: setSetting validation', 'WARN');
      return reject(err);
    }

    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], function(err) {
      if (err) {
        errorHandler.handleError(err, `db: setSetting ${key}`);
        reject(err);
      } else {
        dbLogger.info(`✅ Настройка обновлена: ${key} = ${value}`);
        resolve();
      }
    });
  });
}

function countForwardedMessages() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM forwarded_messages', (err, row) => {
      if (err) {
        errorHandler.handleError(err, 'db: countForwardedMessages');
        reject(err);
      } else {
        resolve(row ? row.count : 0);
      }
    });
  });
}

function countSentNews() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM sent_news', (err, row) => {
      if (err) {
        errorHandler.handleError(err, 'db: countSentNews');
        reject(err);
      } else {
        resolve(row ? row.count : 0);
      }
    });
  });
}

function closeDB() {
  return new Promise((resolve) => {
    dbLogger.info('🔒 Закрытие соединения с базой данных...');
    db.close((err) => {
      if (err) {
        errorHandler.handleError(err, 'db: closeDB', 'WARN');
      } else {
        dbLogger.info('✅ Соединение с базой данных закрыто');
      }
      resolve();
    });
  });
}

// Обработчики для graceful shutdown
process.on('SIGINT', async () => {
  await closeDB();
});

process.on('SIGTERM', async () => {
  await closeDB();
});

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
  countSentNews,
  closeDB
};