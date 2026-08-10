// handlers.js
const { Markup } = require('telegraf');
const db = require('./db');
const helpers = require('./helpers');
const config = require('./config');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');

// ---------- Клавиатуры (обычные, не inline) ----------
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

// ---------- Админ-меню (inline) ----------
const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📋 Список пользователей', 'admin_list')],
  [Markup.button.callback('➕ Добавить подписку', 'admin_add_sub')],
  [Markup.button.callback('➖ Удалить пользователя', 'admin_remove_user')],
  [Markup.button.callback('🔙 Закрыть админ-панель', 'admin_close')]
]);

// ---------- Вспомогательные функции ----------
async function ensureUser(ctx) {
  const userId = ctx.from.id;
  let user = await db.getUser(userId);
  if (!user) {
    // Пробный период 7 дней
    const trialEnd = Math.floor(Date.now() / 1000) + 7 * 86400;
    await db.addUser(userId, false, trialEnd);
    user = await db.getUser(userId);
    await ctx.reply(
      '🎉 Добро пожаловать! Вам предоставлен бесплатный пробный период на 7 дней.\n' +
      'Для продления обратитесь к администратору.'
    );
  }
  const hasSub = await db.hasActiveSubscription(userId);
  if (!hasSub) {
    await ctx.reply(
      '⛔ Ваша подписка истекла. Для продолжения работы обратитесь к администратору для продления.',
      mainMenu
    );
    return false;
  }
  return true;
}

async function isAdmin(userId) {
  const user = await db.getUser(userId);
  return user && user.is_admin === 1;
}

