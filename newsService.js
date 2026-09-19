// newsService.js
const Parser = require('rss-parser');
const { rssLogger } = require('./utils/logger');
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

// Сколько свежих записей фида просматривать за один цикл.
// Не 5, как раньше: если бот был недоступен несколько часов, за один цикл
// должно успеть догнать все накопившиеся. Дедуп через sent_rss_items
// защищает от повторной отправки, поэтому можно взять больше.
const ITEMS_PER_FEED = 20;

// Кеш распарсенных лент в рамках одного цикла checkAllFeeds.
// Сбрасывается в null после цикла. Между рестартами теряется — это ОК,
// потому что источник истины о «виденных» записях теперь в БД.
let parseCache = null;

async function checkFeedForUser(userId, feedUrl, bot) {
  try {
    // 1. Парсим фид (с кешем на время цикла)
    let feed;
    if (parseCache && parseCache.has(feedUrl)) {
      feed = parseCache.get(feedUrl);
    } else {
      feed = await parser.parseURL(feedUrl);
      if (parseCache) parseCache.set(feedUrl, feed);
    }

    // 2. Ключевые слова и цели — если нет, не тратим время.
    //    ВАЖНО: проверяем ДО feed_state, чтобы не создавать состояние
    //    для пользователя, который всё равно ничего не получит.
    const keywords = await db.getKeywords(userId);
    if (keywords.length === 0) return;

    const targets = await db.getTargetChannels(userId);
    if (targets.length === 0) return;

    // 3. Проверяем состояние фида (видели ли мы его когда-либо у этого пользователя).
    //    FIX: эту проверку делаем ДО проверки на пустоту — иначе пустой фид
    //    никогда не выйдет из режима сидирования: при первом парсинге
    //    feed_state не создастся, а при появлении первой записи она
    //    будет засеянена как «уже виденная» и не отправится.
    const seenBefore = await db.hasFeedState(userId, feedUrl);
    const feedIsEmpty = !feed || !feed.items || feed.items.length === 0;

    if (feedIsEmpty) {
      if (!seenBefore) {
        await db.initFeedState(userId, feedUrl);
        rssLogger.debug(
          `📭 Фид пуст при первом парсинге, инициализирован: user=${userId}, feed=${feedUrl}`
        );
      }
      return;
    }

    // 4. Берём верхние N записей
    const items = feed.items.slice(0, ITEMS_PER_FEED);
    if (items.length === 0) return;

    // 5. Первый парсинг непустого фида — сидируем.
    //    Помечаем все текущие записи как «уже виденные» БЕЗ отправки,
    //    чтобы не заваливать пользователя историей канала при добавлении.
    if (!seenBefore) {
      const links = items.map((i) => i.link).filter(Boolean);
      await db.markRssItemsSentBulk(userId, feedUrl, links);
      await db.initFeedState(userId, feedUrl);
      rssLogger.info(
        `🌱 Фид инициализирован: user=${userId}, feed=${feedUrl}, помечено записей=${links.length} (без отправки)`
      );
      return;
    }

    // 6. Основной проход.
    //    Дедуп по (userId, item_link) глобальный — если та же ссылка
    //    пришла из другого фида (например, эквивалентного YouTube-хендла),
    //    она уже помечена и не отправится повторно.
    let newCount = 0;
    let matchedCount = 0;
    const linksToMark = [];
    const seenInThisCycle = new Set();

    for (const item of items) {
      if (!item.link) continue;

      // Защита от дублей внутри одного фида (маловероятно, но бесплатно)
      if (seenInThisCycle.has(item.link)) continue;
      seenInThisCycle.add(item.link);

      // Уже отправляли когда-то?
      const sent = await db.isRssItemSent(userId, item.link);
      if (sent) continue;

      newCount++;

      // Матчинг по ключевым словам
      const title = (item.title || '').toLowerCase();
      const description = (item.contentSnippet || item.content || '').toLowerCase();
      const fullText = title + ' ' + description;
      const matched = keywords.some((kw) => fullText.includes(kw.toLowerCase()));

      // Помечаем запись как «просмотренную» в любом случае.
      // Даже если keyword не совпал — чтобы в следующий цикл не проверять
      // её повторно. Если пользователь позже добавит keyword, старое
      // не всплывёт — это ожидаемое поведение.
      linksToMark.push(item.link);

      if (!matched) continue;
      matchedCount++;

      // Формируем сообщение
      let message = `<b>${escapeHtml(item.title || 'Новость')}</b>\n`;
      if (item.contentSnippet) {
        message += `${escapeHtml(item.contentSnippet.substring(0, 300))}...\n`;
      }
      if (item.link) {
        message += `<a href="${escapeHtml(item.link)}">Читать далее</a>\n`;
      }

      // Отправляем во все целевые каналы
      for (const target of targets) {
        queue.add(async () => {
          try {
            await bot.telegram.sendMessage(target.channel_id, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false
            });
            rssLogger.info(
              `📨 Отправлено ${userId} → ${target.channel_id}: ${item.title}`
            );
          } catch (err) {
            errorHandler.handleError(
              err,
              `newsService: отправка ${userId} в ${target.channel_id}`
            );
          }
        });
      }
    }

    // 7. Помечаем все просмотренные записи как «виденные» в БД.
    //    Делаем это ДО того, как очередь отработает — если бот упадёт,
    //    запись не будет считаться непрочитанной. Trade-off в пользу
    //    «лучше пропустить, чем зафлудить».
    if (linksToMark.length > 0) {
      await db.markRssItemsSentBulk(userId, feedUrl, linksToMark);
    }
    await db.touchFeedState(userId, feedUrl);

    if (newCount > 0) {
      rssLogger.debug(
        `📥 ${feedUrl} (user=${userId}): новых=${newCount}, совпало с keywords=${matchedCount}`
      );
    }
  } catch (error) {
    errorHandler.handleError(
      error,
      `newsService: checkFeedForUser ${feedUrl} для пользователя ${userId}`
    );
  }
}

async function checkAllFeeds(bot) {
  rssLogger.info('🔄 Запуск проверки RSS для всех пользователей...');

  // Инициализируем кеш распарсенных лент на время этого цикла
  parseCache = new Map();

  try {
    const systemFeeds = await db.getSystemFeeds();

    const allUsers = await db.listUsers();
    if (allUsers.length === 0) {
      rssLogger.info('ℹ️ Нет пользователей — проверка не требуется');
      return;
    }

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
        rssLogger.debug(`⏭️ Пользователь ${uid} без активной подписки, пропускаем`);
        continue;
      }

      const personalFeeds = userFeedsMap[uid] || [];
      const feedsForUser = [...new Set([...personalFeeds, ...systemFeeds])];

      if (feedsForUser.length === 0) continue;

      processedUsers++;
      for (const feedUrl of feedsForUser) {
        await checkFeedForUser(uid, feedUrl, bot);
        totalChecks++;
      }
    }

    rssLogger.info(
      `📊 Активных пользователей с фидами: ${processedUsers}, ` +
        `всего проверок фидов: ${totalChecks} ` +
        `(системных в наборе: ${systemFeeds.length})`
    );
    rssLogger.info('✅ Проверка RSS завершена');
  } catch (error) {
    errorHandler.handleError(error, 'newsService: checkAllFeeds');
  } finally {
    parseCache = null;
  }
}

async function manualCheck(bot) {
  await checkAllFeeds(bot);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  checkAllFeeds,
  manualCheck
};