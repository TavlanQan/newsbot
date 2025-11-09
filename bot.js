// ==========================
// 🤖 TELEGRAM BOT
// ==========================
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const config = require('./config');
const fs = require('fs');
const path = require('path');

// Логирование в файл
const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  logStream.write(`[${timestamp}] ${msg}\n`);
  console.log(msg);
}

// Инициализация бота
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Временное хранение состояния пользователя (например, ожидание ввода)
const userStates = new Map();

// Главное меню
const mainMenu = Markup.keyboard([
  ['⚙️ Настройки', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
]).resize();

// Меню ключевых слов
const keywordsMenu = Markup.keyboard([
  ['➕ Добавить ключевое слово', '🗑️ Удалить ключевое слово'],
  ['⬅️ Назад']
]).resize();

// Меню целевых каналов
const targetChannelsMenu = Markup.keyboard([
  ['➕ Добавить целевой канал', '🗑️ Удалить целевой канал'],
  ['⬅️ Назад']
]).resize();

// Меню мониторинга каналов
const monitoredChannelsMenu = Markup.keyboard([
  ['➕ Добавить отслеживаемый канал', '🗑️ Удалить отслеживаемый канал'],
  ['⬅️ Назад']
]).resize();


// ==========================
// ⚙️ ОБРАБОТЧИКИ КОМАНД
// ==========================

bot.start(async (ctx) => {
  await db.initializeDB();
  ctx.reply('👋 Привет! Я бот для мониторинга и пересылки новостей.', mainMenu);
});

// Главное меню
bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

// Меню ключевых слов
bot.hears('🗝️ Ключевые слова', async (ctx) => {
  const keywords = await db.getKeywords();
  const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
  ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
});

// Добавление ключевого слова
bot.hears('➕ Добавить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_add');
  ctx.reply('✏️ Введите ключевое слово для добавления:');
});

// Удаление ключевого слова
bot.hears('🗑️ Удалить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_remove');
  ctx.reply('🗑️ Введите ключевое слово для удаления:');
});

// Меню целевых каналов
bot.hears('🎯 Целевые каналы', async (ctx) => {
  const channels = await db.getTargetChannels();
  const list = channels.length
    ? channels.map(c => `🔹 ${c.channel_title || ''} (${c.channel_username || c.channel_id})`).join('\n')
    : '— нет —';
  ctx.reply(`🎯 Целевые каналы:\n${list}`, targetChannelsMenu);
});

// Добавление целевого канала
bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_add');
  ctx.reply('✏️ Введите @username или ID канала для добавления:');
});

// Удаление целевого канала
bot.hears('🗑️ Удалить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_remove');
  ctx.reply('🗑️ Введите @username, ID или часть названия канала для удаления:');
});

