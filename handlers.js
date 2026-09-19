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

// ---------- Тексты, при нажатии которых FSM сбрасывается ----------
// Это кнопки главного/подменю, которые открывают новый контекст.
// Если пользователь был в середине FSM-диалога (например, вводил keyword)
// и нажал такую кнопку — незавершённое состояние должно исчезнуть,
// иначе следующее текстовое сообщение уйдёт в старый FSM-обработчик.
//
// FSM-стартовые кнопки («➕ Добавить …») здесь НЕ перечислены: их
// обработчики сами вызывают setState() и перезаписывают состояние.
const STATE_RESET_TEXTS = new Set([
  '⬅️ Назад',
  '📈 Статистика',
  '🗝️ Ключевые слова',
  '🎯 Целевые каналы',
  '📡 Мониторинг каналов',
  '📺 YouTube каналы',
  '📡 RSS ленты',
  '🔄 Запустить пересылку',
  '⏹️ Остановить пересылку',
  '📋 Список YouTube',
  '📋 Список RSS'
]);

// ---------- Админ-меню (inline, динамическое) ----------
function getAdminMenu(isMain) {
  const rows = [
    [Markup.button.callback('📋 Список пользователей', 'admin_list')],
    [Markup.button.callback('➕ Добавить подписку', 'admin_add_sub')],
    [Markup.button.callback('📨 Запросы на доступ', 'admin_requests')]
  ];
  if (isMain) {
    rows.push([Markup.button.callback('👑 Управление админами', 'admin_admins_menu')]);
    rows.push([Markup.button.callback('🌐 Системные источники', 'admin_sysfeeds_menu')]);
  }
  rows.push([Markup.button.callback('➖ Удалить пользователя', 'admin_remove_user')]);
  rows.push([Markup.button.callback('🔙 Закрыть админ-панель', 'admin_close')]);
  return Markup.inlineKeyboard(rows);
}

// ---------- Подменю управления админами ----------
const adminsSubMenu = Markup.inlineKeyboard([
  [Markup.button.callback('👑 Назначить админа', 'admin_promote')],
  [Markup.button.callback('🔻 Снять права админа', 'admin_demote')],
  [Markup.button.callback('📋 Список админов', 'admin_list_admins')],
  [Markup.button.callback('🔙 Назад', 'admin_back')]
]);

// ---------- Подменю системных источников (только главный админ) ----------
const systemFeedsMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📋 Список системных RSS', 'sysfeeds_list')],
  [Markup.button.callback('➕ Добавить системный RSS', 'sysfeeds_add')],
  [Markup.button.callback('🗑️ Удалить системный RSS', 'sysfeeds_remove')],
  [Markup.button.callback('🔙 Назад', 'admin_back')]
]);

