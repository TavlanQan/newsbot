// helpers.js
const axios = require('axios');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const db = require('./db');
const config = require('./config');
const queue = require('./queue');

// ---------- Общие функции для каналов (с user_id) ----------
async function addChannelSimple(userId, channelIdentifier, channelType) {
  try {
    if (!channelIdentifier || typeof channelIdentifier !== 'string') {
      return { success: false, message: '❌ Неверный формат ID канала' };
    }
    if (channelIdentifier.startsWith('-') && !channelIdentifier.startsWith('-100')) {
      return { success: false, message: '❌ Неверный формат ID канала. Должен начинаться с -100 для супергрупп' };
    }
    let result;
    const channelTitle = channelType === 'target' ? `Канал ${channelIdentifier}` : `Мониторинг ${channelIdentifier}`;
    if (channelType === 'target') {
      result = await db.addTargetChannel(userId, channelIdentifier, null, channelTitle);
    } else {
      result = await db.addMonitoredChannel(userId, channelIdentifier, null, channelTitle);
    }
    return {
      success: result > 0,
      message: result > 0
        ? `✅ Канал "${channelIdentifier}" добавлен как ${channelType === 'target' ? 'целевой' : 'отслеживаемый'}`
        : `⚠️ Канал "${channelIdentifier}" уже существует в базе`
    };
  } catch (error) {
    errorHandler.handleError(error, `helpers.js: addChannelSimple (${channelType})`);
    return { success: false, message: '❌ Ошибка при добавлении канала' };
  }
}

