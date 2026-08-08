const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const queue = require('./queue');
const errorHandler = require('./errorHandler');
const { botLogger } = require('./utils/logger');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const userStates = new Map(); // Добавляем timestamp для состояний

// Обновлённое главное меню с новыми кнопками YouTube
const mainMenu = Markup.keyboard([
  ['📈 Статистика', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
  ['📺 Добавить YouTube', '📋 Список YouTube', '🗑️ Удалить YouTube'],
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

// --- Вспомогательные функции для YouTube ---

// Получить массив YouTube-ссылок (фидов, которые используют микросервис)
async function getYouTubeFeeds() {
  const currentFeeds = await db.getSetting('rss_feeds') || '';
  const allFeeds = currentFeeds ? currentFeeds.split(',') : [];
  const youtubePrefix = config.YOUTUBE_RSS_SERVICE_URL;
  return allFeeds.filter(feed => feed.startsWith(youtubePrefix));
}

// Обновить список всех фидов (замена существующего списка)
async function updateAllFeeds(newFeedsArray) {
  const feedsString = newFeedsArray.join(',');
  await db.setSetting('rss_feeds', feedsString);
  // Также обновляем в newsService (передаём полный список)
  await newsService.setFeeds(newFeedsArray);
}

// --- Функции отправки и пересылки ---

async function sendMessageToTargetChannels(message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels();

    if (targetChannels.length === 0) {
      botLogger.warn('⚠️ Нет целевых каналов для отправки сообщения');
      return false;
    }

    let successCount = 0;

    for (const targetChannel of targetChannels) {
      queue.add(async () => {
        try {
          await bot.telegram.sendMessage(targetChannel.channel_id, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            ...options
          });

          botLogger.info(`✅ Отправлено сообщение в канал ${targetChannel.channel_id}`);
          successCount++;
        } catch (error) {
          errorHandler.handleError(error, `bot.js: sendMessageToTargetChannels (queue task for ${targetChannel.channel_id})`);
        }
      });
    }

    return true;
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: sendMessageToTargetChannels (outer)');
    return false;
  }
}

async function forwardMessageFromChannel(channelId, messageId) {
  try {
    const targetChannels = await db.getTargetChannels();
    const isAlreadyForwarded = await db.isMessageForwarded(messageId, channelId);

    if (isAlreadyForwarded) {
      botLogger.warn(`⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано`);
      return;
    }

    if (targetChannels.length === 0) {
      botLogger.warn('⚠️ Нет целевых каналов для пересылки');
      return;
    }

    for (const targetChannel of targetChannels) {
      queue.add(async () => {
        try {
          await bot.telegram.forwardMessage(
            targetChannel.channel_id,
            channelId,
            messageId
          );

          await db.addForwardedMessage(messageId, channelId);

          botLogger.info(`📤 Переслано сообщение ${messageId} → ${targetChannel.channel_id}`);
        } catch (error) {
          errorHandler.handleError(error, `bot.js: forwardMessageFromChannel (queue task for ${targetChannel.channel_id})`);
        }
      });
    }
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: forwardMessageFromChannel (outer)');
  }
}

// --- Управление каналами (общее) ---

async function addChannelSimple(channelIdentifier, channelType) {
  try {
    if (!channelIdentifier || typeof channelIdentifier !== 'string') {
      return {
        success: false,
        message: '❌ Неверный формат ID канала'
      };
    }

    if (channelIdentifier.startsWith('-') && !channelIdentifier.startsWith('-100')) {
      return {
        success: false,
        message: '❌ Неверный формат ID канала. Должен начинаться с -100 для супергрупп'
      };
    }

    let result;
    const channelTitle = channelType === 'target' ? `Канал ${channelIdentifier}` : `Мониторинг ${channelIdentifier}`;
    
    if (channelType === 'target') {
      result = await db.addTargetChannel(channelIdentifier, null, channelTitle);
    } else {
      result = await db.addMonitoredChannel(channelIdentifier, null, channelTitle);
    }
    
    return {
      success: result > 0,
      message: result > 0 ? 
        `✅ Канал "${channelIdentifier}" добавлен как ${channelType === 'target' ? 'целевой' : 'отслеживаемый'}` :
        `⚠️ Канал "${channelIdentifier}" уже существует в базе`
    };
  } catch (error) {
    errorHandler.handleError(error, `bot.js: addChannelSimple (${channelType})`);
    return {
      success: false,
      message: '❌ Ошибка при добавлении канала'
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

    botLogger.info(`🔍 Поиск канала для удаления: "${userText}"`);

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

    botLogger.info(`🗑️ Удаляем канал: ${found.channel_id}`);
    const removed = await removeFunc(found.channel_id);
    
    if (removed > 0) {
      ctx.reply(`✅ Канал "${found.channel_id}" удалён.`, menu);
    } else {
      ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`, menu);
    }
  } catch (error) {
    errorHandler.handleError(error, `bot.js: removeChannelSimple (${type})`);
    ctx.reply(`❌ Ошибка при удалении канала: ${error.message}`, menu);
  }
}

// --- YouTube специфичные функции ---

function isValidYouTubeUrl(input) {
  const patterns = [
    /^https?:\/\/(www\.)?youtube\.com\/@[\w-]+(\/)?$/,
    /^https?:\/\/(www\.)?youtube\.com\/c\/[\w-]+(\/)?$/,
    /^https?:\/\/(www\.)?youtube\.com\/channel\/UC[\w-]{22,}(\/)?$/,
    /^https?:\/\/youtu\.be\/[\w-]+$/,
    /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+$/,
    /^UC[\w-]{22,}$/
  ];
  return patterns.some(pattern => pattern.test(input));
}

async function handleAddYouTube(ctx, input) {
  try {
    if (!isValidYouTubeUrl(input)) {
      await ctx.reply(
        '❌ Это не похоже на ссылку YouTube.\n\n' +
        'Поддерживаются форматы:\n' +
        '• https://www.youtube.com/@ChannelName\n' +
        '• https://www.youtube.com/c/ChannelName\n' +
        '• https://www.youtube.com/channel/UCxxxx\n' +
        '• https://youtu.be/xxxxxx\n' +
        '• UCxxxxxxxxxxxxxxxxxxxxx'
      );
      return;
    }

    const serviceUrl = `${config.YOUTUBE_RSS_SERVICE_URL}?channel=${encodeURIComponent(input)}`;
    
    // Проверка доступности микросервиса
    try {
      const axios = require('axios');
      await axios.get(config.YOUTUBE_RSS_SERVICE_URL, { timeout: 3000 });
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        await ctx.reply(
          '❌ Микросервис YouTube-RSS недоступен.\n\n' +
          'Проверьте:\n' +
          '• Запущен ли сервис: pm2 status youtube-rss\n' +
          '• Корректность URL в .env: YOUTUBE_RSS_SERVICE_URL'
        );
        return;
      }
    }

    const currentFeeds = await db.getSetting('rss_feeds') || '';
    const feedsList = currentFeeds ? currentFeeds.split(',') : [];
    
    if (feedsList.includes(serviceUrl)) {
      await ctx.reply('ℹ️ Этот YouTube канал уже отслеживается.');
      return;
    }

    feedsList.push(serviceUrl);
    await db.setSetting('rss_feeds', feedsList.join(','));
    await newsService.addFeed(serviceUrl);
    
    await ctx.reply(
      '✅ YouTube канал успешно добавлен в мониторинг!\n\n' +
      `📡 RSS-ссылка: ${serviceUrl}\n\n` +
      'Новости будут приходить в целевые каналы, если совпадут с ключевыми словами.'
    );
    
    botLogger.info(`📺 Добавлен YouTube канал: ${input} -> ${serviceUrl}`);
    
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: handleAddYouTube');
    await ctx.reply(
      '❌ Произошла ошибка при добавлении канала.\n\n' +
      'Проверьте:\n' +
      '• Корректность ссылки\n' +
      '• Доступность микросервиса YouTube-RSS\n' +
      '• Логи: pm2 logs youtube-rss'
    );
  }
}

async function handleYouTubeRemove(ctx, input) {
  try {
    const youtubeFeeds = await getYouTubeFeeds();
    if (youtubeFeeds.length === 0) {
      ctx.reply('❌ Нет YouTube-каналов для удаления.', mainMenu);
      return;
    }

    let feedToRemove = null;
    let indexToRemove = -1;

    // Пытаемся интерпретировать ввод как номер
    const num = parseInt(input);
    if (!isNaN(num) && num >= 1 && num <= youtubeFeeds.length) {
      indexToRemove = num - 1;
      feedToRemove = youtubeFeeds[indexToRemove];
    } else {
      // Или как полную ссылку
      const found = youtubeFeeds.find(feed => feed === input);
      if (found) {
        feedToRemove = found;
        indexToRemove = youtubeFeeds.indexOf(found);
      }
    }

    if (!feedToRemove) {
      ctx.reply(
        '❌ Канал не найден. Проверьте номер или введите полную RSS-ссылку.\n\n' +
        'Используйте "📋 Список YouTube", чтобы увидеть доступные каналы.'
      );
      return;
    }

    // Удаляем из списка
    const allFeeds = (await db.getSetting('rss_feeds') || '').split(',').filter(f => f !== '');
    const updatedFeeds = allFeeds.filter(f => f !== feedToRemove);
    await updateAllFeeds(updatedFeeds);

    ctx.reply(`✅ YouTube-канал удалён.`, mainMenu);
    botLogger.info(`🗑️ Удалён YouTube канал: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: handleYouTubeRemove');
    ctx.reply('❌ Ошибка при удалении YouTube-канала.');
  }
}

// --- Функция завершения ---

async function shutdown() {
  botLogger.info('🔴 Завершение работы бота...');
  try {
    await bot.stop();
    process.exit(0);
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: shutdown');
    process.exit(1);
  }
}

// --- Очистка состояний ---

setInterval(() => {
  const now = Date.now();
  let clearedCount = 0;
  
  for (const [userId, stateData] of userStates.entries()) {
    if (now - stateData.timestamp > 30 * 60 * 1000) { // 30 минут
      userStates.delete(userId);
      clearedCount++;
    }
  }
  
  if (clearedCount > 0) {
    botLogger.info(`🧹 Очищено ${clearedCount} устаревших состояний пользователей`);
  }
}, 5 * 60 * 1000);

// --- Команды и кнопки ---

bot.start(async (ctx) => {
  try {
    await db.initializeDB();
    newsService.setSendFunction(sendMessageToTargetChannels);
    ctx.reply(
      '👋 Привет! Я бот для мониторинга и пересылки новостей.\n\n' +
      '📺 Управляйте YouTube каналами через кнопки в меню.',
      mainMenu
    );
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: bot.start');
    ctx.reply('❌ Ошибка при запуске бота. Проверьте логи.');
  }
});

bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

// --- YouTube управление ---

bot.hears('📺 Добавить YouTube', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_youtube_link', 
    timestamp: Date.now() 
  });
  ctx.reply(
    '📺 Отправьте ссылку на YouTube канал\n\n' +
    'Поддерживаются форматы:\n' +
    '• https://www.youtube.com/@ChannelName\n' +
    '• https://www.youtube.com/c/ChannelName\n' +
    '• https://www.youtube.com/channel/UCxxxx\n' +
    '• https://youtu.be/xxxxxx\n' +
    '• UCxxxxxxxxxxxxxxxxxxxxx\n\n' +
    'Отправьте "Отмена", чтобы отменить действие.'
  );
});