// ---------- Регистрация обработчиков ----------
function registerHandlers(deps) {
  const { bot, userStates, isForwardingActive } = deps;

  // ---------- Команда /start ----------
  bot.start(async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    await ctx.reply(
      '👋 Привет! Я бот для мониторинга и пересылки новостей.\n\n' +
      'Используйте кнопки меню для управления.',
      mainMenu
    );
  });

  // ---------- Команда /admin (только для админов) ----------
  bot.command('admin', async (ctx) => {
    const userId = ctx.from.id;
    if (!(await isAdmin(userId))) {
      await ctx.reply('⛔ У вас нет прав администратора.');
      return;
    }
    await ctx.reply('👑 Админ-панель', adminMenu);
  });

  // ---------- Обработка inline-кнопок админ-меню ----------
  bot.action(/admin_.*/, async (ctx) => {
    const userId = ctx.from.id;
    if (!(await isAdmin(userId))) {
      await ctx.answerCbQuery('⛔ Нет прав');
      return;
    }
    await ctx.answerCbQuery();

    const data = ctx.callbackQuery.data;

    if (data === 'admin_list') {
      const users = await db.listUsers();
      let msg = '👥 <b>Список пользователей</b>\n\n';
      for (const u of users) {
        const sub = u.subscription_end
          ? new Date(u.subscription_end * 1000).toLocaleDateString()
          : 'бессрочно';
        msg += `ID: <code>${u.user_id}</code>, подписка до: ${sub}, админ: ${u.is_admin ? '✅' : '❌'}\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...adminMenu });
      return;
    }

    if (data === 'admin_add_sub') {
      await ctx.editMessageText(
        '✏️ Введите ID пользователя и количество дней через пробел.\n' +
        'Пример: <code>123456789 30</code>',
        { parse_mode: 'HTML', ...adminMenu }
      );
      userStates.set(userId, { state: 'admin_waiting_add_sub' });
      return;
    }

    if (data === 'admin_remove_user') {
      await ctx.editMessageText(
        '✏️ Введите ID пользователя для удаления.\n' +
        'Пример: <code>123456789</code>',
        { parse_mode: 'HTML', ...adminMenu }
      );
      userStates.set(userId, { state: 'admin_waiting_remove_user' });
      return;
    }

    if (data === 'admin_close') {
      await ctx.deleteMessage();
      await ctx.reply('🏠 Главное меню', mainMenu);
      return;
    }
  });

  // ---------- Назад в главное меню ----------
  bot.hears('⬅️ Назад', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    await ctx.reply('🏠 Главное меню', mainMenu);
  });

  // ---------- YouTube подменю ----------
  bot.hears('📺 YouTube каналы', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    await ctx.reply('📺 Управление YouTube каналами:', youtubeMenu);
  });

  bot.hears('📺 Добавить YouTube', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_youtube_link' });
    await ctx.reply(
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
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const youtubeFeeds = await helpers.getYouTubeFeeds(userId);
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

  bot.hears('🗑️ Удалить YouTube', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_youtube_remove' });
    await ctx.reply(
      '🗑️ Введите номер YouTube-канала для удаления.\n\n' +
      'Сначала посмотрите список командой "📋 Список YouTube".\n' +
      'Или введите полную RSS-ссылку.\n\n' +
      'Отправьте "Отмена", чтобы отменить действие.'
    );
  });

  // ---------- RSS подменю ----------
  bot.hears('📡 RSS ленты', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    await ctx.reply('📡 Управление RSS-лентами сторонних сайтов:', rssMenu);
  });

  bot.hears('➕ Добавить RSS', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_rss_add' });
    await ctx.reply(
      '📡 Введите URL RSS-ленты сайта (например, https://example.com/rss.xml).\n\n' +
      'Отправьте "Отмена", чтобы отменить действие.'
    );
  });

  bot.hears('📋 Список RSS', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const feedsWithMeta = await helpers.getRssFeedsWithMeta(userId);
      if (feedsWithMeta.length === 0) {
        await ctx.reply('📡 Нет добавленных RSS-лент (кроме YouTube).', rssMenu);
        return;
      }
      let message = '📡 <b>Ваши RSS-ленты:</b>\n\n';
      feedsWithMeta.forEach((item, index) => {
        message += `${index + 1}. ${item.url}\n`;
      });
      message += '\nДля удаления используйте кнопку "🗑️ Удалить RSS" и введите номер.';
      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Список RSS"');
      await ctx.reply('❌ Ошибка при получении списка RSS-лент.', rssMenu);
    }
  });

  bot.hears('🗑️ Удалить RSS', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_rss_remove' });
    await ctx.reply(
      '🗑️ Введите номер или полный URL RSS-ленты для удаления.\n\n' +
      'Сначала посмотрите список командой "📋 Список RSS".\n' +
      'Отправьте "Отмена", чтобы отменить действие.'
    );
  });

  // ---------- Основные функции: запуск/остановка пересылки ----------
  bot.hears('🔄 Запустить пересылку', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    try {
      isForwardingActive.value = true;
      await ctx.reply('✅ Пересылка сообщений активирована!', mainMenu);
      botLogger.info('🔄 Пересылка сообщений активирована пользователем');
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Запустить пересылку"');
      await ctx.reply('❌ Ошибка при активации пересылки.', mainMenu);
    }
  });

  bot.hears('⏹️ Остановить пересылку', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    try {
      isForwardingActive.value = false;
      await ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
      botLogger.info('⏹️ Пересылка сообщений остановлена пользователем');
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Остановить пересылку"');
      await ctx.reply('❌ Ошибка при остановке пересылки.', mainMenu);
    }
  });

  // ---------- Ключевые слова ----------
  bot.hears('🗝️ Ключевые слова', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const keywords = await db.getKeywords(userId);
      const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
      await ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Ключевые слова"');
      await ctx.reply('❌ Ошибка при получении ключевых слов.', mainMenu);
    }
  });

  bot.hears('➕ Добавить ключевое слово', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_keyword_add' });
    await ctx.reply('✏️ Введите ключевое слово для добавления (можно несколько через запятую или пробел):');
  });

  bot.hears('🗑️ Удалить ключевое слово', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_keyword_remove' });
    await ctx.reply('🗑️ Введите ключевое слово для удаления (можно несколько через запятую или пробел):');
  });

  // ---------- Целевые каналы ----------
  bot.hears('🎯 Целевые каналы', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const channels = await db.getTargetChannels(userId);
      const list = channels.length
        ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
        : '— нет —';
      await ctx.reply(`🎯 Ваши целевые каналы:\n${list}`, targetChannelsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Целевые каналы"');
      await ctx.reply('❌ Ошибка при получении целевых каналов.', mainMenu);
    }
  });

  bot.hears('➕ Добавить целевой канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_target_channel_add' });
    await ctx.reply('✏️ Введите ID целевого канала (например: -1001234567890):');
  });

  bot.hears('🗑️ Удалить целевой канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_target_channel_remove' });
    await ctx.reply('🗑️ Введите ID целевого канала для удаления:');
  });

  // ---------- Мониторинг каналов ----------
  bot.hears('📡 Мониторинг каналов', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const channels = await db.getMonitoredChannels(userId);
      const list = channels.length
        ? channels.map(c => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
        : '— нет —';
      await ctx.reply(`📡 Ваши отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Мониторинг каналов"');
      await ctx.reply('❌ Ошибка при получении отслеживаемых каналов.', mainMenu);
    }
  });

  bot.hears('➕ Добавить отслеживаемый канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_monitored_channel_add' });
    await ctx.reply('✏️ Введите ID канала для отслеживания (например: -1001234567890):');
  });

  bot.hears('🗑️ Удалить отслеживаемый канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    userStates.set(userId, { state: 'waiting_for_monitored_channel_remove' });
    await ctx.reply('🗑️ Введите ID отслеживаемого канала для удаления:');
  });

  // ---------- Статистика ----------
  bot.hears('📈 Статистика', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    try {
      const keywords = await db.getKeywords(userId);
      const targets = await db.getTargetChannels(userId);
      const monitored = await db.getMonitoredChannels(userId);
      const feeds = await db.getUserFeeds(userId);
      const user = await db.getUser(userId);
      const subEnd = user.subscription_end
        ? new Date(user.subscription_end * 1000).toLocaleDateString()
        : 'бессрочно';

      const msg = `
📊 <b>Ваша статистика</b>

🗝️ Ключевых слов: ${keywords.length}
🎯 Целевых каналов: ${targets.length}
📡 Отслеживаемых каналов: ${monitored.length}
📡 RSS/YouTube лент: ${feeds.length}
⏳ Подписка до: ${subEnd}
🔄 Пересылка: ${isForwardingActive.value ? '✅ Активна' : '❌ Остановлена'}
      `;
      await ctx.reply(msg, { parse_mode: 'HTML', ...mainMenu });
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: hears "Статистика"');
      await ctx.reply('❌ Ошибка при получении статистики.', mainMenu);
    }
  });

  // ---------- Обработка channel_post (пересылка из каналов) ----------
  bot.on('channel_post', async (ctx) => {
    if (!isForwardingActive.value) return;
    try {
      const channelPost = ctx.channelPost;
      if (!channelPost) return;
      const channelId = channelPost.chat.id.toString();
      const messageId = channelPost.message_id;

      // Находим всех пользователей, которые мониторят этот канал
      const allUsers = await db.listUsers();
      for (const user of allUsers) {
        const hasSub = await db.hasActiveSubscription(user.user_id);
        if (!hasSub) continue;
        const monitored = await db.getMonitoredChannels(user.user_id);
        const found = monitored.find(ch => ch.channel_id === channelId);
        if (found) {
          botLogger.info(`📨 Пересылка сообщения ${messageId} для пользователя ${user.user_id}`);
          await helpers.forwardMessageFromChannel(ctx.bot, user.user_id, channelId, messageId);
        }
      }
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: channel_post handler');
    }
  });

  // ---------- Обработка текстовых сообщений (состояния FSM) ----------
  bot.on('message', async (ctx) => {
    // Игнорируем сообщения из каналов
    if (ctx.chat && ctx.chat.type === 'channel') return;

    const userId = ctx.from.id;
    const stateData = userStates.get(userId);
    const state = stateData ? stateData.state : null;
    const text = ctx.message.text?.trim();
    if (!text) return;

    // Проверяем пользователя только если состояние не админское (админские проверяются отдельно)
    // Но для всех состояний, кроме админских, нужна подписка.
    // Для админских состояний проверка будет внутри.
    const isAdminState = state && state.startsWith('admin_waiting_');
    if (!isAdminState) {
      const ok = await ensureUser(ctx);
      if (!ok) return;
    }

    try {
      // Отмена действия
      if (text.toLowerCase() === 'отмена' && state) {
        userStates.delete(userId);
        let returnMenu = mainMenu;
        if (state === 'waiting_for_youtube_link' || state === 'waiting_for_youtube_remove') {
          returnMenu = youtubeMenu;
        } else if (state === 'waiting_for_rss_add' || state === 'waiting_for_rss_remove') {
          returnMenu = rssMenu;
        } else if (state === 'admin_waiting_add_sub' || state === 'admin_waiting_remove_user') {
          returnMenu = adminMenu;
        }
        await ctx.reply('❌ Действие отменено.', returnMenu);
        return;
      }

      // ---------- Состояния пользователей ----------
      if (state === 'waiting_for_youtube_link') {
        await helpers.handleAddYouTube(ctx, text, youtubeMenu, userId);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_youtube_remove') {
        await helpers.handleYouTubeRemove(ctx, text, youtubeMenu, userId);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_rss_add') {
        await helpers.addRssFeed(ctx, text, rssMenu, userId);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_rss_remove') {
        await helpers.removeRssFeed(ctx, text, rssMenu, userId);
        userStates.delete(userId);
        return;
      }

      // --- МАССОВОЕ ДОБАВЛЕНИЕ ключевых слов (поддержка запятой и пробела) ---
      if (state === 'waiting_for_keyword_add') {
        let keywordsList;
        if (text.includes(',')) {
          keywordsList = text.split(',').map(kw => kw.trim()).filter(kw => kw.length > 0);
        } else {
          keywordsList = text.split(/\s+/).filter(kw => kw.length > 0);
        }

        if (keywordsList.length === 0) {
          await ctx.reply('❌ Вы не ввели ни одного ключевого слова.', keywordsMenu);
          userStates.delete(userId);
          return;
        }

        let addedCount = 0;
        let existsCount = 0;

        for (const kw of keywordsList) {
          const added = await db.addKeyword(userId, kw);
          if (added) addedCount++;
          else existsCount++;
        }

        let reply = `✅ Добавлено ключевых слов: ${addedCount}`;
        if (existsCount > 0) reply += `, уже существовали: ${existsCount}`;
        await ctx.reply(reply, keywordsMenu);
        userStates.delete(userId);
        return;
      }

      // --- МАССОВОЕ УДАЛЕНИЕ ключевых слов (поддержка запятой и пробела) ---
      if (state === 'waiting_for_keyword_remove') {
        let keywordsToRemove;
        if (text.includes(',')) {
          keywordsToRemove = text.split(',').map(kw => kw.trim()).filter(kw => kw.length > 0);
        } else {
          keywordsToRemove = text.split(/\s+/).filter(kw => kw.length > 0);
        }

        if (keywordsToRemove.length === 0) {
          await ctx.reply('❌ Вы не ввели ни одного ключевого слова для удаления.', keywordsMenu);
          userStates.delete(userId);
          return;
        }

        const allKeywords = await db.getKeywords(userId);
        const lowerKeywords = allKeywords.map(k => k.toLowerCase());

        let removedCount = 0;
        let notFoundCount = 0;
        const removedList = [];

        for (const kw of keywordsToRemove) {
          const index = lowerKeywords.indexOf(kw.toLowerCase());
          if (index !== -1) {
            const original = allKeywords[index];
            await db.removeKeyword(userId, original);
            removedCount++;
            removedList.push(original);
          } else {
            notFoundCount++;
          }
        }

        let reply = `✅ Удалено ключевых слов: ${removedCount}`;
        if (notFoundCount > 0) reply += `, не найдено: ${notFoundCount}`;
        if (removedList.length > 0) reply += `\nУдалены: ${removedList.join(', ')}`;
        await ctx.reply(reply, keywordsMenu);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_target_channel_add') {
        const result = await helpers.addChannelSimple(userId, text, 'target');
        userStates.delete(userId);
        await ctx.reply(result.message, targetChannelsMenu);
        return;
      }

      if (state === 'waiting_for_monitored_channel_add') {
        const result = await helpers.addChannelSimple(userId, text, 'monitored');
        userStates.delete(userId);
        await ctx.reply(result.message, monitoredChannelsMenu);
        return;
      }

      if (state === 'waiting_for_target_channel_remove') {
        await helpers.removeChannelSimple(ctx, text, 'target', { targetChannelsMenu, monitoredChannelsMenu }, userId);
        userStates.delete(userId);
        return;
      }

      if (state === 'waiting_for_monitored_channel_remove') {
        await helpers.removeChannelSimple(ctx, text, 'monitored', { targetChannelsMenu, monitoredChannelsMenu }, userId);
        userStates.delete(userId);
        return;
      }

      // ---------- Админские состояния ----------
      if (state === 'admin_waiting_add_sub') {
        if (!(await isAdmin(userId))) {
          await ctx.reply('⛔ Нет прав.');
          userStates.delete(userId);
          return;
        }
        const parts = text.split(' ');
        if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
          await ctx.reply('❌ Неверный формат. Введите: ID_пользователя количество_дней', adminMenu);
          return;
        }
        const targetUserId = parseInt(parts[0]);
        const days = parseInt(parts[1]);
        const success = await db.updateUserSubscription(targetUserId, days);
        await ctx.reply(
          success
            ? `✅ Пользователю ${targetUserId} добавлено ${days} дней.`
            : `❌ Пользователь ${targetUserId} не найден.`,
          adminMenu
        );
        userStates.delete(userId);
        return;
      }

      if (state === 'admin_waiting_remove_user') {
        if (!(await isAdmin(userId))) {
          await ctx.reply('⛔ Нет прав.');
          userStates.delete(userId);
          return;
        }
        const targetUserId = parseInt(text);
        if (isNaN(targetUserId)) {
          await ctx.reply('❌ Введите корректный числовой ID.', adminMenu);
          return;
        }
        const success = await db.deleteUser(targetUserId);
        await ctx.reply(
          success
            ? `✅ Пользователь ${targetUserId} удалён.`
            : `❌ Пользователь ${targetUserId} не найден.`,
          adminMenu
        );
        userStates.delete(userId);
        return;
      }

      // Если состояние не распознано, игнорируем
    } catch (error) {
      errorHandler.handleError(error, 'handlers.js: message handler (state processing)');
      await ctx.reply('❌ Произошла ошибка при обработке команды.');
    }
  });

  // ---------- Обработка ошибок бота ----------
  bot.catch((err, ctx) => {
    errorHandler.handleError(err, 'handlers.js: bot.catch');
    ctx.reply('❌ Произошла внутренняя ошибка. Попробуйте позже.').catch(() => {});
  });
}

module.exports = { registerHandlers };