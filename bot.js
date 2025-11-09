// ==========================
// 🤖 TELEGRAM BOT
// ==========================
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const fs = require('fs');
const path = require('path');

// Логирование в файл
const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMsg = `[${timestamp}] ${msg}\n`;
  logStream.write(logMsg);
  console.log(logMsg);
}

// Инициализация бота
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Временное хранение состояния пользователя (например, ожидание ввода)
const userStates = new Map();

// Главное меню
const mainMenu = Markup.keyboard([
  ['📈 Статистика', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
  ['🔄 Запустить пересылку', '⏹️ Остановить пересылку']
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

// Флаг активности пересылки
let isForwardingActive = false;

// ==========================
// 🔄 ФУНКЦИИ ПЕРЕСЫЛКИ СООБЩЕНИЙ
// ==========================

// Функция для отправки сообщения в целевые каналы
async function sendMessageToTargetChannels(message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      log('⚠️ Нет целевых каналов для отправки сообщения');
      return;
    }

    for (const targetChannel of targetChannels) {
      try {
        await bot.telegram.sendMessage(targetChannel.channel_id, message, {
          parse_mode: 'HTML',
          ...options
        });
        log(`✅ Отправлено сообщение в канал ${targetChannel.channel_id}`);
        
        // Задержка между отправками чтобы избежать лимитов
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка отправки в канал ${targetChannel.channel_id}: ${error.message}`);
      }
    }
  } catch (error) {
    log(`❌ Ошибка в sendMessageToTargetChannels: ${error.message}`);
  }
}

// Функция для пересылки сообщений из отслеживаемых каналов
async function forwardMessageFromChannel(ctx, channelId, messageId) {
  try {
    const targetChannels = await db.getTargetChannels();
    const isAlreadyForwarded = await db.isMessageForwarded(messageId, channelId);
    
    if (isAlreadyForwarded) {
      log(`⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано`);
      return;
    }

    // Получаем ключевые слова для фильтрации
    const keywords = await db.getKeywords();
    
    // Получаем текст сообщения для проверки по ключевым словам
    let messageText = '';
    try {
      const message = await ctx.telegram.getMessage(channelId, messageId);
      messageText = message.text || message.caption || '';
    } catch (e) {
      log(`⚠️ Не удалось получить текст сообщения ${messageId}: ${e.message}`);
    }

    // Если есть ключевые слова, проверяем соответствие
    if (keywords.length > 0 && messageText) {
      const hasKeyword = keywords.some(keyword => 
        messageText.toLowerCase().includes(keyword.toLowerCase())
      );
      if (!hasKeyword) {
        log(`⏩ Сообщение ${messageId} не содержит ключевых слов, пропускаем`);
        return;
      }
    }

    for (const targetChannel of targetChannels) {
      try {
        await ctx.telegram.forwardMessage(
          targetChannel.channel_id,
          channelId,
          messageId
        );
        log(`✅ Переслано сообщение ${messageId} в канал ${targetChannel.channel_id}`);
        
        // Добавляем запись о пересылке
        await db.addForwardedMessage(messageId, channelId);
        
        // Задержка между отправками чтобы избежать лимитов
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка пересылки в канал ${targetChannel.channel_id}: ${error.message}`);
      }
    }
  } catch (error) {
    log(`❌ Ошибка в forwardMessageFromChannel: ${error.message}`);
  }
}

// Функция для проверки и пересылки новых сообщений
async function checkAndForwardMessages() {
  if (!isForwardingActive) return;

  try {
    log('🔄 Проверка новых сообщений в отслеживаемых каналах...');
    
    const monitoredChannels = await db.getMonitoredChannels();
    
    for (const channel of monitoredChannels) {
      try {
        log(`🔍 Проверка канала: ${channel.channel_title || channel.channel_id}`);
        // Здесь можно добавить логику получения последних сообщений из канала
        // через Telegram API, если это необходимо
      } catch (error) {
        log(`❌ Ошибка при проверке канала ${channel.channel_id}: ${error.message}`);
      }
    }
  } catch (error) {
    log(`❌ Ошибка в checkAndForwardMessages: ${error.message}`);
  }
}

// Запуск периодической проверки
setInterval(checkAndForwardMessages, 60000); // Проверка каждую минуту

