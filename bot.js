const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf('ТОКЕН_ТВОЕГО_БОТА');

// Состояния пользователей
const userStates = new Map();

// Главное меню
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['📚 Ключевые слова', '🎯 Целевые каналы'],
      ['📡 Отслеживаемые каналы'],
      ['⚙️ Настройки']
    ],
    resize_keyboard: true
  }
};

// Меню ключевых слов
const keywordsMenu = {
  reply_markup: {
    keyboard: [
      ['➕ Добавить слово', '🗑️ Удалить слово'],
      ['⬅️ Назад']
    ],
    resize_keyboard: true
  }
};

// Меню целевых каналов
const targetChannelsMenu = {
  reply_markup: {
    keyboard: [
      ['➕ Добавить целевой канал', '🗑️ Удалить целевой канал'],
      ['⬅️ Назад']
    ],
    resize_keyboard: true
  }
};

// Меню отслеживаемых каналов
const monitoredChannelsMenu = {
  reply_markup: {
    keyboard: [
      ['➕ Добавить отслеживаемый канал', '🗑️ Удалить отслеживаемый канал'],
      ['⬅️ Назад']
    ],
    resize_keyboard: true
  }
};

// Старт
bot.start((ctx) => {
  ctx.reply('👋 Привет! Это бот новостей.', mainMenu);
});

// Главное меню
bot.hears('⬅️ Назад', (ctx) => {
  userStates.delete(ctx.from.id);
  ctx.reply('Главное меню:', mainMenu);
});

// === 📚 КЛЮЧЕВЫЕ СЛОВА ===
bot.hears('📚 Ключевые слова', async (ctx) => {
  const keywords = await db.getKeywords();
  const list = keywords.length ? keywords.join(', ') : 'Пока нет слов.';
  ctx.reply(`📖 Список ключевых слов:\n${list}`, keywordsMenu);
});

bot.hears('➕ Добавить слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_add');
  ctx.reply('Введите ключевое слово для добавления:');
});

bot.hears('🗑️ Удалить слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_remove');
  ctx.reply('Введите ключевое слово для удаления:');
});

// === 🎯 ЦЕЛЕВЫЕ КАНАЛЫ ===
bot.hears('🎯 Целевые каналы', async (ctx) => {
  const channels = await db.getTargetChannels();
  const list = channels.length
    ? channels.map(c => `• ${c.channel_title || c.channel_username || c.channel_id}`).join('\n')
    : 'Нет целевых каналов.';
  ctx.reply(`🎯 Целевые каналы:\n${list}`, targetChannelsMenu);
});

bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_add');
  ctx.reply('Введите ID, username или ссылку канала:');
});

bot.hears('🗑️ Удалить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_remove');
  ctx.reply('Введите ID, username или название канала для удаления:');
});

// === 📡 ОТСЛЕЖИВАЕМЫЕ КАНАЛЫ ===
bot.hears('📡 Отслеживаемые каналы', async (ctx) => {
  const channels = await db.getMonitoredChannels();
  const list = channels.length
    ? channels.map(c => `• ${c.channel_title || c.channel_username || c.channel_id}`).join('\n')
    : 'Нет отслеживаемых каналов.';
  ctx.reply(`📡 Отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
});

bot.hears('➕ Добавить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_add');
  ctx.reply('Введите ID, username или ссылку отслеживаемого канала:');
});

bot.hears('🗑️ Удалить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_remove');
  ctx.reply('Введите ID, username или название канала для удаления:');
});

// === 📤 ОБРАБОТКА СООБЩЕНИЙ ДЛЯ СОСТОЯНИЙ ===
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text?.trim();

  if (!text) return;

  // ➕ Добавление слова
  if (state === 'waiting_for_keyword_add') {
    await db.addKeyword(text);
    userStates.delete(userId);
    const keywords = await db.getKeywords();
    ctx.reply(`✅ Добавлено слово "${text}".\n\n📖 Все слова:\n${keywords.join(', ')}`, keywordsMenu);
    return;
  }

  // 🗑️ Удаление слова
  if (state === 'waiting_for_keyword_remove') {
    const keywords = await db.getKeywords();
    const toRemove = keywords.find(k => k.toLowerCase() === text.toLowerCase());
    if (!toRemove) {
      ctx.reply(`❌ Слово "${text}" не найдено.`, keywordsMenu);
      return;
    }
    await db.removeKeyword(toRemove);
    userStates.delete(userId);
    ctx.reply(`✅ Удалено слово "${toRemove}".`, keywordsMenu);
    return;
  }

  // ➕ Добавление целевого канала
  if (state === 'waiting_for_target_channel_add') {
    await db.addTargetChannel(text);
    userStates.delete(userId);
    ctx.reply(`✅ Целевой канал "${text}" добавлен.`, targetChannelsMenu);
    return;
  }

  // ➕ Добавление отслеживаемого канала
  if (state === 'waiting_for_monitored_channel_add') {
    await db.addMonitoredChannel(text);
    userStates.delete(userId);
    ctx.reply(`✅ Отслеживаемый канал "${text}" добавлен.`, monitoredChannelsMenu);
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
});

// === 🧩 ФУНКЦИЯ УДАЛЕНИЯ КАНАЛА ===
async function removeChannelWithDebug(ctx, userText, type) {
  const getChannelsFunc = type === 'target' ? db.getTargetChannels : db.getMonitoredChannels;
  const removeChannelFunc = type === 'target' ? db.removeTargetChannel : db.removeMonitoredChannel;

  const channels = await getChannelsFunc();
  const cleanInput = userText.replace('@', '').toLowerCase().trim();

  const found = channels.find(ch => {
    const id = ch.channel_id?.toString().toLowerCase() || '';
    const username = ch.channel_username?.toLowerCase() || '';
    const title = ch.channel_title?.toLowerCase() || '';
    return (
      id.includes(cleanInput) ||
      username.includes(cleanInput) ||
      title.includes(cleanInput)
    );
  });

  if (!found) {
    ctx.reply(`❌ Канал "${userText}" не найден.`);
    return;
  }

  const removed = await removeChannelFunc(found.channel_id);
  if (removed > 0) {
    ctx.reply(`✅ Канал "${found.channel_title || found.channel_username || found.channel_id}" удалён.`);
  } else {
    ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`);
  }
}

// === 🚀 ЗАПУСК ===
(async () => {
  await db.initializeDB();
  console.log('✅ База данных готова.');
  bot.launch();
  console.log('🤖 Бот запущен.');
})();
