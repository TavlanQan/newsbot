const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'news_bot.db');
const db = new sqlite3.Database(dbPath);

// Безопасное логирование для db.js
function safeLog(message, isError = false) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMessage = `[${timestamp}] [DB] ${message}`;
  
  if (isError) {
    console.error(logMessage);
  } else {
    console.log(logMessage);
  }
}

// Функция для безопасного выполнения SQL с обработкой ошибок
function runSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        safeLog(`❌ SQL ошибка: ${err.message} - Запрос: ${sql}`, true);
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

// Функция для безопасного получения всех записей
function getAllSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        safeLog(`❌ SQL ошибка: ${err.message} - Запрос: ${sql}`, true);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Функция для безопасного получения одной записи
function getSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        safeLog(`❌ SQL ошибка: ${err.message} - Запрос: ${sql}`, true);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function initializeDB() {
  return new Promise(async (resolve, reject) => {
    try {
      safeLog('🔄 Инициализация базы данных...');

      // Создаем таблицы последовательно с обработкой ошибок
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

      // Создаем индексы для улучшения производительности
      await runSQL('CREATE INDEX IF NOT EXISTS idx_sent_news_id ON sent_news(news_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_forwarded_messages_composite ON forwarded_messages(original_message_id, channel_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_monitored_channels_id ON monitored_channels(channel_id)');
      await runSQL('CREATE INDEX IF NOT EXISTS idx_target_channels_id ON target_channels(channel_id)');

      // Добавляем настройки по умолчанию
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
          safeLog(`⚠️ Не удалось добавить настройку ${key}: ${error.message}`, false);
        }
      }
      
      stmt.finalize();
      
      safeLog('✅ База данных успешно инициализирована');
      resolve();
    } catch (error) {
      safeLog(`❌ Ошибка инициализации базы данных: ${error.message}`, true);
      reject(error);
    }
  });
}

function addKeyword(keyword) {
  return new Promise((resolve, reject) => {
    // Валидация ключевого слова
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      safeLog('❌ Попытка добавить пустое ключевое слово', true);
      return reject(new Error('Ключевое слово не может быть пустым'));
    }

    const trimmedKeyword = keyword.trim();
    
    db.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [trimmedKeyword], function(err) {
      if (err) {
        safeLog(`❌ Ошибка добавления ключевого слова "${trimmedKeyword}": ${err.message}`, true);
        reject(err);
      } else {
        safeLog(`✅ Добавлено ключевых слов: ${this.changes} - "${trimmedKeyword}"`);
        resolve(this.changes);
      }
    });
  });
}

function removeKeyword(keyword) {
  return new Promise((resolve, reject) => {
    if (!keyword || typeof keyword !== 'string') {
      return reject(new Error('Неверный формат ключевого слова'));
    }

    db.run('DELETE FROM keywords WHERE keyword = ?', [keyword], function(err) {
      if (err) {
        safeLog(`❌ Ошибка удаления ключевого слова "${keyword}": ${err.message}`, true);
        reject(err);
      } else {
        safeLog(`✅ Удалено ключевых слов: ${this.changes} - "${keyword}"`);
        resolve(this.changes);
      }
    });
  });
}

function getKeywords() {
  return new Promise((resolve, reject) => {
    db.all('SELECT keyword FROM keywords ORDER BY keyword', (err, rows) => {
      if (err) {
        safeLog(`❌ Ошибка получения ключевых слов: ${err.message}`, true);
        reject(err);
      } else {
        resolve(rows.map(row => row.keyword));
      }
    });
  });
}

function addSentNews(newsId, title, url) {
  return new Promise((resolve, reject) => {
    // Валидация данных
    if (!newsId || !title || !url) {
      safeLog(`⚠️ Попытка добавить неполную запись новости: ${newsId}`, true);
      return reject(new Error('Неполные данные новости'));
    }

    db.run(
      'INSERT OR IGNORE INTO sent_news (news_id, title, url) VALUES (?, ?, ?)',
      [newsId, title, url],
      function(err) {
        if (err) {
          safeLog(`❌ Ошибка добавления отправленной новости ${newsId}: ${err.message}`, true);
          reject(err);
        } else {
          if (this.changes > 0) {
            safeLog(`✅ Добавлена отправленная новость: ${title.substring(0, 50)}...`);
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
        safeLog(`❌ Ошибка проверки новости ${newsId}: ${err.message}`, true);
        reject(err);
      } else {
        resolve(!!row);
      }
    });
  });
}

function addTargetChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    // Валидация channelId
    if (!channelId || typeof channelId !== 'string') {
      safeLog('❌ Попытка добавить целевой канал с неверным ID', true);
      return reject(new Error('Неверный ID канала'));
    }

    safeLog(`➕ Добавление целевого канала: "${channelId}"`);
    
    db.run(
      'INSERT OR IGNORE INTO target_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          safeLog(`❌ Ошибка добавления целевого канала "${channelId}": ${err.message}`, true);
          reject(err);
        } else {
          safeLog(`✅ Добавлено целевых каналов: ${this.changes} - "${channelId}"`);
          resolve(this.changes);
        }
      }
    );
  });
}