bot.hears('📋 Список YouTube', async (ctx) => {
  try {
    const youtubeFeeds = await getYouTubeFeeds();
    if (youtubeFeeds.length === 0) {
      ctx.reply('📺 Нет добавленных YouTube-каналов.', mainMenu);
      return;
    }

    let message = '📋 <b>Список YouTube-каналов:</b>\n\n';
    youtubeFeeds.forEach((feed, index) => {
      // Извлекаем параметр channel из URL для красоты
      try {
        const url = new URL(feed);
        const channelParam = url.searchParams.get('channel') || feed;
        message += `${index + 1}. ${channelParam}\n`;
      } catch {
        message += `${index + 1}. ${feed}\n`;
      }
    });
    message += '\nДля удаления используйте кнопку "🗑️ Удалить YouTube" и введите номер канала.';

    ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: hears "Список YouTube"');
    ctx.reply('❌ Ошибка при получении списка YouTube-каналов.');
  }
});

bot.hears('🗑️ Удалить YouTube', (ctx) => {
  userStates.set(ctx.from.id, {
    state: 'waiting_for_youtube_remove',
    timestamp: Date.now()
  });
  ctx.reply(
    '🗑️ Введите номер YouTube-канала для удаления.\n\n' +
    'Сначала посмотрите список командой "📋 Список YouTube".\n' +
    'Или введите полную RSS-ссылку.\n\n' +
    'Отправьте "Отмена", чтобы отменить действие.'
  );
});

