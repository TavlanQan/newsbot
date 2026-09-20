// helpers.js
const axios = require('axios');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const db = require('./db');
const config = require('./config');
const queue = require('./queue');

// ---------- Утилита: нормализованный URL микросервиса YouTube ----------
// Возвращает URL, гарантированно заканчивающийся на /rss, и не равный undefined.
// Используется везде, где нужно отличить YouTube-фиды от обычных RSS.
function getYouTubeServiceUrl() {
  let serviceUrlRaw = config.YOUTUBE_RSS_SERVICE_URL;

  if (!serviceUrlRaw || typeof serviceUrlRaw !== 'string') {
    botLogger.warn(
      '⚠️ YOUTUBE_RSS_SERVICE_URL не задан в .env — использую значение по умолчанию: http://localhost:5005/rss'
    );
    serviceUrlRaw = 'http://localhost:5005/rss';
  }

  let serviceUrl = serviceUrlRaw.trim();
  if (!serviceUrl.endsWith('/rss')) {
    if (serviceUrl.endsWith('/')) {
      serviceUrl += 'rss';
    } else {
      serviceUrl += '/rss';
    }
  }
  return serviceUrl;
}

// ---------- Утилита: список системных RSS-лент из .env ----------
// Используется ТОЛЬКО для однократной миграции при старте бота (см. bot.js).
// ВАЖНО: config.RSS_FEEDS уже парсится в массив внутри config.js.
// Но оставляем защиту от строки на случай изменения парсера в будущем.
function getSystemFeedUrls() {
  const feeds = config.RSS_FEEDS;

  if (Array.isArray(feeds)) {
    return feeds.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  }

  if (typeof feeds === 'string' && feeds.trim()) {
    return feeds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}

// ---------- Утилиты для текста (XML/HTML сущности) ----------
// Простой unescape XML/HTML-сущностей для текста, извлечённого из RSS.
// Порядок важен: &amp; раскрывается ПОСЛЕДНИМ, иначе "&amp;lt;" даст "&lt;"
// вместо "<".
function unescapeXmlBasic(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Экранирование для безопасного вывода в Telegram с parse_mode:'HTML'.
// Названия YouTube-каналов и RSS-фидов могут содержать &, <, > — без
// экранирования Telegram отклонит сообщение с ошибкой 400 Bad Request.
function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
    const channelTitle =
      channelType === 'target' ? `Канал ${channelIdentifier}` : `Мониторинг ${channelIdentifier}`;
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
    const found = allChannels.find(
      (ch) =>
        ch.channel_id === userText ||
        (ch.channel_username && ch.channel_username.includes(userText)) ||
        (ch.channel_title && ch.channel_title.includes(userText))
    );
    if (!found) {
      const availableChannels = allChannels
        .map((ch) => `- ${ch.channel_id} (${ch.channel_title || 'без названия'})`)
        .join('\n');
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
// Возвращает true сразу после постановки задач в очередь — это НЕ значит,
// что все сообщения уже доставлены. Реальная отправка асинхронна (см. queue.js).
async function sendMessageToTargetChannels(bot, userId, message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels(userId);
    if (targetChannels.length === 0) {
      botLogger.warn(`⚠️ У пользователя ${userId} нет целевых каналов для отправки сообщения`);
      return false;
    }

    for (const targetChannel of targetChannels) {
      queue.add(async () => {
        try {
          await bot.telegram.sendMessage(targetChannel.channel_id, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            ...options
          });
          botLogger.info(
            `✅ Отправлено сообщение в канал ${targetChannel.channel_id} (пользователь ${userId})`
          );
        } catch (error) {
          errorHandler.handleError(
            error,
            `helpers.js: sendMessageToTargetChannels (queue task for ${targetChannel.channel_id})`
          );
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
      botLogger.warn(
        `⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано (пользователь ${userId})`
      );
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
          botLogger.info(
            `📤 Переслано сообщение ${messageId} → ${targetChannel.channel_id} (пользователь ${userId})`
          );
        } catch (error) {
          errorHandler.handleError(
            error,
            `helpers.js: forwardMessageFromChannel (queue task for ${targetChannel.channel_id})`
          );
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
  const youtubePrefix = getYouTubeServiceUrl();
  return feeds.filter((feed) => feed.startsWith(youtubePrefix));
}

// Аналог getYouTubeFeeds, но с метаданными: [{feedUrl, feedTitle, ucId}, ...].
// Порядок тот же, что и у getYouTubeFeeds — обе читают из user_feeds без
// ORDER BY, стабильно по rowid. Значит нумерация в «Список YouTube»
// и в «Удалить YouTube» совпадает.
//
// ucId может быть null для легаси-фидов (?channel=https://...), тогда
// вызывающий код должен показать сам feed_url.
async function getYouTubeFeedsWithMeta(userId) {
  const feeds = await db.getUserFeedsWithMeta(userId);
  const youtubePrefix = getYouTubeServiceUrl();
  return feeds
    .filter((f) => f.feed_url.startsWith(youtubePrefix))
    .map((f) => {
      let ucId = null;
      try {
        const u = new URL(f.feed_url);
        ucId = u.searchParams.get('channel') || null;
      } catch {
        /* битый URL — ucId останется null, покажем feed_url */
      }
      return {
        feedUrl: f.feed_url,
        feedTitle: f.feed_title || null,
        ucId
      };
    });
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

// ---------- Извлечение идентификатора канала из ссылки ----------
function extractChannelIdentifier(input) {
  const trimmed = input.trim();

  // Уже настоящий Channel ID
  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);

    const hostname = url.hostname.toLowerCase();

    // Поддерживаем youtube.com, www.youtube.com, m.youtube.com
    if (
      hostname !== 'youtube.com' &&
      hostname !== 'www.youtube.com' &&
      hostname !== 'm.youtube.com'
    ) {
      return null;
    }

    // Разрешаем URL канала передать непосредственно RSS-сервису.
    if (
      url.pathname.startsWith('/@') ||
      url.pathname.startsWith('/channel/') ||
      url.pathname.startsWith('/c/')
    ) {
      // FIX: убираем query-параметры (?si=, ?feature=share, ?pp=, ?t=...)
      // и hash — микросервису они не нужны, а в БД создают «фантомные»
      // дубликаты одного и того же канала.
      url.search = '';
      url.hash = '';

      let result = url.toString();
      // FIX: убираем trailing slash, чтобы /@name и /@name/ давали один URL
      if (result.endsWith('/')) result = result.slice(0, -1);
      return result;
    }

    // Видео не является каналом.
    if (url.pathname === '/watch' && url.searchParams.has('v')) {
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

// ---------- Улучшенная валидация YouTube-ссылок ----------
// Валидирует URL канала YouTube. Поддерживаются только youtube.com /
// www.youtube.com / m.youtube.com и «голый» UC ID длиной ровно 22 символа
// (совпадает с extractChannelIdentifier — иначе пользователь с UC+23
// получит сбивающую с толку ошибку на следующем шаге).
//
// Сокращатель youtu.be НЕ поддерживается: extractChannelIdentifier его
// всё равно отвергает, а раньше isValidYouTubeUrl его пропускал — это
// давало противоречивое поведение и мусорные подсказки.
function isValidYouTubeUrl(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  // Прямой channel ID (UC...). Ровно 22 символа после UC.
  if (/^UC[\w-]{22}$/.test(trimmed)) return true;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const validHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
    if (!validHosts.includes(url.hostname)) return false;
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

// ---------- Хелперы для канонизации YouTube-фидов ----------

// Извлекает UC ID из RSS-ответа микросервиса.
// Микросервис всегда кладёт в <channel><link> канонический UC-URL:
//   <link>https://www.youtube.com/channel/UC6NxANDfwWCQfRSfW-3e2WQ</link>
// Если найти не удалось — вернёт null.
function extractUcIdFromRssXml(xml) {
  if (typeof xml !== 'string') return null;
  // www. — опционально: сейчас микросервис отдаёт ссылку с www, но не
  // хотим зависеть от этого формата. Если YouTube/пакет rss поменяет
  // каноническую ссылку — регексп не должен отвалиться.
  const match = xml.match(
    /<link>https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{22})<\/link>/
  );
  return match ? match[1] : null;
}

// Извлекает название канала из RSS-ответа микросервиса.
// Микросервис кладёт в <channel><title> чистое название (см. generateRSS
// в yt_rss/index.js: title = channelTitle || channelId). Items идут позже,
// поэтому первый <title> в XML — это именно title канала.
//
// Возвращает null, если title не найден, пуст или равен fallback-UC ID.
function extractChannelTitleFromRssXml(xml) {
  if (typeof xml !== 'string') return null;
  const match = xml.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return null;

  let title = unescapeXmlBasic(match[1]).trim();
  if (!title) return null;

  // Отсекаем случай, когда вместо названия подставлен fallback-UC ID
  // (см. generateRSS в yt_rss/index.js: title: channelTitle || channelId).
  if (/^UC[\w-]{22}$/.test(title)) return null;

  return title;
}

// Проверяет, хранится ли фид в каноническом виде (?channel=UCxxxx).
// Легаси-фиды (?channel=https://youtube.com/@handle) возвращают false.
function isCanonicalYouTubeFeedUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    const ch = u.searchParams.get('channel') || '';
    return /^UC[\w-]{22}$/.test(ch);
  } catch {
    return false;
  }
}

// Резолвит UC ID для уже сохранённого фида через микросервис.
// Нужно для проверки дублей: пользователь добавляет @handle, а в БД
// уже лежит тот же канал под другим @handle (или под старым URL с ?si=).
async function findExistingUcIdForFeed(feedUrl) {
  try {
    const resp = await axios.get(feedUrl, { timeout: 5000 });
    return extractUcIdFromRssXml(resp.data);
  } catch {
    return null;
  }
}

// ---------- Добавление YouTube-канала ----------
async function handleAddYouTube(ctx, input, youtubeMenu, userId) {
  try {
    const cleanedInput = input.trim();
    botLogger.info(`YouTube input (cleaned): ${cleanedInput}`);

    if (!isValidYouTubeUrl(cleanedInput)) {
      await ctx.reply(
        '❌ Это не похоже на ссылку YouTube.\n\n' +
          'Поддерживаются форматы:\n' +
          '• https://www.youtube.com/@ChannelName\n' +
          '• https://www.youtube.com/c/ChannelName\n' +
          '• https://www.youtube.com/channel/UCxxxx\n' +
          '• UCxxxxxxxxxxxxxxxxxxxxx',
        youtubeMenu
      );
      return;
    }

    const channelId = extractChannelIdentifier(cleanedInput);
    if (!channelId) {
      await ctx.reply(
        '❌ Не удалось извлечь идентификатор канала из ссылки.\n' +
          'Убедитесь, что это ссылка на канал (не на видео).',
        youtubeMenu
      );
      return;
    }
    botLogger.info(`Извлечён идентификатор канала: ${channelId}`);

    // Нормализованный URL микросервиса (единая точка истины)
    const serviceUrl = getYouTubeServiceUrl();

    if (!serviceUrl.startsWith('http://') && !serviceUrl.startsWith('https://')) {
      await ctx.reply(
        '❌ YOUTUBE_RSS_SERVICE_URL должен начинаться с http:// или https://.\n' +
          'Текущее значение: ' + serviceUrl,
        youtubeMenu
      );
      return;
    }

    // Проверяем доступность микросервиса и одновременно проверяем, что он может распознать канал
    const testUrl = `${serviceUrl}?channel=${encodeURIComponent(channelId)}`;
    botLogger.info(`Проверяем RSS-генерацию для канала: ${testUrl}`);

    let response;
    try {
      response = await axios.get(testUrl, { timeout: 5000 });
      if (typeof response.data === 'string' && response.data.includes('Ошибка определения канала')) {
        await ctx.reply(
          '❌ Микросервис не смог распознать этот канал.\n' +
            'Проверьте, что ссылка ведёт на существующий канал, и попробуйте снова.\n' +
            'Если проблема повторяется, обратитесь к администратору.',
          youtubeMenu
        );
        return;
      }
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
      throw error;
    }

    // FIX: достаём канонический UC ID и название канала из ответа микросервиса.
    // Микросервис принимает и handle, и UC ID, а возвращает всегда UC ID в <link>.
    // Это позволяет хранить один и тот же канал в БД под единым URL,
    // независимо от того, как пользователь его добавил (@taulanq / @TaulanSalpagarov-m6m / UCxxx).
    // Title извлекается из того же XML — дополнительных запросов к YouTube API нет.
    const resolvedUcId = extractUcIdFromRssXml(response.data);
    const channelTitle = extractChannelTitleFromRssXml(response.data);
    const canonicalChannelId = resolvedUcId || channelId;

    if (resolvedUcId && resolvedUcId !== channelId) {
      botLogger.info(`🔍 Handle ${channelId} разрешён в UC ID: ${resolvedUcId}`);
    }

    // Если микросервис вернул RSS без канонического <link>.../channel/UC...,
    // канонизация молча выключается: в БД попадёт неканонический URL,
    // и дедуп по UC ID работать не будет. Логируем warning — иначе этот
    // сценарий диагностируется только по косвенным признакам (дубли в списке).
    if (!resolvedUcId) {
      botLogger.warn(
        `⚠️ Не удалось извлечь UC ID из RSS для ${channelId}. ` +
          `Сохраняем как есть — канонизация не сработала, возможны дубли.`
      );
    }

    if (channelTitle) {
      botLogger.info(`📺 Извлечён title канала: "${channelTitle}"`);
    } else {
      botLogger.warn(
        `⚠️ Не удалось извлечь title из RSS для ${canonicalChannelId} — пользователь сможет задать вручную`
      );
    }

    // Формируем канонический URL для RSS-ленты
    const canonicalUrl = `${serviceUrl}?channel=${encodeURIComponent(canonicalChannelId)}`;

    // FIX: проверяем дубликаты не только по точному URL, но и по UC ID
    const feeds = await db.getUserFeeds(userId);

    // 1) Прямая проверка канонического URL
    if (feeds.includes(canonicalUrl)) {
      await ctx.reply('ℹ️ Этот YouTube канал уже отслеживается.', youtubeMenu);
      return;
    }

    // 2) Если добавили через handle — проверяем легаси-фиды (сохранённые как ?channel=https://...).
    //    Резолвим их UC ID и сравниваем. Медленно, но таких фидов мало.
    if (resolvedUcId) {
      const legacyYouTubeFeeds = feeds.filter((f) => {
        if (!f.startsWith(serviceUrl)) return false;
        return !isCanonicalYouTubeFeedUrl(f);
      });

      for (const legacyFeed of legacyYouTubeFeeds) {
        const existingUcId = await findExistingUcIdForFeed(legacyFeed);
        if (existingUcId === resolvedUcId) {
          await ctx.reply(
            `ℹ️ Этот YouTube канал уже отслеживается.\n\n` +
              `Сохранён под старой ссылкой:\n${legacyFeed}\n\n` +
              `Если хотите обновить на каноническую — удалите старую через «🗑️ Удалить YouTube» и добавьте заново.`,
            youtubeMenu
          );
          return;
        }
      }
    }

    // Сохраняем с title (может быть null — тогда пользователь задаст вручную)
    await db.addUserFeed(userId, canonicalUrl, channelTitle);

    if (channelTitle) {
      await ctx.reply(
        '✅ YouTube канал успешно добавлен в мониторинг!\n\n' +
          `📺 Название: <b>${escapeHtml(channelTitle)}</b>\n` +
          `📡 RSS-ссылка: ${canonicalUrl}\n` +
          `🔑 Идентификатор: ${canonicalChannelId}\n\n` +
          'Новости будут приходить в целевые каналы, если совпадут с ключевыми словами.',
        { parse_mode: 'HTML', ...youtubeMenu }
      );
    } else {
      await ctx.reply(
        '✅ YouTube канал добавлен, но название получить не удалось.\n\n' +
          `📡 RSS-ссылка: ${canonicalUrl}\n` +
          `🔑 Идентификатор: ${canonicalChannelId}\n\n` +
          'Название можно задать вручную — кнопка «✏️ Задать название»\n' +
          'в меню «📺 YouTube каналы».\n\n' +
          'Новости будут приходить в целевые каналы, если совпадут с ключевыми словами.',
        youtubeMenu
      );
    }

    botLogger.info(
      `📺 Пользователь ${userId} добавил YouTube: ${cleanedInput} -> ${canonicalUrl}` +
        (channelTitle ? ` ("${channelTitle}")` : '')
    );
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
      feedToRemove = youtubeFeeds.find((feed) => feed === input);
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
    // FIX: чистим feed_state. При повторном добавлении фид заново пройдёт
    // сидирование — иначе, если первый парсинг был по пустому фиду,
    // при повторном добавлении все накопившиеся записи ушли бы флудом.
    await db.removeFeedState(userId, feedToRemove).catch(() => {});

    await ctx.reply(`✅ YouTube-канал удалён.`, youtubeMenu);
    botLogger.info(`🗑️ Пользователь ${userId} удалил YouTube: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleYouTubeRemove');
    await ctx.reply('❌ Ошибка при удалении YouTube-канала.', youtubeMenu);
  }
}

// ---------- Ручное задание названия YouTube-канала ----------
// Формат ввода: "<номер> <название>" — номер и название через пробел.
// Название может содержать пробелы (берём всё после первого пробела).
// Порядок нумерации совпадает с «📋 Список YouTube» (см. getYouTubeFeedsWithMeta).
async function handleSetYouTubeTitle(ctx, input, youtubeMenu, userId) {
  try {
    const feeds = await getYouTubeFeedsWithMeta(userId);
    if (feeds.length === 0) {
      await ctx.reply('📺 Нет добавленных YouTube-каналов.', youtubeMenu);
      return;
    }

    // \s+ — несколько пробелов тоже ок; s-флаг — .+ матчит переводы строк
    const match = input.match(/^(\d+)\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        '❌ Неверный формат.\n\n' +
          'Введите номер канала и новое название через пробел.\n' +
          'Пример: <code>1 Alan Elni Bilgileri</code>\n\n' +
          'Посмотреть номера можно через «📋 Список YouTube».',
        { parse_mode: 'HTML', ...youtubeMenu }
      );
      return;
    }

    const num = parseInt(match[1], 10);
    const newTitle = match[2].trim();

    if (num < 1 || num > feeds.length) {
      await ctx.reply(
        `❌ Номер должен быть от 1 до ${feeds.length}.`,
        youtubeMenu
      );
      return;
    }

    if (!newTitle) {
      await ctx.reply('❌ Название не может быть пустым.', youtubeMenu);
      return;
    }

    const target = feeds[num - 1];
    const updated = await db.updateUserFeedTitle(userId, target.feedUrl, newTitle);

    if (!updated) {
      await ctx.reply(
        '❌ Не удалось обновить название — фид не найден в БД.',
        youtubeMenu
      );
      return;
    }

    await ctx.reply(
      `✅ Название обновлено:\n<b>${escapeHtml(newTitle)}</b>`,
      { parse_mode: 'HTML', ...youtubeMenu }
    );
    botLogger.info(
      `✏️ Пользователь ${userId} задал title для ${target.feedUrl}: "${newTitle}"`
    );
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: handleSetYouTubeTitle');
    await ctx.reply('❌ Ошибка при обновлении названия.', youtubeMenu);
  }
}

// ---------- RSS функции (для сайтов, не YouTube) ----------
// Возвращает только собственные RSS-ленты пользователя (без YouTube).
// Системные ленты (таблица system_feeds) в user_feeds не хранятся и здесь не появляются.
async function getRssFeeds(userId) {
  const feeds = await db.getUserFeeds(userId);
  const youtubePrefix = getYouTubeServiceUrl();
  return feeds.filter((feed) => !feed.startsWith(youtubePrefix));
}

// Возвращает массив объектов { url } — оставлено для совместимости с handlers.js.
// Поле fromEnv упразднено: системные ленты теперь живут в отдельной таблице system_feeds
// и в интерфейсе обычного пользователя/админа не отображаются.
async function getRssFeedsWithMeta(userId) {
  const dbFeeds = await getRssFeeds(userId);
  return dbFeeds.map((feed) => ({ url: feed }));
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
      feedToRemove = dbFeeds.find((feed) => feed === input);
    }

    if (!feedToRemove) {
      await ctx.reply(
        '❌ Лента не найдена. Проверьте номер или введите полный URL.\n\n' +
          'Используйте "📋 Список RSS", чтобы увидеть доступные ленты.',
        rssMenu
      );
      return;
    }

    // Защиты системных лент здесь больше нет — они не хранятся в user_feeds.
    await db.removeUserFeed(userId, feedToRemove);
    // FIX: чистим feed_state, чтобы при повторном добавлении фид
    // заново сидировался (см. handleYouTubeRemove для деталей).
    await db.removeFeedState(userId, feedToRemove).catch(() => {});

    await ctx.reply(`✅ RSS-лента удалена.`, rssMenu);
    botLogger.info(`🗑️ Пользователь ${userId} удалил RSS: ${feedToRemove}`);
  } catch (error) {
    errorHandler.handleError(error, 'helpers.js: removeRssFeed');
    await ctx.reply('❌ Ошибка при удалении RSS-ленты.', rssMenu);
  }
}

module.exports = {
  // утилиты
  getYouTubeServiceUrl,
  getSystemFeedUrls,
  escapeHtml,
  // каналы
  addChannelSimple,
  removeChannelSimple,
  // отправка / пересылка
  sendMessageToTargetChannels,
  forwardMessageFromChannel,
  // YouTube
  getYouTubeFeeds,
  getYouTubeFeedsWithMeta,
  updateAllFeeds,
  isValidYouTubeUrl,
  handleAddYouTube,
  handleYouTubeRemove,
  handleSetYouTubeTitle,
  // RSS
  getRssFeeds,
  getRssFeedsWithMeta,
  addRssFeed,
  removeRssFeed
};