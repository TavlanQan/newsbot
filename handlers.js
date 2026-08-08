// handlers.js
const { Markup } = require('telegraf');

// Клавиатуры
const mainMenu = Markup.keyboard([
  ['📈 Статистика', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
  ['📺 YouTube каналы', '📡 RSS ленты'],
  ['🔄 Запустить пересылку', '⏹️ Остановить пересылку']
]).resize();

const youtubeMenu = Markup.keyboard([
  ['📺 Добавить YouTube', '📋 Список YouTube'],
  ['🗑️ Удалить YouTube', '⬅️ Назад']
]).resize();

const rssMenu = Markup.keyboard([
  ['➕ Добавить RSS', '📋 Список RSS'],
  ['🗑️ Удалить RSS', '⬅️ Назад']
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

function registerHandlers(deps) {
  const {
    bot,
    db,
    config,
    newsService,
    queue,
    errorHandler,
    logger,
    userStates,
    isForwardingActive,
    helpers
  } = deps;

  const { botLogger } = logger;

  // ---------- Команды ----------
  bot.start(async (ctx) => {
    try {
      await db.initializeDB();
      newsService.setSendFunction((msg, opts) => helpers.sendMessageToTargetChannels(bot, msg, opts));
      await ctx.reply(
        '👋 Привет! Я бот для мониторинга и пересылки новостей.\n\n' +
        'Используйте кнопки меню для управления.',
        mainMenu
      );
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: bot.start');
      await ctx.reply('❌ Ошибка при запуске бота. Проверьте логи.');
    }
  });

  // ---------- Назад в главное меню ----------
  bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

  // ---------- YouTube подменю ----------
  bot.hears('📺 YouTube каналы', (ctx) => {
    ctx.reply('📺 Управление YouTube каналами:', youtubeMenu);
  });

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
      const youtubeFeeds = await helpers.getYouTubeFeeds();
      if (youtubeFeeds.length === 0) {
        await ctx.reply('📺 Нет добавленных YouTube-каналов.', youtubeMenu);
        return;
      }
      let message = '📋 <b>Список YouTube-каналов:</b>\n\n';
      youtubeFeeds.forEach((feed, index) => {
        try {
          const url = new URL(feed);
          const channelParam = url.searchParams.get('channel') || feed;
          message += `${index + 1}. ${channelParam}\n`;
        } catch {
          message += `${index + 1}. ${feed}\n`;
        }
      });
      message += '\nДля удаления используйте кнопку "🗑️ Удалить YouTube" и введите номер канала.';
      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Список YouTube"');
      await ctx.reply('❌ Ошибка при получении списка YouTube-каналов.', youtubeMenu);
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

  // ---------- RSS подменю ----------
  bot.hears('📡 RSS ленты', (ctx) => {
    ctx.reply('📡 Управление RSS-лентами сторонних сайтов:', rssMenu);
  });

  bot.hears('➕ Добавить RSS', (ctx) => {
    userStates.set(ctx.from.id, {
      state: 'waiting_for_rss_add',
      timestamp: Date.now()
    });
    ctx.reply(
      '📡 Введите URL RSS-ленты сайта (например, https://example.com/rss.xml).\n\n' +
      'Отправьте "Отмена", чтобы отменить действие.'
    );
  });

  bot.hears('📋 Список RSS', async (ctx) => {
    try {
      const feedsWithMeta = await helpers.getRssFeedsWithMeta();
      
      if (feedsWithMeta.length === 0) {
        await ctx.reply('📡 Нет добавленных RSS-лент (кроме YouTube).', rssMenu);
        return;
      }
      
      let message = '📡 <b>Список RSS-лент:</b>\n\n';
      
      // Сначала показываем ленты из .env
      const envFeeds = feedsWithMeta.filter(f => f.fromEnv);
      const dbFeeds = feedsWithMeta.filter(f => !f.fromEnv);
      
      if (envFeeds.length > 0) {
        message += '<i>📌 Системные (из .env):</i>\n';
        envFeeds.forEach((feed, index) => {
          message += `${index + 1}. ${feed.url} 🔒\n`;
        });
        message += '\n';
      }
      
      if (dbFeeds.length > 0) {
        message += '<i>📌 Добавленные через бота:</i>\n';
        dbFeeds.forEach((feed, index) => {
          const displayIndex = index + 1;
          message += `${displayIndex}. ${feed.url}\n`;
        });
        message += '\n';
      }
      
      message += 'Для удаления используйте кнопку "🗑️ Удалить RSS" и введите номер.';
      message += '\n🔒 — системные ленты, их нельзя удалить через бота.';
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Список RSS"');
      await ctx.reply('❌ Ошибка при получении списка RSS-лент.', rssMenu);
    }
  });

  bot.hears('🗑️ Удалить RSS', (ctx) => {
    userStates.set(ctx.from.id, {
      state: 'waiting_for_rss_remove',
      timestamp: Date.now()
    });
    ctx.reply(
      '🗑️ Введите номер или полный URL RSS-ленты для удаления.\n\n' +
      'Сначала посмотрите список командой "📋 Список RSS".\n' +
      'Отправьте "Отмена", чтобы отменить действие.'
    );
  });

  // ---------- Основные функции ----------
  bot.hears('🔄 Запустить пересылку', async (ctx) => {
    try {
      isForwardingActive.value = true;
      newsService.setSendFunction((msg, opts) => helpers.sendMessageToTargetChannels(bot, msg, opts));
      await newsService.startMonitoring();
      await ctx.reply('✅ Пересылка сообщений активирована!', mainMenu);
      botLogger.info('🔄 Пересылка сообщений активирована пользователем');
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Запустить пересылку"');
      await ctx.reply('❌ Ошибка при активации пересылки.', mainMenu);
    }
  });

  bot.hears('⏹️ Остановить пересылку', async (ctx) => {
    try {
      isForwardingActive.value = false;
      await newsService.stopMonitoring();
      await ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
      botLogger.info('⏹️ Пересылка сообщений остановлена пользователем');
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Остановить пересылку"');
      await ctx.reply('❌ Ошибка при остановке пересылки.', mainMenu);
    }
  });

  // ---------- Ключевые слова ----------
  bot.hears('🗝️ Ключевые слова', async (ctx) => {
    try {
      const keywords = await db.getKeywords();
      const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
      await ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Ключевые слова"');
      await ctx.reply('❌ Ошибка при получении ключевых слов.', mainMenu);
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

  // ---------- Целевые каналы ----------
  bot.hears('🎯 Целевые каналы', async (ctx) => {
    try {
      const channels = await db.getTargetChannels();
      const list = channels.length
        ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
        : '— нет —';
      await ctx.reply(`🎯 Целевые каналы:\n${list}`, targetChannelsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Целевые каналы"');
      await ctx.reply('❌ Ошибка при получении целевых каналов.', mainMenu);
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

  // ---------- Мониторинг каналов ----------
  bot.hears('📡 Мониторинг каналов', async (ctx) => {
    try {
      const channels = await db.getMonitoredChannels();
      const list = channels.length
        ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
        : '— нет —';
      await ctx.reply(`📡 Отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Мониторинг каналов"');
      await ctx.reply('❌ Ошибка при получении отслеживаемых каналов.', mainMenu);
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

  // ---------- Статистика ----------
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
🔄 Пересылка: ${isForwardingActive.value ? '✅ Активна' : '❌ Остановлена'}
      `;
      await ctx.reply(msg, mainMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Статистика"');
      await ctx.reply('❌ Ошибка при получении статистики.', mainMenu);
    }
  });

  // ---------- Обработка channel_post ----------
  bot.on('channel_post', async (ctx) => {
    if (!isForwardingActive.value) return;
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
        await helpers.forwardMessageFromChannel(bot, channelId, messageId);
      }
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: channel_post handler');
    }
  });

  // ---------- Обработка текстовых сообщений (состояния) ----------
  bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const stateData = userStates.get(userId);
    const state = stateData ? stateData.state : null;
    const text = ctx.message.text?.trim();
    if (!text || (ctx.message.chat && ctx.message.chat.type === 'channel')) return;

    try {
      // Отмена действия
      if (text.toLowerCase() === 'отмена' && state) {
        userStates.delete(userId);
        let returnMenu = mainMenu;
        if (state === 'waiting_for_youtube_link' || state === 'waiting_for_youtube_remove') {
          returnMenu = youtubeMenu;
        } else if (state === 'waiting_for_rss_add' || state === 'waiting_for_rss_remove') {
          returnMenu = rssMenu;
        }
        await ctx.reply('❌ Действие отменено. Возвращаюсь в меню.', returnMenu);
        return;
      }

      // Состояния
      if (state === 'waiting_for_youtube_link') {
        await helpers.handleAddYouTube(ctx, text, youtubeMenu);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_youtube_remove') {
        await helpers.handleYouTubeRemove(ctx, text, youtubeMenu);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_rss_add') {
        await helpers.addRssFeed(ctx, text, rssMenu);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_rss_remove') {
        await helpers.removeRssFeed(ctx, text, rssMenu);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_keyword_add') {
        const added = await db.addKeyword(text);
        userStates.delete(userId);
        if (added > 0) {
          await ctx.reply(`✅ Ключевое слово "${text}" добавлено.`, keywordsMenu);
        } else {
          await ctx.reply(`⚠️ Слово "${text}" уже существует.`, keywordsMenu);
        }
        return;
      }

      if (state === 'waiting_for_keyword_remove') {
        const keywords = await db.getKeywords();
        const keywordToRemove = keywords.find(k => k.toLowerCase() === text.toLowerCase());
        if (!keywordToRemove) {
          await ctx.reply(`❌ Слово "${text}" не найдено.`, keywordsMenu);
        } else {
          await db.removeKeyword(keywordToRemove);
          await ctx.reply(`✅ Ключевое слово "${keywordToRemove}" удалено.`, keywordsMenu);
        }
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_target_channel_add') {
        const result = await helpers.addChannelSimple(text, 'target');
        userStates.delete(userId);
        await ctx.reply(result.message, targetChannelsMenu);
        return;
      }

      if (state === 'waiting_for_monitored_channel_add') {
        const result = await helpers.addChannelSimple(text, 'monitored');
        userStates.delete(userId);
        await ctx.reply(result.message, monitoredChannelsMenu);
        return;
      }

      if (state === 'waiting_for_target_channel_remove') {
        await helpers.removeChannelSimple(ctx, text, 'target', { targetChannelsMenu, monitoredChannelsMenu });
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_monitored_channel_remove') {
        await helpers.removeChannelSimple(ctx, text, 'monitored', { targetChannelsMenu, monitoredChannelsMenu });
        userStates.delete(userId);
        return;
      }
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: message handler (state processing)');
      await ctx.reply('❌ Произошла ошибка при обработке команды.');
    }
  });
}

module.exports = registerHandlers;