// --- Основные функции бота ---

bot.hears('🔄 Запустить пересылку', async (ctx) => {
  try {
    isForwardingActive = true;
    newsService.setSendFunction(sendMessageToTargetChannels);
    await newsService.startMonitoring();
    ctx.reply('✅ Пересылка сообщений активирована!', mainMenu);
    botLogger.info('🔄 Пересылка сообщений активирована пользователем');
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: hears "Запустить пересылку"');
    ctx.reply('❌ Ошибка при активации пересылки.');
  }
});

bot.hears('⏹️ Остановить пересылку', async (ctx) => {
  try {
    isForwardingActive = false;
    await newsService.stopMonitoring();
    ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
    botLogger.info('⏹️ Пересылка сообщений остановлена пользователем');
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: hears "Остановить пересылку"');
    ctx.reply('❌ Ошибка при остановке пересылки.');
  }
});

bot.hears('🗝️ Ключевые слова', async (ctx) => {
  try {
    const keywords = await db.getKeywords();
    const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
    ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: hears "Ключевые слова"');
    ctx.reply('❌ Ошибка при получении ключевых слов.');
  }
});

bot.hears('➕ Добавить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_keyword_add', 
    timestamp: Date.now() 
  });
  ctx.reply('✏️ Введите ключевое слово для добавления:');
});