// ---------- Вспомогательные функции ----------
function isMainAdmin(userId) {
  const adminIdRaw = process.env.ADMIN_CHAT_ID || config.ADMIN_CHAT_ID;
  const adminId = parseInt(adminIdRaw, 10);
  return !isNaN(adminId) && userId === adminId;
}

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
    const pending = await db.getAccessRequest(userId);
    if (pending && pending.status === 'pending') {
      await ctx.reply('⏳ Ваш запрос на доступ уже отправлен. Ожидайте решения администратора.');
    } else {
      await ctx.reply(
        '⛔ Ваша подписка истекла.\n\n' +
          'Нажмите кнопку ниже, чтобы запросить доступ у администратора.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Запросить доступ', 'request_access')]
        ])
      );
    }
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

  // ---------- Единая точка записи FSM ----------
  // Всегда сохраняем timestamp — иначе очистка в bot.js (setInterval,
  // 30 мин) никогда не сработает: она проверяет именно stateData.timestamp.
  // Без этого поля userStates превращается в монотонную утечку.
  const setState = (userId, state) =>
    userStates.set(userId, { state, timestamp: Date.now() });

  const clearState = (userId) => userStates.delete(userId);

  // ---------- Middleware: сброс FSM при нажатии кнопок меню ----------
  // Регистрируется первым, поэтому срабатывает ДО bot.hears('...').
  // Мы намеренно не полагаемся на то, что каждый обработчик сам вызовет
  // clearState — это слишком легко забыть при добавлении новой кнопки.
  bot.use((ctx, next) => {
    if (ctx.message && typeof ctx.message.text === 'string' && ctx.from) {
      if (STATE_RESET_TEXTS.has(ctx.message.text)) {
        userStates.delete(ctx.from.id);
      }
    }
    return next();
  });

  // ---------- Команда /start ----------
  bot.start(async (ctx) => {
    clearState(ctx.from.id);
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
    clearState(userId);
    if (!(await isAdmin(userId))) {
      await ctx.reply('⛔ У вас нет прав администратора.');
      return;
    }
    await ctx.reply('👑 Админ-панель', getAdminMenu(isMainAdmin(userId)));
  });

  // ---------- Обработка inline-кнопок админ-меню ----------
  bot.action(/admin_.*/, async (ctx) => {
    const userId = ctx.from.id;
    // Любое действие внутри админ-панели начинает новый сценарий —
    // сбрасываем незавершённый FSM. Это закрывает сценарий:
    // admin_add_sub → клик admin_back → user пишет «привет» →
    // старый обработчик пытается распарсить «привет» как ID.
    clearState(userId);

    if (!(await isAdmin(userId))) {
      await ctx.answerCbQuery('⛔ Нет прав');
      return;
    }
    await ctx.answerCbQuery();

    const data = ctx.callbackQuery.data;
    const mainAdmin = isMainAdmin(userId);
    const menu = getAdminMenu(mainAdmin);

    if (data === 'admin_list') {
      const users = await db.listUsers();
      let msg = '👥 <b>Список пользователей</b>\n\n';
      for (const u of users) {
        const sub = u.subscription_end
          ? new Date(u.subscription_end * 1000).toLocaleDateString()
          : 'бессрочно';
        msg += `ID: <code>${u.user_id}</code>, подписка до: ${sub}, админ: ${u.is_admin ? '✅' : '❌'}\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...menu });
      return;
    }

    if (data === 'admin_add_sub') {
      await ctx.editMessageText(
        '✏️ Введите ID пользователя и количество дней через пробел.\n' +
          'Пример: <code>123456789 30</code>',
        { parse_mode: 'HTML', ...menu }
      );
      setState(userId, 'admin_waiting_add_sub');
      return;
    }

    if (data === 'admin_remove_user') {
      await ctx.editMessageText(
        '✏️ Введите ID пользователя для удаления.\n' +
          'Пример: <code>123456789</code>',
        { parse_mode: 'HTML', ...menu }
      );
      setState(userId, 'admin_waiting_remove_user');
      return;
    }

    if (data === 'admin_requests') {
      const requests = await db.getPendingAccessRequests();
      if (requests.length === 0) {
        await ctx.editMessageText('📨 Нет активных запросов на доступ.', { ...menu });
        return;
      }
      let msg = '📨 <b>Запросы на доступ</b>\n\n';
      const rows = [];
      for (const r of requests) {
        const dt = new Date(r.requested_at * 1000).toLocaleString('ru-RU');
        msg += `👤 ${r.first_name || 'без имени'}${r.username ? ' (@' + r.username + ')' : ''}\n`;
        msg += `ID: <code>${r.user_id}</code>, ${dt}\n\n`;
        rows.push([
          Markup.button.callback('✅ 30д', `grant_access:${r.user_id}:30`),
          Markup.button.callback('✅ 90д', `grant_access:${r.user_id}:90`),
          Markup.button.callback('♾ Бессрочно', `grant_access:${r.user_id}:0`),
          Markup.button.callback('❌', `deny_access:${r.user_id}`)
        ]);
      }
      rows.push([Markup.button.callback('🔙 Назад', 'admin_back')]);
      await ctx.editMessageText(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(rows)
      });
      return;
    }

    if (data === 'admin_admins_menu') {
      if (!mainAdmin) {
        await ctx.answerCbQuery('⛔ Только главный админ');
        return;
      }
      await ctx.editMessageText('👑 <b>Управление администраторами</b>', {
        parse_mode: 'HTML',
        ...adminsSubMenu
      });
      return;
    }

    if (data === 'admin_list_admins') {
      if (!mainAdmin) {
        await ctx.answerCbQuery('⛔ Только главный админ');
        return;
      }
      const admins = await db.listAdmins();
      let msg = '👑 <b>Список администраторов</b>\n\n';
      for (const a of admins) {
        msg += `${isMainAdmin(a.user_id) ? '👑 ГЛАВНЫЙ' : '👤 админ'}: <code>${a.user_id}</code>\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: 'HTML', ...adminsSubMenu });
      return;
    }

    if (data === 'admin_promote') {
      if (!mainAdmin) {
        await ctx.answerCbQuery('⛔ Только главный админ');
        return;
      }
      setState(userId, 'admin_waiting_promote');
      await ctx.editMessageText(
        '👑 Введите ID пользователя, которому нужно назначить права админа.\n' +
          'Пользователь должен уже хотя бы раз запустить бота.\n\n' +
          'Отправьте "Отмена" для отмены.',
        adminsSubMenu
      );
      return;
    }

    if (data === 'admin_demote') {
      if (!mainAdmin) {
        await ctx.answerCbQuery('⛔ Только главный админ');
        return;
      }
      setState(userId, 'admin_waiting_demote');
      await ctx.editMessageText(
        '🔻 Введите ID администратора для снятия прав.\n' +
          'С главного админа права снять нельзя.\n\n' +
          'Отправьте "Отмена" для отмены.',
        adminsSubMenu
      );
      return;
    }

    if (data === 'admin_sysfeeds_menu') {
      if (!mainAdmin) {
        await ctx.answerCbQuery('⛔ Только главный админ');
        return;
      }
      await ctx.editMessageText(
        '🌐 <b>Системные источники (RSS-ленты)</b>\n\n' +
          'Эти ленты парсятся для всех активных пользователей.\n' +
          'Доступны только главному администратору.',
        { parse_mode: 'HTML', ...systemFeedsMenu }
      );
      return;
    }

    if (data === 'admin_back') {
      await ctx.editMessageText('👑 Админ-панель', { ...menu });
      return;
    }

    if (data === 'admin_close') {
      await ctx.deleteMessage();
      await ctx.reply('🏠 Главное меню', mainMenu);
      return;
    }
  });

  // ---------- Системные источники: callback'и ----------
  bot.action('sysfeeds_list', async (ctx) => {
    const userId = ctx.from.id;
    if (!isMainAdmin(userId)) {
      await ctx.answerCbQuery('⛔ Только главный админ');
      return;
    }
    await ctx.answerCbQuery();

    const feeds = await db.getSystemFeeds();
    if (feeds.length === 0) {
      await ctx.editMessageText(
        '🌐 Системных RSS-лент пока нет.\n\n' +
          'Добавьте их через кнопку «➕ Добавить системный RSS».',
        { ...systemFeedsMenu }
      );
      return;
    }

    let msg = '🌐 <b>Системные RSS-ленты:</b>\n\n';
    feeds.forEach((url, i) => {
      msg += `${i + 1}. ${url}\n`;
    });
    msg += '\nДля удаления используйте «🗑️ Удалить системный RSS».';
    await ctx.editMessageText(msg, { parse_mode: 'HTML', ...systemFeedsMenu });
  });

  bot.action('sysfeeds_add', async (ctx) => {
    const userId = ctx.from.id;
    if (!isMainAdmin(userId)) {
      await ctx.answerCbQuery('⛔ Только главный админ');
      return;
    }
    await ctx.answerCbQuery();
    setState(userId, 'admin_waiting_sysfeed_add');
    await ctx.editMessageText(
      '✏️ Введите URL системной RSS-ленты.\n' +
        'Пример: <code>https://example.com/rss.xml</code>\n\n' +
        'Отправьте "Отмена" для отмены.',
      { parse_mode: 'HTML', ...systemFeedsMenu }
    );
  });

  bot.action('sysfeeds_remove', async (ctx) => {
    const userId = ctx.from.id;
    if (!isMainAdmin(userId)) {
      await ctx.answerCbQuery('⛔ Только главный админ');
      return;
    }
    await ctx.answerCbQuery();
    setState(userId, 'admin_waiting_sysfeed_remove');
    await ctx.editMessageText(
      '✏️ Введите номер или полный URL системной RSS-ленты для удаления.\n\n' +
        'Сначала посмотрите список через «📋 Список системных RSS».\n' +
        'Отправьте "Отмена" для отмены.',
      { ...systemFeedsMenu }
    );
  });

  // ---------- Запрос доступа (от пользователя) ----------
  bot.action('request_access', async (ctx) => {
    const userId = ctx.from.id;
    const existing = await db.getAccessRequest(userId);
    if (existing && existing.status === 'pending') {
      await ctx.answerCbQuery('Запрос уже отправлен');
      return;
    }

    await db.addAccessRequest(userId, ctx.from.username, ctx.from.first_name);
    await ctx.answerCbQuery('✅ Отправлено');
    await ctx.editMessageText('⏳ Ваш запрос отправлен. Ожидайте решения администратора.');

    const adminIdRaw = process.env.ADMIN_CHAT_ID || config.ADMIN_CHAT_ID;
    const mainAdminId = parseInt(adminIdRaw, 10);
    if (isNaN(mainAdminId)) {
      botLogger.error('❌ request_access: ADMIN_CHAT_ID не задан, уведомление не отправлено');
      return;
    }

    try {
      await ctx.telegram.sendMessage(
        mainAdminId,
        `📨 <b>Новый запрос на доступ</b>\n\n` +
          `Имя: ${ctx.from.first_name || '—'}\n` +
          `Username: ${ctx.from.username ? '@' + ctx.from.username : '—'}\n` +
          `ID: <code>${userId}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ 30 дней', `grant_access:${userId}:30`),
              Markup.button.callback('✅ 90 дней', `grant_access:${userId}:90`)
            ],
            [
              Markup.button.callback('♾ Бессрочно', `grant_access:${userId}:0`),
              Markup.button.callback('❌ Отклонить', `deny_access:${userId}`)
            ]
          ])
        }
      );
    } catch (e) {
      errorHandler.handleError(e, 'handlers.js: request_access notify main admin');
    }
  });

  // ---------- Одобрение доступа ----------
  bot.action(/^grant_access:(\d+):(\d+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id))) {
      await ctx.answerCbQuery('⛔ Нет прав');
      return;
    }
    const targetUserId = parseInt(ctx.match[1], 10);
    const days = parseInt(ctx.match[2], 10);

    if (days > 0) {
      await db.updateUserSubscription(targetUserId, days);
    } else {
      // Бессрочно (0 в callback = NULL в БД)
      await db.run('UPDATE users SET subscription_end = NULL WHERE user_id = ?', [targetUserId]);
    }
    await db.resolveAccessRequest(targetUserId, 'approved');

    const durText = days > 0 ? `на ${days} дней` : 'бессрочно';
    await ctx.answerCbQuery('✅ Одобрено');
    await ctx.editMessageText(
      `✅ Доступ выдан <code>${targetUserId}</code> (${durText}).`,
      { parse_mode: 'HTML' }
    );

    try {
      await ctx.telegram.sendMessage(
        targetUserId,
        `✅ Ваш запрос на доступ одобрен! Подписка активна ${durText}.\nЗапустите /start.`
      );
    } catch (_) {
      /* пользователь мог заблокировать бота — молча игнорируем */
    }
  });

  // ---------- Отклонение доступа ----------
  bot.action(/^deny_access:(\d+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id))) {
      await ctx.answerCbQuery('⛔ Нет прав');
      return;
    }
    const targetUserId = parseInt(ctx.match[1], 10);
    await db.resolveAccessRequest(targetUserId, 'rejected');
    await ctx.answerCbQuery('❌ Отклонено');
    await ctx.editMessageText(
      `❌ Запрос пользователя <code>${targetUserId}</code> отклонён.`,
      { parse_mode: 'HTML' }
    );

    try {
      await ctx.telegram.sendMessage(
        targetUserId,
        '❌ К сожалению, ваш запрос на доступ отклонён.'
      );
    } catch (_) {}
  });

  // ---------- Назад в главное меню ----------
  // FSM уже сброшен middleware'ом (STATE_RESET_TEXTS содержит '⬅️ Назад').
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
    setState(userId, 'waiting_for_youtube_link');
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
    setState(userId, 'waiting_for_youtube_remove');
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
    setState(userId, 'waiting_for_rss_add');
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
    setState(userId, 'waiting_for_rss_remove');
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
      const list = keywords.length ? keywords.map((k) => `🔹 ${k}`).join('\n') : '— нет —';
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
    setState(userId, 'waiting_for_keyword_add');
    await ctx.reply('✏️ Введите ключевое слово для добавления (можно несколько через запятую или пробел):');
  });

  bot.hears('🗑️ Удалить ключевое слово', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    setState(userId, 'waiting_for_keyword_remove');
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
        ? channels.map((c) => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
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
    setState(userId, 'waiting_for_target_channel_add');
    await ctx.reply('✏️ Введите ID целевого канала (например: -1001234567890):');
  });

  bot.hears('🗑️ Удалить целевой канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    setState(userId, 'waiting_for_target_channel_remove');
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
        ? channels.map((c) => `🔹 ${c.channel_id} (${c.channel_title || 'без названия'})`).join('\n')
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
    setState(userId, 'waiting_for_monitored_channel_add');
    await ctx.reply('✏️ Введите ID канала для отслеживания (например: -1001234567890):');
  });

  bot.hears('🗑️ Удалить отслеживаемый канал', async (ctx) => {
    const ok = await ensureUser(ctx);
    if (!ok) return;
    const userId = ctx.from.id;
    setState(userId, 'waiting_for_monitored_channel_remove');
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
        const found = monitored.find((ch) => ch.channel_id === channelId);
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

    // Админские состояния не требуют активной подписки (проверка внутри)
    const isAdminState = state && state.startsWith('admin_waiting_');
    if (!isAdminState) {
      const ok = await ensureUser(ctx);
      if (!ok) return;
    }

    try {
      // Отмена действия
      if (text.toLowerCase() === 'отмена' && state) {
        clearState(userId);
        let returnMenu = mainMenu;
        if (state === 'waiting_for_youtube_link' || state === 'waiting_for_youtube_remove') {
          returnMenu = youtubeMenu;
        } else if (state === 'waiting_for_rss_add' || state === 'waiting_for_rss_remove') {
          returnMenu = rssMenu;
        } else if (
          state === 'admin_waiting_sysfeed_add' ||
          state === 'admin_waiting_sysfeed_remove'
        ) {
          returnMenu = systemFeedsMenu;
        } else if (state === 'admin_waiting_promote' || state === 'admin_waiting_demote') {
          returnMenu = adminsSubMenu;
        } else if (state === 'admin_waiting_add_sub' || state === 'admin_waiting_remove_user') {
          returnMenu = getAdminMenu(isMainAdmin(userId));
        }
        await ctx.reply('❌ Действие отменено.', returnMenu);
        return;
      }

      // ---------- Состояния пользователей ----------
      if (state === 'waiting_for_youtube_link') {
        await helpers.handleAddYouTube(ctx, text, youtubeMenu, userId);
        clearState(userId);
        return;
      }

      if (state === 'waiting_for_youtube_remove') {
        await helpers.handleYouTubeRemove(ctx, text, youtubeMenu, userId);
        clearState(userId);
        return;
      }

      if (state === 'waiting_for_rss_add') {
        await helpers.addRssFeed(ctx, text, rssMenu, userId);
        clearState(userId);
        return;
      }

      if (state === 'waiting_for_rss_remove') {
        await helpers.removeRssFeed(ctx, text, rssMenu, userId);
        clearState(userId);
        return;
      }

      // --- МАССОВОЕ ДОБАВЛЕНИЕ ключевых слов ---
      if (state === 'waiting_for_keyword_add') {
        let keywordsList;
        if (text.includes(',')) {
          keywordsList = text.split(',').map((kw) => kw.trim()).filter((kw) => kw.length > 0);
        } else {
          keywordsList = text.split(/\s+/).filter((kw) => kw.length > 0);
        }

        if (keywordsList.length === 0) {
          await ctx.reply('❌ Вы не ввели ни одного ключевого слова.', keywordsMenu);
          clearState(userId);
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
        clearState(userId);
        return;
      }

      // --- МАССОВОЕ УДАЛЕНИЕ ключевых слов ---
      if (state === 'waiting_for_keyword_remove') {
        let keywordsToRemove;
        if (text.includes(',')) {
          keywordsToRemove = text.split(',').map((kw) => kw.trim()).filter((kw) => kw.length > 0);
        } else {
          keywordsToRemove = text.split(/\s+/).filter((kw) => kw.length > 0);
        }

        if (keywordsToRemove.length === 0) {
          await ctx.reply('❌ Вы не ввели ни одного ключевого слова для удаления.', keywordsMenu);
          clearState(userId);
          return;
        }

        const allKeywords = await db.getKeywords(userId);
        const lowerKeywords = allKeywords.map((k) => k.toLowerCase());

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
        clearState(userId);
        return;
      }

      if (state === 'waiting_for_target_channel_add') {
        const result = await helpers.addChannelSimple(userId, text, 'target');
        clearState(userId);
        await ctx.reply(result.message, targetChannelsMenu);
        return;
      }

      if (state === 'waiting_for_monitored_channel_add') {
        const result = await helpers.addChannelSimple(userId, text, 'monitored');
        clearState(userId);
        await ctx.reply(result.message, monitoredChannelsMenu);
        return;
      }

      if (state === 'waiting_for_target_channel_remove') {
        await helpers.removeChannelSimple(
          ctx,
          text,
          'target',
          { targetChannelsMenu, monitoredChannelsMenu },
          userId
        );
        clearState(userId);
        return;
      }

      if (state === 'waiting_for_monitored_channel_remove') {
        await helpers.removeChannelSimple(
          ctx,
          text,
          'monitored',
          { targetChannelsMenu, monitoredChannelsMenu },
          userId
        );
        clearState(userId);
        return;
      }

      // ---------- Админские состояния ----------
      if (state === 'admin_waiting_add_sub') {
        if (!(await isAdmin(userId))) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }
        const parts = text.split(' ');
        if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
          await ctx.reply(
            '❌ Неверный формат. Введите: ID_пользователя количество_дней',
            getAdminMenu(isMainAdmin(userId))
          );
          return;
        }
        const targetUserId = parseInt(parts[0]);
        const days = parseInt(parts[1]);
        const success = await db.updateUserSubscription(targetUserId, days);
        await ctx.reply(
          success
            ? `✅ Пользователю ${targetUserId} добавлено ${days} дней.`
            : `❌ Пользователь ${targetUserId} не найден.`,
          getAdminMenu(isMainAdmin(userId))
        );
        clearState(userId);
        return;
      }

      if (state === 'admin_waiting_remove_user') {
        if (!(await isAdmin(userId))) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }
        const targetUserId = parseInt(text);
        if (isNaN(targetUserId)) {
          await ctx.reply('❌ Введите корректный числовой ID.', getAdminMenu(isMainAdmin(userId)));
          return;
        }
        const success = await db.deleteUser(targetUserId);
        await ctx.reply(
          success
            ? `✅ Пользователь ${targetUserId} удалён.`
            : `❌ Пользователь ${targetUserId} не найден.`,
          getAdminMenu(isMainAdmin(userId))
        );
        clearState(userId);
        return;
      }

      if (state === 'admin_waiting_promote') {
        if (!isMainAdmin(userId)) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }
        const targetUserId = parseInt(text, 10);
        if (isNaN(targetUserId)) {
          await ctx.reply('❌ Введите корректный числовой ID.', adminsSubMenu);
          return;
        }
        const target = await db.getUser(targetUserId);
        if (!target) {
          await ctx.reply(
            '❌ Пользователь не найден. Он должен хотя бы раз запустить /start.',
            adminsSubMenu
          );
          clearState(userId);
          return;
        }
        await db.setAdmin(targetUserId, true);
        await ctx.reply(
          `✅ <code>${targetUserId}</code> назначен администратором (бессрочный доступ).`,
          { parse_mode: 'HTML', ...adminsSubMenu }
        );
        botLogger.info(`👑 Пользователь ${targetUserId} назначен админом (кем: ${userId})`);
        clearState(userId);
        return;
      }

      if (state === 'admin_waiting_demote') {
        if (!isMainAdmin(userId)) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }
        const targetUserId = parseInt(text, 10);
        if (isNaN(targetUserId)) {
          await ctx.reply('❌ Введите корректный числовой ID.', adminsSubMenu);
          return;
        }
        if (isMainAdmin(targetUserId)) {
          await ctx.reply('❌ Нельзя снять права с главного администратора.', adminsSubMenu);
          clearState(userId);
          return;
        }
        await db.setAdmin(targetUserId, false);
        await ctx.reply(
          `✅ Права администратора сняты с <code>${targetUserId}</code>.`,
          { parse_mode: 'HTML', ...adminsSubMenu }
        );
        botLogger.info(`🔻 Пользователь ${targetUserId} лишён прав админа (кем: ${userId})`);
        clearState(userId);
        return;
      }

      // ---------- Системные источники: FSM ----------
      if (state === 'admin_waiting_sysfeed_add') {
        if (!isMainAdmin(userId)) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }

        const url = text.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          await ctx.reply(
            '❌ URL должен начинаться с http:// или https://',
            systemFeedsMenu
          );
          return; // оставляем состояние активным, чтобы пользователь мог повторить
        }

        const existing = await db.getSystemFeeds();
        if (existing.includes(url)) {
          await ctx.reply('ℹ️ Эта системная лента уже добавлена.', systemFeedsMenu);
          clearState(userId);
          return;
        }

        await db.addSystemFeed(url);
        await ctx.reply(`✅ Системная RSS-лента добавлена:\n${url}`, systemFeedsMenu);
        botLogger.info(`🌐 Главный админ добавил системную ленту: ${url}`);
        clearState(userId);
        return;
      }

      if (state === 'admin_waiting_sysfeed_remove') {
        if (!isMainAdmin(userId)) {
          await ctx.reply('⛔ Нет прав.');
          clearState(userId);
          return;
        }

        const feeds = await db.getSystemFeeds();
        if (feeds.length === 0) {
          await ctx.reply('❌ Нет системных RSS-лент для удаления.', systemFeedsMenu);
          clearState(userId);
          return;
        }

        let feedToRemove = null;
        const num = parseInt(text, 10);
        if (!isNaN(num) && num >= 1 && num <= feeds.length) {
          feedToRemove = feeds[num - 1];
        } else {
          feedToRemove = feeds.find((f) => f === text.trim());
        }

        if (!feedToRemove) {
          await ctx.reply(
            '❌ Лента не найдена. Проверьте номер или введите полный URL.\n\n' +
              'Используйте «📋 Список системных RSS», чтобы увидеть доступные ленты.',
            systemFeedsMenu
          );
          return; // оставляем состояние, чтобы можно было повторить
        }

        await db.removeSystemFeed(feedToRemove);
        await ctx.reply(`✅ Системная RSS-лента удалена.`, systemFeedsMenu);
        botLogger.info(`🗑️ Главный админ удалил системную ленту: ${feedToRemove}`);
        clearState(userId);
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
    // Сбрасываем FSM, иначе пользователь застрянет в состоянии до рестарта.
    if (ctx && ctx.from && ctx.from.id) {
      userStates.delete(ctx.from.id);
    }
    ctx.reply('❌ Произошла внутренняя ошибка. Попробуйте позже.').catch(() => {});
  });
}

module.exports = { registerHandlers };