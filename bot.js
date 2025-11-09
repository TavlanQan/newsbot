const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const fs = require('fs');
const path = require('path');

const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMsg = `[${timestamp}] ${msg}\n`;
  logStream.write(logMsg);
  console.log(logMsg);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map();

const mainMenu = Markup.keyboard([
  ['📈 Статистика', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
  ['🔄 Запустить пересылку', '⏹️ Остановить пересылку']
]).resize();

const keywordsMenu = Markup.keyboard([
  ['➕ Добавить ключевое слово', '🗑️ Удалить ключевое слово'],
  ['⬅️ Назад']
]).resize();

const targetChannelsMenu = Markup.keyboard([
  ['➕ Добавить целевой канал', '🗑️ Удалить целевой канал'],
  ['⬅️ Назад']
]).resize();

const monitoredChannelsMenu = Markup.keyboard([
  ['➕ Добавить отслеживаемый канал', '🗑️ Удалить отслеживаемый канал'],
  ['⬅️ Назад']
]).resize();

let isForwardingActive = false;

async function sendMessageToTargetChannels(message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      log('⚠️ Нет целевых каналов для отправки сообщения');
      return false;
    }

    let successCount = 0;
    for (const targetChannel of targetChannels) {
      try {
        await bot.telegram.sendMessage(targetChannel.channel_id, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...options
        });
        log(`✅ Отправлено сообщение в канал ${targetChannel.channel_id}`);
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка отправки в канал ${targetChannel.channel_id}: ${error.message}`);
      }
    }
    
    return successCount > 0;
  } catch (error) {
    log(`❌ Ошибка в sendMessageToTargetChannels: ${error.message}`);
    return false;
  }
}

async function forwardMessageFromChannel(channelId, messageId) {
  try {
    const targetChannels = await db.getTargetChannels();
    const isAlreadyForwarded = await db.isMessageForwarded(messageId, channelId);
    
    if (isAlreadyForwarded) {
      log(`⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано`);
      return;
    }

    if (targetChannels.length === 0) {
      log('⚠️ Нет целевых каналов для пересылки');
      return;
    }

    let successCount = 0;
    for (const targetChannel of targetChannels) {
      try {
        await bot.telegram.forwardMessage(
          targetChannel.channel_id,
          channelId,
          messageId
        );
        log(`✅ Переслано сообщение ${messageId} в канал ${targetChannel.channel_id}`);
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка пересылки в канал ${targetChannel.channel_id}: ${error.message}`);
      }
    }
    
    if (successCount > 0) {
      await db.addForwardedMessage(messageId, channelId);
    }
    
  } catch (error) {
    log(`❌ Ошибка в forwardMessageFromChannel: ${error.message}`);
  }
}

async function addChannelSimple(channelIdentifier, channelType) {
  try {
    let result;
    if (channelType === 'target') {
      result = await db.addTargetChannel(channelIdentifier, channelIdentifier, channelIdentifier);
    } else {
      result = await db.addMonitoredChannel(channelIdentifier, channelIdentifier, channelIdentifier);
    }
    
    return {
      success: result > 0,
      message: result > 0 ? 
        `✅ Канал "${channelIdentifier}" добавлен как ${channelType === 'target' ? 'целевой' : 'отслеживаемый'}` :
        `⚠️ Канал "${channelIdentifier}" уже существует в базе`
    };
  } catch (error) {
    log(`❌ Ошибка добавления канала ${channelIdentifier}: ${error.message}`);
    return {
      success: false,
      message: `❌ Ошибка добавления канала: ${error.message}`
    };
  }
}