bot.hears('🗑️ Удалить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_keyword_remove', 
    timestamp: Date.now() 
  });
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
    errorHandler.handleError(error, 'bot.js: hears "Целевые каналы"');
    ctx.reply('❌ Ошибка при получении целевых каналов.');
  }
});

bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_target_channel_add', 
    timestamp: Date.now() 
  });
  ctx.reply('✏️ Введите ID целевого канала (например: -1001234567890):');
});

bot.hears('🗑️ Удалить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_target_channel_remove', 
    timestamp: Date.now() 
  });
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
    errorHandler.handleError(error, 'bot.js: hears "Мониторинг каналов"');
    ctx.reply('❌ Ошибка при получении отслеживаемых каналов.');
  }
});

bot.hears('➕ Добавить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_monitored_channel_add', 
    timestamp: Date.now() 
  });
  ctx.reply('✏️ Введите ID канала для отслеживания (например: -1001234567890):');
});

bot.hears('🗑️ Удалить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, { 
    state: 'waiting_for_monitored_channel_remove', 
    timestamp: Date.now() 
  });
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

  } catch (error) {
    errorHandler.handleError(error, 'bot.js: hears "Статистика"');
    ctx.reply('❌ Ошибка при получении статистики.');
  }
});

// --- Обработка channel_post ---