// ==========================
// ⚙️ ОБРАБОТЧИКИ КОМАНД
// ==========================

bot.start(async (ctx) => {
  await db.initializeDB();
  await newsService.initialize(sendMessageToTargetChannels);
  ctx.reply('👋 Привет! Я бот для мониторинга и пересылки новостей.', mainMenu);
});

// Главное меню
bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

// Запуск пересылки
bot.hears('🔄 Запустить пересылку', async (ctx) => {
  isForwardingActive = true;
  await newsService.startMonitoring();
  ctx.reply('✅ Пересылка сообщений активирована!', mainMenu);
  log('🔄 Пересылка сообщений активирована пользователем');
});

// Остановка пересылки
bot.hears('⏹️ Остановить пересылку', async (ctx) => {
  isForwardingActive = false;
  await newsService.stopMonitoring();
  ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
  log('⏹️ Пересылка сообщений остановлена пользователем');
});

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

bot.hears('📈 Статистика', async (ctx) => {
  try {
    const keywordsCount = (await db.getKeywords()).length;
    const targetChannelsCount = (await db.getTargetChannels()).length;
    const monitoredChannelsCount = (await db.getMonitoredChannels()).length;
    const forwardedCount = await db.countForwardedMessages();
    const sentNewsCount = await db.countSentNews();

    const msg = `
📊 Статистика бота:

🗝️ Ключевых слов: ${keywordsCount}
🎯 Целевых каналов: ${targetChannelsCount}
📡 Отслеживаемых каналов: ${monitoredChannelsCount}
📤 Пересланных сообщений: ${forwardedCount}
📰 Отправленных новостей: ${sentNewsCount}
🔄 Пересылка: ${isForwardingActive ? '✅ Активна' : '❌ Остановлена'}
    `;
    ctx.reply(msg, mainMenu);

  } catch (err) {
    console.error('❌ Ошибка при получении статистики:', err);
    ctx.reply('⚠️ Не удалось получить статистику.');
  }
});

// Обработчик новых сообщений в каналах
bot.on('channel_post', async (ctx) => {
  if (!isForwardingActive) return;

  try {
    const channelPost = ctx.channelPost;
    if (!channelPost) return;

    const channelId = channelPost.chat.id.toString();
    const messageId = channelPost.message_id;

    // Проверяем, отслеживается ли этот канал
    const monitoredChannels = await db.getMonitoredChannels();
    const isMonitored = monitoredChannels.some(ch => 
      ch.channel_id === channelId || 
      (ch.channel_username && ch.channel_username === channelPost.chat.username)
    );

    if (isMonitored) {
      log(`📨 Новое сообщение в отслеживаемом канале ${channelId}: ${messageId}`);
      await forwardMessageFromChannel(ctx, channelId, messageId);
    }
  } catch (error) {
    log(`❌ Ошибка обработки channel_post: ${error.message}`);
  }
});

// Обработчик новых постов в каналах (альтернативный вариант)
bot.on('message', async (ctx) => {
  // Обрабатываем только сообщения из каналов
  if (ctx.message && ctx.message.chat && ctx.message.chat.type === 'channel') {
    if (!isForwardingActive) return;

    try {
      const channelId = ctx.message.chat.id.toString();
      const messageId = ctx.message.message_id;

      // Проверяем, отслеживается ли этот канал
      const monitoredChannels = await db.getMonitoredChannels();
      const isMonitored = monitoredChannels.some(ch => 
        ch.channel_id === channelId || 
        (ch.channel_username && ch.channel_username === ctx.message.chat.username)
      );

      if (isMonitored) {
        log(`📨 Новое сообщение в отслеживаемом канале ${channelId}: ${messageId}`);
        await forwardMessageFromChannel(ctx, channelId, messageId);
      }
    } catch (error) {
      log(`❌ Ошибка обработки сообщения из канала: ${error.message}`);
    }
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

  // Пропускаем сообщения из каналов
  if (ctx.message.chat.type === 'channel') return;

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
async function startBot() {
  try {
    await db.initializeDB();
    await newsService.initialize(sendMessageToTargetChannels);
    bot.launch();
    log('✅ Бот запущен и готов к работе.');
    log('🔄 Для начала пересылки используйте команду "Запустить пересылку"');
  } catch (error) {
    log(`❌ Ошибка запуска бота: ${error.message}`);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));