async function removeChannelSimple(ctx, userText, type) {
  const isTarget = type === 'target';
  const getFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const menu = isTarget ? targetChannelsMenu : monitoredChannelsMenu;

  try {
    const allChannels = await getFunc();
    
    if (allChannels.length === 0) {
      ctx.reply(`❌ Нет ${isTarget ? 'целевых' : 'отслеживаемых'} каналов для удаления.`, menu);
      return;
    }

    log(`🔍 Поиск канала для удаления: "${userText}"`);

    const found = allChannels.find(ch => 
      ch.channel_id === userText ||
      (ch.channel_username && ch.channel_username.includes(userText)) ||
      (ch.channel_title && ch.channel_title.includes(userText))
    );

    if (!found) {
      const availableChannels = allChannels.map(ch => 
        `- ${ch.channel_id} (${ch.channel_title || 'без названия'})`
      ).join('\n');
      
      ctx.reply(
        `❌ Канал "${userText}" не найден.\n\nДоступные каналы:\n${availableChannels}`,
        menu
      );
      return;
    }

    log(`🗑️ Удаляем канал: ${found.channel_id}`);
    const removed = await removeFunc(found.channel_id);
    
    if (removed > 0) {
      ctx.reply(`✅ Канал "${found.channel_id}" удалён.`, menu);
    } else {
      ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`, menu);
    }
  } catch (err) {
    log(`❌ Ошибка при удалении канала: ${err.message}`);
    ctx.reply('❌ Произошла ошибка при удалении канала.', menu);
  }
}

bot.start(async (ctx) => {
  try {
    await db.initializeDB();
    newsService.setSendFunction(sendMessageToTargetChannels);
    ctx.reply('👋 Привет! Я бот для мониторинга и пересылки новостей.', mainMenu);
  } catch (error) {
    log(`❌ Ошибка в команде start: ${error.message}`);
    ctx.reply('❌ Произошла ошибка при инициализации бота.');
  }
});

bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

bot.hears('🔄 Запустить пересылку', async (ctx) => {
  isForwardingActive = true;
  newsService.setSendFunction(sendMessageToTargetChannels);
  await newsService.startMonitoring();
  ctx.reply('✅ Пересылка сообщений активирована!', mainMenu);
  log('🔄 Пересылка сообщений активирована пользователем');
});

bot.hears('⏹️ Остановить пересылку', async (ctx) => {
  isForwardingActive = false;
  await newsService.stopMonitoring();
  ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
  log('⏹️ Пересылка сообщений остановлена пользователем');
});

bot.hears('🗝️ Ключевые слова', async (ctx) => {
  try {
    const keywords = await db.getKeywords();
    const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
    ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении ключевых слов.');
  }
});

bot.hears('➕ Добавить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_add');
  ctx.reply('✏️ Введите ключевое слово для добавления:');
});

bot.hears('🗑️ Удалить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_remove');
  ctx.reply('🗑️ Введите ключевое слово для удаления:');
});

bot.hears('🎯 Целевые каналы', async (ctx) => {
  try {
    const channels = await db.getTargetChannels();
    const list = channels.length
      ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
      : '— нет —';
    ctx.reply(`🎯 Целевые каналы:\n${list}`, targetChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка целевых каналов.');
  }
});

bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_add');
  ctx.reply('✏️ Введите ID целевого канала (например: -1001234567890):');
});

bot.hears('🗑️ Удалить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_remove');
  ctx.reply('🗑️ Введите ID целевого канала для удаления:');
});

bot.hears('📡 Мониторинг каналов', async (ctx) => {
  try {
    const channels = await db.getMonitoredChannels();
    const list = channels.length
      ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
      : '— нет —';
    ctx.reply(`📡 Отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка отслеживаемых каналов.');
  }
});

bot.hears('➕ Добавить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_add');
  ctx.reply('✏️ Введите ID канала для отслеживания (например: -1001234567890):');
});

bot.hears('🗑️ Удалить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_remove');
  ctx.reply('🗑️ Введите ID отслеживаемого канала для удаления:');
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

bot.on('channel_post', async (ctx) => {
  if (!isForwardingActive) return;

  try {
    const channelPost = ctx.channelPost;
    if (!channelPost) return;

    const channelId = channelPost.chat.id.toString();
    const messageId = channelPost.message_id;

    log(`📨 Получен channel_post из канала ${channelId}: ${messageId}`);

    const monitoredChannels = await db.getMonitoredChannels();
    const isMonitored = monitoredChannels.some(ch => ch.channel_id === channelId);

    if (isMonitored) {
      log(`🎯 Канал ${channelId} отслеживается, пересылаем сообщение ${messageId}`);
      await forwardMessageFromChannel(channelId, messageId);
    }
  } catch (error) {
    log(`❌ Ошибка обработки channel_post: ${error.message}`);
  }
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text?.trim();
  
  if (!text || (ctx.message.chat && ctx.message.chat.type === 'channel')) return;

  try {
    if (state === 'waiting_for_keyword_add') {
      const added = await db.addKeyword(text);
      userStates.delete(userId);
      if (added > 0) {
        ctx.reply(`✅ Ключевое слово "${text}" добавлено.`, keywordsMenu);
      } else {
        ctx.reply(`⚠️ Слово "${text}" уже существует.`, keywordsMenu);
      }
      return;
    }

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

    if (state === 'waiting_for_target_channel_add') {
      const result = await addChannelSimple(text, 'target');
      userStates.delete(userId);
      ctx.reply(result.message, targetChannelsMenu);
      return;
    }

    if (state === 'waiting_for_monitored_channel_add') {
      const result = await addChannelSimple(text, 'monitored');
      userStates.delete(userId);
      ctx.reply(result.message, monitoredChannelsMenu);
      return;
    }

    if (state === 'waiting_for_target_channel_remove') {
      await removeChannelSimple(ctx, text, 'target');
      userStates.delete(userId);
      return;
    }

    if (state === 'waiting_for_monitored_channel_remove') {
      await removeChannelSimple(ctx, text, 'monitored');
      userStates.delete(userId);
      return;
    }

  } catch (err) {
    console.error('❌ Ошибка при обработке ввода:', err);
    ctx.reply('⚠️ Произошла ошибка. Проверьте лог.');
  }
});

async function startBot() {
  try {
    log('🚀 Запуск бота...');
    await db.initializeDB();
    await newsService.initialize();
    await bot.launch();
    log('✅ Бот запущен и готов к работе.');
    newsService.setSendFunction(sendMessageToTargetChannels);
    log('✅ Функция отправки установлена');
  } catch (error) {
    log(`❌ Критическая ошибка запуска бота: ${error.message}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  log(`❌ Необработанное отклонение promise: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log(`❌ Непойманное исключение: ${error.message}`);
  process.exit(1);
});

startBot();

process.once('SIGINT', () => {
  log('⏹️ Остановка бота по SIGINT');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  log('⏹️ Остановка бота по SIGTERM');
  bot.stop('SIGTERM');
  process.exit(0);
});