bot.on('channel_post', async (ctx) => {
  if (!isForwardingActive) return;

  try {
    const channelPost = ctx.channelPost;
    if (!channelPost) return;

    const channelId = channelPost.chat.id.toString();
    const messageId = channelPost.message_id;

    botLogger.info(`📨 Получен channel_post из канала ${channelId}: ${messageId}`);

    const monitoredChannels = await db.getMonitoredChannels();
    const isMonitored = monitoredChannels.some(ch => ch.channel_id === channelId);

    if (isMonitored) {
      botLogger.info(`🎯 Канал ${channelId} отслеживается, пересылаем сообщение ${messageId}`);
      await forwardMessageFromChannel(channelId, messageId);
    }
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: channel_post handler');
  }
});

// --- Обработка текстовых сообщений ---

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const stateData = userStates.get(userId);
  const state = stateData ? stateData.state : null;
  const text = ctx.message.text?.trim();
  
  if (!text || (ctx.message.chat && ctx.message.chat.type === 'channel')) return;

  try {
    // Обработка отмены для всех состояний
    if (text.toLowerCase() === 'отмена' && state) {
      userStates.delete(userId);
      ctx.reply('❌ Действие отменено. Возвращаюсь в главное меню.', mainMenu);
      return;
    }

    // Состояния
    if (state === 'waiting_for_youtube_link') {
      await handleAddYouTube(ctx, text);
      userStates.delete(userId);
      return;
    }

    if (state === 'waiting_for_youtube_remove') {
      await handleYouTubeRemove(ctx, text);
      userStates.delete(userId);
      return;
    }

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

  } catch (error) {
    errorHandler.handleError(error, 'bot.js: message handler (state processing)');
    ctx.reply('❌ Произошла ошибка при обработке команды.');
  }
});

// --- Запуск бота ---

async function startBot() {
  try {
    botLogger.info('🚀 Запуск бота...');
    
    let dbInitialized = false;
    let attempts = 0;
    while (!dbInitialized && attempts < 3) {
      try {
        await db.initializeDB();
        dbInitialized = true;
        botLogger.info('✅ База данных инициализирована');
      } catch (error) {
        attempts++;
        errorHandler.handleError(error, `bot.js: startBot (DB init attempt ${attempts})`);
        botLogger.warn(`⚠️ Попытка инициализации БД #${attempts} не удалась`);
        if (attempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (!dbInitialized) {
      botLogger.error('❌ Не удалось инициализировать БД после 3 попыток. Завершаем работу.');
      process.exit(1);
    }

    await newsService.initialize();
    await bot.launch();
    botLogger.info('✅ Бот запущен и готов к работе.');
    newsService.setSendFunction(sendMessageToTargetChannels);
    botLogger.info('✅ Функция отправки установлена');
  } catch (error) {
    errorHandler.handleError(error, 'bot.js: startBot (outer)');
    botLogger.error('❌ Критическая ошибка при запуске бота. Завершаем работу.');
    process.exit(1);
  }
}

// --- Глобальные обработчики ---

process.on('unhandledRejection', (reason) => {
  errorHandler.handleError(reason, 'GLOBAL: unhandledRejection');
});

process.on('uncaughtException', (error) => {
  errorHandler.handleError(error, 'GLOBAL: uncaughtException');
  setTimeout(() => process.exit(1), 1000);
});

startBot();

process.once('SIGINT', () => {
  botLogger.info('⏹️ Остановка бота по SIGINT');
  shutdown();
});

process.once('SIGTERM', () => {
  botLogger.info('⏹️ Остановка бота по SIGTERM');
  shutdown();
});