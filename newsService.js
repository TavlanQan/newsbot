// newsService.js
const Parser = require('rss-parser');
const { botLogger } = require('./utils/logger');
const errorHandler = require('./errorHandler');
const db = require('./db');
const queue = require('./queue');
const config = require('./config');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'NewsBot/1.0' },
  customFields: {
    item: ['media:group', 'media:content', 'yt:videoId']
  }
});

// Храним последние проверенные новости для каждого пользователя и фида
// Ключ: `${userId}:${feedUrl}`, значение: массив { link, title, pubDate }
//
// ⚠️ ВАЖНО: кеш хранится в памяти и обнуляется при каждом рестарте бота.
// После рестарта при первой проверке возможно повторная отправка
// до 5 свежих записей на каждый фид, если они совпадают с ключевыми словами.
// Для устранения — вынести в БД (аналог forwarded_messages).
let lastItemsCache = {};

// Кеш распарсенных лент в рамках одного цикла checkAllFeeds.
// Позволяет не парсить один и тот же фид несколько раз, если его
// слушают несколько пользователей. Сбрасывается в null после цикла.
let parseCache = null;

// Функция проверки одной ленты для одного пользователя
async function checkFeedForUser(userId, feedUrl, bot) {
  try {
    // Используем кеш, если он активен (внутри checkAllFeeds)
    let feed;
    if (parseCache && parseCache.has(feedUrl)) {
      feed = parseCache.get(feedUrl);
    } else {
      feed = await parser.parseURL(feedUrl);
      if (parseCache) parseCache.set(feedUrl, feed);
    }

    if (!feed || !feed.items || feed.items.length === 0) return;

    // Получаем ключевые слова пользователя
    const keywords = await db.getKeywords(userId);
    if (keywords.length === 0) {
      botLogger.debug(`Пользователь ${userId} не имеет ключевых слов, пропускаем`);
      return;
    }

    // Получаем целевые каналы пользователя
    const targets = await db.getTargetChannels(userId);
    if (targets.length === 0) {
      botLogger.debug(`Пользователь ${userId} не имеет целевых каналов, пропускаем`);
      return;
    }

    // Берём последние 5 элементов, чтобы не пропустить
    const items = feed.items.slice(0, 5);
    const cacheKey = `${userId}:${feedUrl}`;
    const lastChecked = lastItemsCache[cacheKey] || [];

    for (const item of items) {
      // Проверяем, не было ли уже отправлено
      const alreadySent = lastChecked.some((i) => i.link === item.link);
      if (alreadySent) continue;

      // Проверяем наличие ключевых слов в заголовке или описании
      const title = (item.title || '').toLowerCase();
      const description = (item.contentSnippet || item.content || '').toLowerCase();
      const fullText = title + ' ' + description;

      const matchedKeywords = keywords.filter((kw) => fullText.includes(kw.toLowerCase()));
      if (matchedKeywords.length === 0) continue;

      // Формируем сообщение
      let message = `<b>${escapeHtml(item.title || 'Новость')}</b>\n`;
      if (item.contentSnippet) message += `${escapeHtml(item.contentSnippet.substring(0, 300))}...\n`;
      if (item.link) message += `<a href="${escapeHtml(item.link)}">Читать далее</a>\n`;
      message += `\n🔑 Совпавшие ключевые слова: ${escapeHtml(matchedKeywords.join(', '))}`;

      // Отправляем во все целевые каналы пользователя
      for (const target of targets) {
        queue.add(async () => {
          try {
            await bot.telegram.sendMessage(target.channel_id, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false
            });
            botLogger.info(
              `📨 Отправлено пользователю ${userId} в канал ${target.channel_id}: ${item.title}`
            );
          } catch (err) {
            errorHandler.handleError(err, `newsService: отправка пользователю ${userId}`);
          }
        });
      }

      // Добавляем в кеш
      lastChecked.push({ link: item.link, title: item.title, pubDate: item.pubDate });
      if (lastChecked.length > 50) lastChecked.shift(); // ограничиваем размер
    }

    lastItemsCache[cacheKey] = lastChecked;
  } catch (error) {
    errorHandler.handleError(
      error,
      `newsService: checkFeedForUser ${feedUrl} для пользователя ${userId}`
    );
  }
}

// Основная функция проверки всех лент всех пользователей
async function checkAllFeeds(bot) {
  botLogger.info('🔄 Запуск проверки RSS для всех пользователей...');

  // Инициализируем кеш распарсенных лент на время этого цикла
  parseCache = new Map();

  try {
    // Читаем системные ленты ОДИН раз на весь цикл.
    // Они применяются ко всем активным пользователям (с дедупликацией против личных фидов).
    const systemFeeds = await db.getSystemFeeds();

    // Читаем всех пользователей. Раньше мы итерировались только по владельцам user_feeds —
    // это не подходит, потому что системные ленты должны доходить и до тех,
    // у кого нет личных подписок.
    const allUsers = await db.listUsers();
    if (allUsers.length === 0) {
      botLogger.info('ℹ️ Нет пользователей — проверка не требуется');
      return;
    }

    // Карта личных фидов: { userId: [feedUrl, ...] }
    const allFeeds = await db.getAllFeeds();
    const userFeedsMap = {};
    for (const row of allFeeds) {
      if (!userFeedsMap[row.user_id]) userFeedsMap[row.user_id] = [];
      userFeedsMap[row.user_id].push(row.feed_url);
    }

    let processedUsers = 0;
    let totalChecks = 0;

    for (const user of allUsers) {
      const uid = user.user_id;

      const hasSub = await db.hasActiveSubscription(uid);
      if (!hasSub) {
        // debug, а не info — при большом числе пользователей лог бы засорялся
        botLogger.debug(`⏭️ Пользователь ${uid} не имеет активной подписки, пропускаем`);
        continue;
      }

      const personalFeeds = userFeedsMap[uid] || [];
      // Set защищает от двойной проверки одного фида, если URL есть
      // и в личных подписках, и в системных
      const feedsForUser = [...new Set([...personalFeeds, ...systemFeeds])];

      if (feedsForUser.length === 0) continue;

      processedUsers++;
      for (const feedUrl of feedsForUser) {
        await checkFeedForUser(uid, feedUrl, bot);
        totalChecks++;
      }
    }

    botLogger.info(
      `📊 Активных пользователей с фидами: ${processedUsers}, ` +
        `всего проверок фидов: ${totalChecks} ` +
        `(системных в наборе: ${systemFeeds.length})`
    );
    botLogger.info('✅ Проверка RSS завершена');
  } catch (error) {
    errorHandler.handleError(error, 'newsService: checkAllFeeds');
  } finally {
    // Сбрасываем кеш — при следующем цикле данные могут измениться
    parseCache = null;
  }
}

// Функция для ручного запуска (для тестов)
async function manualCheck(bot) {
  await checkAllFeeds(bot);
}

// Вспомогательная функция экранирования HTML
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Экспортируем
module.exports = {
  checkAllFeeds,
  manualCheck
};