async function removeChannelSimple(ctx, userText, type, menus, userId) {
  const isTarget = type === 'target';
  const getFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const menu = isTarget ? menus.targetChannelsMenu : menus.monitoredChannelsMenu;

  try {
    const allChannels = await getFunc(userId);
    if (allChannels.length === 0) {
      await ctx.reply(`❌ Нет ${isTarget ? 'целевых' : 'отслеживаемых'} каналов для удаления.`, menu);
      return;
    }
    const found = allChannels.find(ch =>
      ch.channel_id === userText ||
      (ch.channel_username && ch.channel_username.includes(userText)) ||
      (ch.channel_title && ch.channel_title.includes(userText))
    );
    if (!found) {
      const availableChannels = allChannels.map(ch =>
        `- ${ch.channel_id} (${ch.channel_title || 'без названия'})`
      ).join('\n');
      await ctx.reply(`❌ Канал "${userText}" не найден.\n\nДоступные каналы:\n${availableChannels}`, menu);
      return;
    }
    const removed = await removeFunc(userId, found.channel_id);
    if (removed > 0) {
      await ctx.reply(`✅ Канал "${found.channel_id}" удалён.`, menu);
    } else {
      await ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`, menu);
    }
  } catch (error) {
    errorHandler.handleError(error, `helpers.js: removeChannelSimple (${type})`);
    await ctx.reply(`❌ Ошибка при удалении канала: ${error.message}`, menu);
  }
}

// ---------- Функции отправки и пересылки (с user_id) ----------
async function sendMessageToTargetChannels(bot, userId, message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels(userId);
    if (targetChannels.length === 0) {
      botLogger.warn(`⚠️ У пользователя ${userId} нет целевых каналов для отправки сообщения`);
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
          botLogger.info(`✅ Отправлено сообщение в канал ${targetChannel.channel_id} (пользователь ${userId})`);
          successCount++;
        } catch (error) {
          errorHandler.handleError(error, `helpers.js: sendMessageToTargetChannels (queue task for ${targetChannel.channel_id})`);
        }
      });
    }
    return true;
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: sendMessageToTargetChannels (outer)');
    return false;
  }
}

async function forwardMessageFromChannel(bot, userId, channelId, messageId) {
  try {
    const targetChannels = await db.getTargetChannels(userId);
    const isAlreadyForwarded = await db.isMessageForwarded(messageId, channelId);
    if (isAlreadyForwarded) {
      botLogger.warn(`⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано (пользователь ${userId})`);
      return;
    }
    if (targetChannels.length === 0) {
      botLogger.warn(`⚠️ У пользователя ${userId} нет целевых каналов для пересылки`);
      return;
    }
    for (const targetChannel of targetChannels) {
      queue.add(async () => {
        try {
          await bot.telegram.forwardMessage(targetChannel.channel_id, channelId, messageId);
          await db.addForwardedMessage(messageId, channelId);
          botLogger.info(`📤 Переслано сообщение ${messageId} → ${targetChannel.channel_id} (пользователь ${userId})`);
        } catch (error) {
          errorHandler.handleError(error, `helpers.js: forwardMessageFromChannel (queue task for ${targetChannel.channel_id})`);
        }
      });
    }
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: forwardMessageFromChannel (outer)');
  }
}

// ---------- YouTube функции (с user_id) ----------
async function getYouTubeFeeds(userId) {
  const feeds = await db.getUserFeeds(userId);
  const youtubePrefix = config.YOUTUBE_RSS_SERVICE_URL;
  return feeds.filter(feed => feed.startsWith(youtubePrefix));
}

async function updateAllFeeds(userId, newFeedsArray) {
  const currentFeeds = await db.getUserFeeds(userId);
  for (const feed of currentFeeds) {
    await db.removeUserFeed(userId, feed);
  }
  for (const feed of newFeedsArray) {
    await db.addUserFeed(userId, feed);
  }
}

// ---------- Улучшенная валидация YouTube-ссылок ----------
function isValidYouTubeUrl(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  // Прямой channel ID (UC...)
  if (/^UC[\w-]{22,}$/.test(trimmed)) return true;

  try {
    const url = new URL(trimmed);
    // Протокол должен быть http или https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    // Допустимые хосты
    const validHosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtu.be'];
    if (!validHosts.includes(url.hostname)) return false;

    // Для youtu.be проверяем, что есть path
    if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
      return url.pathname.length > 1;
    }

    // Для youtube.com проверяем пути
    return (
      url.pathname.startsWith('/@') ||
      url.pathname.startsWith('/c/') ||
      url.pathname.startsWith('/channel/UC') ||
      url.pathname === '/watch'
    );
  } catch {
    return false;
  }
}

// ---------- Добавление YouTube-канала (исправленное) ----------
async function handleAddYouTube(ctx, input, youtubeMenu, userId) {
  try {
    // Очищаем входную строку
    const cleanedInput = input.trim();
    botLogger.info(`YouTube input (cleaned): ${cleanedInput}`);

    if (!isValidYouTubeUrl(cleanedInput)) {
      await ctx.reply(
        '❌ Это не похоже на ссылку YouTube.\n\n' +
        'Поддерживаются форматы:\n' +
        '• https://www.youtube.com/@ChannelName\n' +
        '• https://www.youtube.com/c/ChannelName\n' +
        '• https://www.youtube.com/channel/UCxxxx\n' +
        '• https://youtu.be/xxxxxx\n' +
        '• UCxxxxxxxxxxxxxxxxxxxxx',
        youtubeMenu
      );
      return;
    }

    // Проверка и очистка URL микросервиса
    const serviceUrlRaw = config.YOUTUBE_RSS_SERVICE_URL;
    if (!serviceUrlRaw || typeof serviceUrlRaw !== 'string') {
      await ctx.reply(
        '❌ Переменная YOUTUBE_RSS_SERVICE_URL не задана в .env.\n' +
        'Пример: YOUTUBE_RSS_SERVICE_URL=http://localhost:5004/rss',
        youtubeMenu
      );
      return;
    }
    const serviceUrl = serviceUrlRaw.trim();
    if (!serviceUrl.startsWith('http://') && !serviceUrl.startsWith('https://')) {
      await ctx.reply(
        '❌ YOUTUBE_RSS_SERVICE_URL должен начинаться с http:// или https://.\n' +
        'Текущее значение: ' + serviceUrl,
        youtubeMenu
      );
      return;
    }

    // Проверяем доступность микросервиса (запрос к корневому URL)
    try {
      await axios.get(serviceUrl, { timeout: 3000 });
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        await ctx.reply(
          '❌ Микросервис YouTube-RSS недоступен.\n\n' +
          'Проверьте:\n' +
          '• Запущен ли сервис: pm2 status youtube-rss\n' +
          '• Корректность URL в .env: YOUTUBE_RSS_SERVICE_URL',
          youtubeMenu
        );
        return;
      }
      // Если другая ошибка (например, таймаут) – пробрасываем дальше
      throw error;
    }

    // Формируем полный URL для RSS-ленты
    const finalUrl = `${serviceUrl}?channel=${encodeURIComponent(cleanedInput)}`;
    const feeds = await db.getUserFeeds(userId);
    if (feeds.includes(finalUrl)) {
      await ctx.reply('ℹ️ Этот YouTube канал уже отслеживается.', youtubeMenu);
      return;
    }

    await db.addUserFeed(userId, finalUrl);

    await ctx.reply(
      '✅ YouTube канал успешно добавлен в мониторинг!\n\n' +
      `📡 RSS-ссылка: ${finalUrl}\n\n` +
      'Новости будут приходить в целевые каналы, если совпадут с ключевыми словами.',
      youtubeMenu
    );
    botLogger.info(`📺 Пользователь ${userId} добавил YouTube: ${cleanedInput} -> ${finalUrl}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleAddYouTube');
    await ctx.reply(
      '❌ Произошла ошибка при добавлении канала.\n\n' +
      'Проверьте логи: pm2 logs newsbot и pm2 logs youtube-rss',
      youtubeMenu
    );
  }
}

async function handleYouTubeRemove(ctx, input, youtubeMenu, userId) {
  try {
    const youtubeFeeds = await getYouTubeFeeds(userId);
    if (youtubeFeeds.length === 0) {
      await ctx.reply('❌ Нет YouTube-каналов для удаления.', youtubeMenu);
      return;
    }

    let feedToRemove = null;
    const num = parseInt(input);
    if (!isNaN(num) && num >= 1 && num <= youtubeFeeds.length) {
      feedToRemove = youtubeFeeds[num - 1];
    } else {
      feedToRemove = youtubeFeeds.find(feed => feed === input);
    }

    if (!feedToRemove) {
      await ctx.reply(
        '❌ Канал не найден. Проверьте номер или введите полную RSS-ссылку.\n\n' +
        'Используйте "📋 Список YouTube", чтобы увидеть доступные каналы.',
        youtubeMenu
      );
      return;
    }

    await db.removeUserFeed(userId, feedToRemove);
    await ctx.reply(`✅ YouTube-канал удалён.`, youtubeMenu);
    botLogger.info(`🗑️ Пользователь ${userId} удалил YouTube: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleYouTubeRemove');
    await ctx.reply('❌ Ошибка при удалении YouTube-канала.', youtubeMenu);
  }
}

// ---------- RSS функции (для сайтов, не YouTube) ----------
async function getRssFeeds(userId) {
  const feeds = await db.getUserFeeds(userId);
  const youtubePrefix = config.YOUTUBE_RSS_SERVICE_URL;
  return feeds.filter(feed => !feed.startsWith(youtubePrefix));
}

async function getRssFeedsWithMeta(userId) {
  const dbFeeds = await getRssFeeds(userId);
  return dbFeeds.map(feed => ({ url: feed, fromEnv: false }));
}

async function addRssFeed(ctx, url, rssMenu, userId) {
  try {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      await ctx.reply('❌ Введите корректный URL, начинающийся с http:// или https://', rssMenu);
      return;
    }
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      await ctx.reply('❌ Для YouTube используйте кнопку "Добавить YouTube" в отдельном меню.', rssMenu);
      return;
    }

    const feeds = await db.getUserFeeds(userId);
    if (feeds.includes(url)) {
      await ctx.reply('ℹ️ Эта RSS-лента уже добавлена.', rssMenu);
      return;
    }

    await db.addUserFeed(userId, url);
    await ctx.reply(`✅ RSS-лента добавлена:\n${url}`, rssMenu);
    botLogger.info(`📡 Пользователь ${userId} добавил RSS: ${url}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: addRssFeed');
    await ctx.reply('❌ Ошибка при добавлении RSS-ленты. Проверьте логи.', rssMenu);
  }
}

async function removeRssFeed(ctx, input, rssMenu, userId) {
  try {
    const dbFeeds = await getRssFeeds(userId);
    if (dbFeeds.length === 0) {
      await ctx.reply('❌ Нет добавленных RSS-лент для удаления.', rssMenu);
      return;
    }

    let feedToRemove = null;
    const num = parseInt(input);
    if (!isNaN(num) && num >= 1 && num <= dbFeeds.length) {
      feedToRemove = dbFeeds[num - 1];
    } else {
      feedToRemove = dbFeeds.find(feed => feed === input);
    }

    if (!feedToRemove) {
      await ctx.reply(
        '❌ Лента не найдена. Проверьте номер или введите полный URL.\n\n' +
        'Используйте "📋 Список RSS", чтобы увидеть доступные ленты.',
        rssMenu
      );
      return;
    }

    await db.removeUserFeed(userId, feedToRemove);
    await ctx.reply(`✅ RSS-лента удалена.`, rssMenu);
    botLogger.info(`🗑️ Пользователь ${userId} удалил RSS: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: removeRssFeed');
    await ctx.reply('❌ Ошибка при удалении RSS-ленты.', rssMenu);
  }
}

module.exports = {
  addChannelSimple,
  removeChannelSimple,
  sendMessageToTargetChannels,
  forwardMessageFromChannel,
  getYouTubeFeeds,
  updateAllFeeds,
  isValidYouTubeUrl,
  handleAddYouTube,
  handleYouTubeRemove,
  getRssFeeds,
  getRssFeedsWithMeta,
  addRssFeed,
  removeRssFeed
};