function removeTargetChannel(channelId) {
  return new Promise((resolve, reject) => {
    if (!channelId) {
      return reject(new Error('ID канала не может быть пустым'));
    }

    safeLog(`🗑️ Удаление целевого канала ID: "${channelId}"`);
    
    db.run('DELETE FROM target_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        safeLog(`❌ Ошибка удаления целевого канала "${channelId}": ${err.message}`, true);
        reject(err);
      } else {
        safeLog(`✅ Удалено целевых каналов: ${this.changes} - "${channelId}"`);
        resolve(this.changes);
      }
    });
  });
}

function getTargetChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM target_channels ORDER BY channel_id', (err, rows) => {
      if (err) {
        safeLog(`❌ Ошибка получения целевых каналов: ${err.message}`, true);
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
      safeLog('❌ Попытка добавить отслеживаемый канал с неверным ID', true);
      return reject(new Error('Неверный ID канала'));
    }

    safeLog(`➕ Добавление отслеживаемого канала: "${channelId}"`);
    
    db.run(
      'INSERT OR IGNORE INTO monitored_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) {
          safeLog(`❌ Ошибка добавления отслеживаемого канала "${channelId}": ${err.message}`, true);
          reject(err);
        } else {
          safeLog(`✅ Добавлено отслеживаемых каналов: ${this.changes} - "${channelId}"`);
          resolve(this.changes);
        }
      }
    );
  });
}

function removeMonitoredChannel(channelId) {
  return new Promise((resolve, reject) => {
    if (!channelId) {
      return reject(new Error('ID канала не может быть пустым'));
    }

    safeLog(`🗑️ Удаление отслеживаемого канала ID: "${channelId}"`);
    
    db.run('DELETE FROM monitored_channels WHERE channel_id = ?', [channelId], function(err) {
      if (err) {
        safeLog(`❌ Ошибка удаления отслеживаемого канала "${channelId}": ${err.message}`, true);
        reject(err);
      } else {
        safeLog(`✅ Удалено отслеживаемых каналов: ${this.changes} - "${channelId}"`);
        resolve(this.changes);
      }
    });
  });
}

function getMonitoredChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM monitored_channels ORDER BY channel_id', (err, rows) => {
      if (err) {
        safeLog(`❌ Ошибка получения отслеживаемых каналов: ${err.message}`, true);
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
      return reject(new Error('Неполные данные для пересылаемого сообщения'));
    }

    db.run(
      'INSERT OR IGNORE INTO forwarded_messages (original_message_id, channel_id) VALUES (?, ?)',
      [originalMessageId, channelId],
      function(err) {
        if (err) {
          safeLog(`❌ Ошибка добавления пересланного сообщения ${originalMessageId}: ${err.message}`, true);
          reject(err);
        } else {
          if (this.changes > 0) {
            safeLog(`✅ Добавлено пересланное сообщение: ${originalMessageId} из канала ${channelId}`);
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
          safeLog(`❌ Ошибка проверки пересланного сообщения ${originalMessageId}: ${err.message}`, true);
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
      return reject(new Error('Ключ настройки не может быть пустым'));
    }

    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) {
        safeLog(`❌ Ошибка получения настройки ${key}: ${err.message}`, true);
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
      return reject(new Error('Неполные данные для настройки'));
    }

    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], function(err) {
      if (err) {
        safeLog(`❌ Ошибка установки настройки ${key}: ${err.message}`, true);
        reject(err);
      } else {
        safeLog(`✅ Настройка обновлена: ${key} = ${value}`);
        resolve();
      }
    });
  });
}

function countForwardedMessages() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM forwarded_messages', (err, row) => {
      if (err) {
        safeLog(`❌ Ошибка подсчета пересланных сообщений: ${err.message}`, true);
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
        safeLog(`❌ Ошибка подсчета отправленных новостей: ${err.message}`, true);
        reject(err);
      } else {
        resolve(row ? row.count : 0);
      }
    });
  });
}

// Функция для безопасного закрытия базы данных
function closeDB() {
  return new Promise((resolve) => {
    safeLog('🔒 Закрытие соединения с базой данных...');
    db.close((err) => {
      if (err) {
        safeLog(`⚠️ Ошибка при закрытии базы данных: ${err.message}`, false);
      } else {
        safeLog('✅ Соединение с базой данных закрыто');
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