// Меню мониторинга каналов
bot.hears('📡 Мониторинг каналов', async (ctx) => {
  const channels = await db.getMonitoredChannels();
  const list = channels.length
    ? channels.map(c => `🔹 ${c.channel_title || ''} (${c.channel_username || c.channel_id})`).join('\n')
    : '— нет —';
  ctx.reply(`📡 Отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
});

// Добавление отслеживаемого канала
bot.hears('➕ Добавить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_add');
  ctx.reply('✏️ Введите @username или ID канала для добавления:');
});

// Удаление отслеживаемого канала
bot.hears('🗑️ Удалить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_remove');
  ctx.reply('🗑️ Введите @username, ID или часть названия канала для удаления:');
});

// 📊 Статистика
bot.hears('📈 Статистика', async (ctx) => {
  try {
    // Количество ключевых слов
    const keywords = await db.getKeywords();
    const keywordsCount = keywords.length;

    // Количество целевых каналов
    const targetChannels = await db.getTargetChannels();
    const targetChannelsCount = targetChannels.length;

    // Количество отслеживаемых каналов
    const monitoredChannels = await db.getMonitoredChannels();
    const monitoredChannelsCount = monitoredChannels.length;

    // Количество пересланных сообщений
    const forwardedCount = await new Promise((resolve, reject) => {
      db.db.get('SELECT COUNT(*) as count FROM forwarded_messages', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Количество отправленных новостей
    const sentNewsCount = await new Promise((resolve, reject) => {
      db.db.get('SELECT COUNT(*) as count FROM sent_news', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Отправляем статистику
    const msg = `
📊 Статистика бота:

🗝️ Ключевых слов: ${keywordsCount}
🎯 Целевых каналов: ${targetChannelsCount}
📡 Отслеживаемых каналов: ${monitoredChannelsCount}
📤 Пересланных сообщений: ${forwardedCount}
📰 Отправленных новостей: ${sentNewsCount}
    `;
    ctx.reply(msg, mainMenu);

  } catch (err) {
    console.error('❌ Ошибка при получении статистики:', err);
    ctx.reply('⚠️ Не удалось получить статистику.');
  }
});


// ==========================
// 🧠 ОБРАБОТКА ВВОДА ПОЛЬЗОВАТЕЛЯ
// ==========================
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text?.trim();
  if (!text) return;

  try {
    // ➕ Добавление ключевого слова
    if (state === 'waiting_for_keyword_add') {
      const added = await db.addKeyword(text);
      userStates.delete(userId);
      if (added > 0) ctx.reply(`✅ Ключевое слово "${text}" добавлено.`, keywordsMenu);
      else ctx.reply(`⚠️ Слово "${text}" уже существует.`, keywordsMenu);
      return;
    }

    // 🗑️ Удаление ключевого слова
    if (state === 'waiting_for_keyword_remove') {
      const keywords = await db.getKeywords();
      const keywordToRemove = keywords.find(k => k.toLowerCase() === text.toLowerCase());
      if (!keywordToRemove) {
        ctx.reply(`❌ Слово "${text}" не найдено.`, keywordsMenu);
      } else {
        await db.removeKeyword(keywordToRemove);
        ctx.reply(`✅ Ключевое слово "${keywordToRemove}" удалено.`, keywordsMenu);
      }
      userStates.delete(userId);
      return;
    }

    // ➕ Добавление целевого канала
    if (state === 'waiting_for_target_channel_add') {
      const added = await db.addTargetChannel(text);
      userStates.delete(userId);
      ctx.reply(added > 0 ? `✅ Канал "${text}" добавлен.` : `⚠️ Канал "${text}" уже есть.`, targetChannelsMenu);
      return;
    }

    // ➕ Добавление отслеживаемого канала
    if (state === 'waiting_for_monitored_channel_add') {
      const added = await db.addMonitoredChannel(text);
      userStates.delete(userId);
      ctx.reply(added > 0 ? `✅ Канал "${text}" добавлен.` : `⚠️ Канал "${text}" уже есть.`, monitoredChannelsMenu);
      return;
    }

    // 🗑️ Удаление целевого канала
    if (state === 'waiting_for_target_channel_remove') {
      await removeChannelWithDebug(ctx, text, 'target');
      userStates.delete(userId);
      return;
    }

    // 🗑️ Удаление отслеживаемого канала
    if (state === 'waiting_for_monitored_channel_remove') {
      await removeChannelWithDebug(ctx, text, 'monitored');
      userStates.delete(userId);
      return;
    }

  } catch (err) {
    console.error('❌ Ошибка при обработке ввода:', err);
    ctx.reply('⚠️ Произошла ошибка. Проверьте лог.');
  }
});


// ==========================
// 🧩 УДАЛЕНИЕ КАНАЛОВ
// ==========================
async function removeChannelWithDebug(ctx, userText, type) {
  const isTarget = type === 'target';
  const getFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const menu = isTarget ? targetChannelsMenu : monitoredChannelsMenu;

  const allChannels = await getFunc();
  const cleanInput = userText.replace('@', '').toLowerCase().trim();

  const found = allChannels.find(ch => {
    const id = ch.channel_id?.toString().toLowerCase().trim() || '';
    const username = ch.channel_username?.replace('@', '').toLowerCase().trim() || '';
    const title = ch.channel_title?.toLowerCase().trim() || '';
    return (
      id.includes(cleanInput) ||
      username.includes(cleanInput) ||
      title.includes(cleanInput)
    );
  });

  if (!found) {
    ctx.reply(`❌ Канал "${userText}" не найден.`, menu);
    return;
  }

  const removed = await removeFunc(found.channel_id);
  if (removed > 0) {
    ctx.reply(`✅ Канал "${found.channel_title || found.channel_username || found.channel_id}" удалён.`, menu);
  } else {
    ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`, menu);
  }
}


// ==========================
// 🚀 ЗАПУСК
// ==========================
bot.launch();
log('✅ Бот запущен и готов к работе.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
