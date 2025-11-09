const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 📊 ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ SQLite
// База создается автоматически в файле news_bot.db
const dbPath = path.join(__dirname, 'news_bot.db');
const db = new sqlite3.Database(dbPath);

// 🏗️ ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ - создаем таблицы если их нет
function initializeDB() {
  return new Promise((resolve, reject) => {
    // Таблица для ключевых слов поиска
    db.run(`CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT UNIQUE NOT NULL,      -- Само ключевое слово
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица для отправленных новостей (чтобы не дублировать)
    db.run(`CREATE TABLE IF NOT EXISTS sent_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id TEXT UNIQUE NOT NULL,      -- Уникальный ID новости
      title TEXT NOT NULL,               -- Заголовок новости
      url TEXT NOT NULL,                 -- Ссылка на новость
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица для хранения настроек бота
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,              -- Название настройки
      value TEXT NOT NULL                -- Значение настройки
    )`);

    // 🆕 ТАБЛИЦА ДЛЯ ОТСЛЕЖИВАЕМЫХ КАНАЛОВ (откуда берем новости)
    db.run(`CREATE TABLE IF NOT EXISTS monitored_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE NOT NULL,   -- ID канала
      channel_username TEXT,             -- @username канала
      channel_title TEXT,                -- Название канала
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 🆕 ТАБЛИЦА ДЛЯ ЦЕЛЕВЫХ КАНАЛОВ (куда отправляем новости)
    db.run(`CREATE TABLE IF NOT EXISTS target_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE NOT NULL,   -- ID целевого канала
      channel_username TEXT,             -- @username канала
      channel_title TEXT,                -- Название канала
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица для пересланных сообщений (защита от дублей)
    db.run(`CREATE TABLE IF NOT EXISTS forwarded_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_message_id INTEGER NOT NULL,  -- ID оригинального сообщения
      channel_id TEXT NOT NULL,              -- ID канала-источника
      forwarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(original_message_id, channel_id) -- Один message_id из одного канала
    )`, (err) => {
      if (err) {
        reject(err);
      } else {
        // 📝 УСТАНАВЛИВАЕМ НАЧАЛЬНЫЕ НАСТРОЙКИ
        const defaultSettings = [
          ['auto_post_enabled', 'true'],     // Автопостинг включен
          ['check_interval', '30'],          // Интервал 30 минут
          ['channel_monitoring_enabled', 'true']  // Мониторинг каналов включен
        ];
        
        const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        defaultSettings.forEach(([key, value]) => stmt.run(key, value));
        stmt.finalize();
        
        resolve();
      }
    });
  });
}

// 🔑 ФУНКЦИИ ДЛЯ РАБОТЫ С КЛЮЧЕВЫМИ СЛОВАМИ

// Добавить ключевое слово
function addKeyword(keyword) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [keyword], function(err) {
      if (err) reject(err);
      else resolve(this.changes); // Возвращает количество изменений
    });
  });
}

// Удалить ключевое слово
function removeKeyword(keyword) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM keywords WHERE keyword = ?', [keyword], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

// Получить все ключевые слова
function getKeywords() {
  return new Promise((resolve, reject) => {
    db.all('SELECT keyword FROM keywords ORDER BY keyword', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => row.keyword));
    });
  });
}

// 📰 ФУНКЦИИ ДЛЯ РАБОТЫ С ОТПРАВЛЕННЫМИ НОВОСТЯМИ

// Добавить отправленную новость
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

// Проверить, отправлялась ли новость
function isNewsSent(newsId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM sent_news WHERE news_id = ?', [newsId], (err, row) => {
      if (err) reject(err);
      else resolve(!!row); // true если найдена, false если нет
    });
  });
}

// 🎯 🆕 ФУНКЦИИ ДЛЯ РАБОТЫ С ЦЕЛЕВЫМИ КАНАЛАМИ (куда отправляем)

// Добавить целевой канал
function addTargetChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO target_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

// Удалить целевой канал - ПОЛНОСТЬЮ ПЕРЕПИСАННАЯ ФУНКЦИЯ
function removeTargetChannel(channelId) {
  return new Promise((resolve, reject) => {
    console.log(`🗑️ SQLite: УДАЛЕНИЕ целевого канала ID: "${channelId}"`);
    
    // Сначала проверим, существует ли канал
    db.get('SELECT * FROM target_channels WHERE channel_id = ?', [channelId], (err, row) => {
      if (err) {
        console.error('❌ Ошибка при проверке канала:', err);
        reject(err);
        return;
      }
      
      if (!row) {
        console.log('❌ Канал не найден в базе');
        resolve(0);
        return;
      }
      
      console.log(`📋 Найден канал для удаления: "${row.channel_title}" (ID: ${row.channel_id})`);
      
      // Теперь удаляем канал
      db.run('DELETE FROM target_channels WHERE channel_id = ?', [channelId], function(err) {
        if (err) {
          console.error('❌ Ошибка при удалении канала:', err);
          reject(err);
        } else {
          console.log(`✅ Удалено целевых каналов: ${this.changes}`);
          resolve(this.changes);
        }
      });
    });
  });
}

// Получить все целевые каналы
function getTargetChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM target_channels ORDER BY channel_title', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 📡 ФУНКЦИИ ДЛЯ РАБОТЫ С ОТСЛЕЖИВАЕМЫМИ КАНАЛАМИ (откуда берем)

// Добавить отслеживаемый канал
function addMonitoredChannel(channelId, username = null, title = null) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO monitored_channels (channel_id, channel_username, channel_title) VALUES (?, ?, ?)',
      [channelId, username, title],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

// Удалить отслеживаемый канал - ПОЛНОСТЬЮ ПЕРЕПИСАННАЯ ФУНКЦИЯ
function removeMonitoredChannel(channelId) {
  return new Promise((resolve, reject) => {
    console.log(`🗑️ SQLite: УДАЛЕНИЕ отслеживаемого канала ID: "${channelId}"`);
    
    // Сначала проверим, существует ли канал
    db.get('SELECT * FROM monitored_channels WHERE channel_id = ?', [channelId], (err, row) => {
      if (err) {
        console.error('❌ Ошибка при проверке канала:', err);
        reject(err);
        return;
      }
      
      if (!row) {
        console.log('❌ Канал не найден в базе');
        resolve(0);
        return;
      }
      
      console.log(`📋 Найден канал для удаления: "${row.channel_title}" (ID: ${row.channel_id})`);
      
      // Теперь удаляем канал
      db.run('DELETE FROM monitored_channels WHERE channel_id = ?', [channelId], function(err) {
        if (err) {
          console.error('❌ Ошибка при удалении канала:', err);
          reject(err);
        } else {
          console.log(`✅ Удалено отслеживаемых каналов: ${this.changes}`);
          resolve(this.changes);
        }
      });
    });
  });
}

// Получить все отслеживаемые каналы
function getMonitoredChannels() {
  return new Promise((resolve, reject) => {
    db.all('SELECT channel_id, channel_username, channel_title FROM monitored_channels ORDER BY channel_title', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 🔄 ФУНКЦИИ ДЛЯ ПЕРЕСЛАННЫХ СООБЩЕНИЙ

// Добавить пересланное сообщение
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

// Проверить, пересылалось ли сообщение
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

// ⚙️ ФУНКЦИИ ДЛЯ РАБОТЫ С НАСТРОЙКАМИ

// Получить настройку
function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.value : null);
    });
  });
}

// Установить настройку
function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Подсчет пересланных сообщений
function countForwardedMessages() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM forwarded_messages', (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

// Подсчет отправленных новостей
function countSentNews() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM sent_news', (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}


// 📤 ЭКСПОРТ ВСЕХ ФУНКЦИЙ ДЛЯ ИСПОЛЬЗОВАНИЯ В ДРУГИХ ФАЙЛАХ
module.exports = {
  initializeDB,
  // Ключевые слова
  addKeyword,
  removeKeyword,
  getKeywords,
  // Новости
  addSentNews,
  isNewsSent,
  // 🆕 Целевые каналы
  addTargetChannel,
  removeTargetChannel,
  getTargetChannels,
  // Отслеживаемые каналы
  addMonitoredChannel,
  removeMonitoredChannel,
  getMonitoredChannels,
  // Пересланные сообщения
  addForwardedMessage,
  isMessageForwarded,
  // Настройки
  getSetting,
  setSetting,
  countForwardedMessages, // ✅ добавлено
  countSentNews
};