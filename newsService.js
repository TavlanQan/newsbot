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
let lastItemsCache = {};

// Функция проверки одной ленты для одного пользователя
async function checkFeedForUser(userId, feedUrl, bot) {
  try {
    const feed = await parser.parseURL(feedUrl);
    if (!feed.items || feed.items.length === 0) return;

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
      const alreadySent = lastChecked.some(i => i.link === item.link);
      if (alreadySent) continue;

      // Проверяем наличие ключевых слов в заголовке или описании
      const title = (item.title || '').toLowerCase();
      const description = (item.contentSnippet || item.content || '').toLowerCase();
      const fullText = title + ' ' + description;

      const matchedKeywords = keywords.filter(kw => fullText.includes(kw.toLowerCase()));
      if (matchedKeywords.length === 0) continue;

      // Формируем сообщение
      let message = `<b>${escapeHtml(item.title || 'Новость')}</b>\n`;
      if (item.contentSnippet) message += `${escapeHtml(item.contentSnippet.substring(0, 300))}...\n`;
      if (item.link) message += `<a href="${escapeHtml(item.link)}">Читать далее</a>\n`;
      message += `\n🔑 Совпавшие ключевые слова: ${matchedKeywords.join(', ')}`;

      // Отправляем во все целевые каналы пользователя
      for (const target of targets) {
        queue.add(async () => {
          try {
            await bot.telegram.sendMessage(target.channel_id, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false
            });
            botLogger.info(`📨 Отправлено пользователю ${userId} в канал ${target.channel_id}: ${item.title}`);
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
    errorHandler.handleError(error, `newsService: checkFeedForUser ${feedUrl} для пользователя ${userId}`);
  }
}

// Основная функция проверки всех лент всех пользователей
async function checkAllFeeds(bot) {
  botLogger.info('🔄 Запуск проверки RSS для всех пользователей...');
  try {
    const allFeeds = await db.getAllFeeds(); // массив { user_id, feed_url }
    if (allFeeds.length === 0) {
      botLogger.info('ℹ️ Нет RSS-лент для проверки');
      return;
    }

    // Группируем по пользователям
    const userFeedsMap = {};
    for (const row of allFeeds) {
      if (!userFeedsMap[row.user_id]) userFeedsMap[row.user_id] = [];
      userFeedsMap[row.user_id].push(row.feed_url);
    }

    // Для каждого пользователя проверяем его ленты
    for (const [userId, feeds] of Object.entries(userFeedsMap)) {
      // Проверяем подписку (если не админ)
      const user = await db.getUser(parseInt(userId));
      if (!user) continue;
      const hasSub = await db.hasActiveSubscription(parseInt(userId));
      if (!hasSub) {
        botLogger.info(`Пользователь ${userId} не имеет активной подписки, пропускаем`);
        continue;
      }

      for (const feedUrl of feeds) {
        await checkFeedForUser(parseInt(userId), feedUrl, bot);
      }
    }
    botLogger.info('✅ Проверка RSS завершена');
  } catch (error) {
    errorHandler.handleError(error, 'newsService: checkAllFeeds');
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