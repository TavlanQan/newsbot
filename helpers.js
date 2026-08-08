// helpers.js
const axios = require('axios');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const queue = require('./queue');

// ---------- Общие функции для каналов ----------
async function addChannelSimple(channelIdentifier, channelType) {
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
      result = await db.addTargetChannel(channelIdentifier, null, channelTitle);
    } else {
      result = await db.addMonitoredChannel(channelIdentifier, null, channelTitle);
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

async function removeChannelSimple(ctx, userText, type, menus) {
  const isTarget = type === 'target';
  const getFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const menu = isTarget ? menus.targetChannelsMenu : menus.monitoredChannelsMenu;

  try {
    const allChannels = await getFunc();
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
    const removed = await removeFunc(found.channel_id);
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

// ---------- Функции отправки и пересылки ----------
async function sendMessageToTargetChannels(bot, message, options = {}) {
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

async function forwardMessageFromChannel(bot, channelId, messageId) {
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
          await bot.telegram.forwardMessage(targetChannel.channel_id, channelId, messageId);
          await db.addForwardedMessage(messageId, channelId);
          botLogger.info(`📤 Переслано сообщение ${messageId} → ${targetChannel.channel_id}`);
        } catch (error) {
          errorHandler.handleError(error, `helpers.js: forwardMessageFromChannel (queue task for ${targetChannel.channel_id})`);
        }
      });
    }
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: forwardMessageFromChannel (outer)');
  }
}

// ---------- YouTube функции ----------
async function getYouTubeFeeds() {
  const currentFeeds = await db.getSetting('rss_feeds') || '';
  const allFeeds = currentFeeds ? currentFeeds.split(',') : [];
  const youtubePrefix = config.YOUTUBE_RSS_SERVICE_URL;
  return allFeeds.filter(feed => feed.startsWith(youtubePrefix));
}

async function updateAllFeeds(newFeedsArray) {
  const feedsString = newFeedsArray.join(',');
  await db.setSetting('rss_feeds', feedsString);
  await newsService.setFeeds(newFeedsArray);
}

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

async function handleAddYouTube(ctx, input, youtubeMenu) {
  try {
    if (!isValidYouTubeUrl(input)) {
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

    const serviceUrl = `${config.YOUTUBE_RSS_SERVICE_URL}?channel=${encodeURIComponent(input)}`;
    // Проверка доступности микросервиса
    try {
      await axios.get(config.YOUTUBE_RSS_SERVICE_URL, { timeout: 3000 });
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        await ctx.reply(
          '❌ Микросервис YouTube-RSS недоступен.\n\n' +
          'Проверьте:\n' +
          '• Запущен ли сервис: pm2 status youtube-rss\n' +
          '• Корректность URL в .env: YOUTUBE_RSS_SERVICE_URL',
          youtubeMenu
        );
        return;
      }
      // Другие ошибки тоже обработаем
      throw error;
    }

    const currentFeeds = await db.getSetting('rss_feeds') || '';
    const feedsList = currentFeeds ? currentFeeds.split(',') : [];
    if (feedsList.includes(serviceUrl)) {
      await ctx.reply('ℹ️ Этот YouTube канал уже отслеживается.', youtubeMenu);
      return;
    }

    feedsList.push(serviceUrl);
    await db.setSetting('rss_feeds', feedsList.join(','));
    await newsService.addFeed(serviceUrl);

    await ctx.reply(
      '✅ YouTube канал успешно добавлен в мониторинг!\n\n' +
      `📡 RSS-ссылка: ${serviceUrl}\n\n` +
      'Новости будут приходить в целевые каналы, если совпадут с ключевыми словами.',
      youtubeMenu
    );
    botLogger.info(`📺 Добавлен YouTube канал: ${input} -> ${serviceUrl}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleAddYouTube');
    await ctx.reply(
      '❌ Произошла ошибка при добавлении канала.\n\n' +
      'Проверьте логи: pm2 logs youtube-rss',
      youtubeMenu
    );
  }
}

async function handleYouTubeRemove(ctx, input, youtubeMenu) {
  try {
    const youtubeFeeds = await getYouTubeFeeds();
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

    const allFeeds = (await db.getSetting('rss_feeds') || '').split(',').filter(f => f !== '');
    const updatedFeeds = allFeeds.filter(f => f !== feedToRemove);
    await updateAllFeeds(updatedFeeds);

    await ctx.reply(`✅ YouTube-канал удалён.`, youtubeMenu);
    botLogger.info(`🗑️ Удалён YouTube канал: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleYouTubeRemove');
    await ctx.reply('❌ Ошибка при удалении YouTube-канала.', youtubeMenu);
  }
}

// RSS функции (для сайтов)
async function getRssFeeds() {
  const currentFeeds = await db.getSetting('rss_feeds') || '';
  const allFeeds = currentFeeds ? currentFeeds.split(',') : [];
  const youtubePrefix = config.YOUTUBE_RSS_SERVICE_URL;
  // Возвращаем все фиды, кроме YouTube
  return allFeeds.filter(feed => !feed.startsWith(youtubePrefix));
}

async function addRssFeed(ctx, url, rssMenu) {
  try {
    // Простая валидация URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      await ctx.reply('❌ Введите корректный URL, начинающийся с http:// или https://', rssMenu);
      return;
    }
    // Проверяем, что это не YouTube (чтобы не путать)
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      await ctx.reply('❌ Для YouTube используйте кнопку "Добавить YouTube" в отдельном меню.', rssMenu);
      return;
    }

    const currentFeeds = await db.getSetting('rss_feeds') || '';
    const feedsList = currentFeeds ? currentFeeds.split(',') : [];
    if (feedsList.includes(url)) {
      await ctx.reply('ℹ️ Эта RSS-лента уже добавлена.', rssMenu);
      return;
    }

    feedsList.push(url);
    await db.setSetting('rss_feeds', feedsList.join(','));
    // Обновляем newsService
    await newsService.addFeed(url);

    await ctx.reply(`✅ RSS-лента добавлена:\n${url}`, rssMenu);
    botLogger.info(`📡 Добавлена RSS-лента: ${url}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: addRssFeed');
    await ctx.reply('❌ Ошибка при добавлении RSS-ленты. Проверьте логи.', rssMenu);
  }
}

async function removeRssFeed(ctx, input, rssMenu) {
  try {
    const rssFeeds = await getRssFeeds();
    if (rssFeeds.length === 0) {
      await ctx.reply('❌ Нет добавленных RSS-лент для удаления.', rssMenu);
      return;
    }

    let feedToRemove = null;
    const num = parseInt(input);
    if (!isNaN(num) && num >= 1 && num <= rssFeeds.length) {
      feedToRemove = rssFeeds[num - 1];
    } else {
      feedToRemove = rssFeeds.find(feed => feed === input);
    }

    if (!feedToRemove) {
      await ctx.reply(
        '❌ Лента не найдена. Проверьте номер или введите полный URL.\n\n' +
        'Используйте "📋 Список RSS", чтобы увидеть доступные ленты.',
        rssMenu
      );
      return;
    }

    const allFeeds = (await db.getSetting('rss_feeds') || '').split(',').filter(f => f !== '');
    const updatedFeeds = allFeeds.filter(f => f !== feedToRemove);
    await updateAllFeeds(updatedFeeds); // используем существующую функцию

    await ctx.reply(`✅ RSS-лента удалена.`, rssMenu);
    botLogger.info(`🗑️ Удалена RSS-лента: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: removeRssFeed');
    await ctx.reply('❌ Ошибка при удалении RSS-ленты.', rssMenu);
  }
}

// Экспортируем всё, что нужно другим модулям
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
  addRssFeed,
  removeRssFeed
};