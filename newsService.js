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

// Резолвит относительные ссылки в items относительно feedUrl.
// Многие RSS-фиды отдают item.link как "/news/123" вместо полного URL —
// в таком случае ссылка в сообщении будет некликабельной. Приводим к
// абсолютному URL; если не получилось — возвращаем исходное значение.
function resolveItemLink(itemLink, feedUrl) {
  if (!itemLink || typeof itemLink !== 'string') return null;
  if (/^https?:\/\//i.test(itemLink)) return itemLink;
  try {
    return new URL(itemLink, feedUrl).toString();
  } catch {
    return itemLink;
  }
}

// Сортирует items фида по дате (новые первыми).
// Проблема: rss-parser отдаёт items в том порядке, в котором они пришли
// в XML. Большинство фидов сортируют newest-first, но не все. Если фид
// отдаёт oldest-first, мы будем смотреть первые 20 записей (= самые старые)
// и никогда не увидим новые.
// Fallback: если у item нет ни isoDate, ни pubDate — считаем дату 0.
// Array.prototype.sort в Node.js стабилен, поэтому элементы без даты
// сохранят относительный порядок.
function sortItemsByDateDesc(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.isoDate || a.pubDate || '') || 0;
    const tb = Date.parse(b.isoDate || b.pubDate || '') || 0;
    return tb - ta;
  });
}

async function checkFeedForUser(userId, feedUrl, bot, keywords, targets) {
  try {
    // 1. Парсим фид (с кешем на время цикла)
    let feed;
    if (parseCache && parseCache.has(feedUrl)) {
      feed = parseCache.get(feedUrl);
    } else {
      feed = await parser.parseURL(feedUrl);
      if (parseCache) parseCache.set(feedUrl, feed);
    }

    // keywords и targets переданы снаружи (см. checkAllFeeds):
    // они одинаковы для всех фидов пользователя, и мы не хотим делать
    // 2 SQL-запроса на каждый фид. Внутри всё равно проверяем —
    // на случай прямого вызова из будущего кода.
    if (!keywords || keywords.length === 0) return;
    if (!targets || targets.length === 0) return;

    // 2. Проверяем состояние фида (видели ли мы его когда-либо у этого пользователя).
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

    // 3. Сортируем по дате (новые первыми) и берём верхние N записей.
    //    См. sortItemsByDateDesc — защита от oldest-first фидов.
    const items = sortItemsByDateDesc(feed.items).slice(0, ITEMS_PER_FEED);
    if (items.length === 0) return;

    // 4. Первый парсинг непустого фида — сидируем.
    //    Помечаем все текущие записи как «уже виденные» БЕЗ отправки,
    //    чтобы не заваливать пользователя историей канала при добавлении.
    if (!seenBefore) {
      const links = items
        .map((i) => resolveItemLink(i.link, feedUrl))
        .filter(Boolean);
      await db.markRssItemsSentBulk(userId, feedUrl, links);
      await db.initFeedState(userId, feedUrl);
      rssLogger.info(
        `🌱 Фид инициализирован: user=${userId}, feed=${feedUrl}, помечено записей=${links.length} (без отправки)`
      );
      return;
    }

    // 5. Основной проход.
    //    Дедуп по (userId, item_link) глобальный — если та же ссылка
    //    пришла из другого фида (например, эквивалентного YouTube-хендла),
    //    она уже помечена и не отправится повторно.
    let newCount = 0;
    let matchedCount = 0;
    const linksToMark = [];
    const seenInThisCycle = new Set();

    for (const item of items) {
      const itemLink = resolveItemLink(item.link, feedUrl);
      if (!itemLink) continue;

      // Защита от дублей внутри одного фида (маловероятно, но бесплатно)
      if (seenInThisCycle.has(itemLink)) continue;
      seenInThisCycle.add(itemLink);

      // Уже отправляли когда-то?
      const sent = await db.isRssItemSent(userId, itemLink);
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
      linksToMark.push(itemLink);

      if (!matched) continue;
      matchedCount++;

      // Формируем сообщение
      let message = `<b>${escapeHtml(item.title || 'Новость')}</b>\n`;
      if (item.contentSnippet) {
        message += `${escapeHtml(item.contentSnippet.substring(0, 300))}...\n`;
      }
      message += `<a href="${escapeHtml(itemLink)}">Читать далее</a>\n`;

      // Отправляем во все целевые каналы.
      //
      // ВАЖНО: задача НЕ обёрнута в try/catch. Ошибка от sendMessage
      // пробрасывается в queue.js, который сам решает:
      //   - 429 / 5xx → retry с retry_after (до MAX_ATTEMPTS раз)
      //   - 4xx (кроме 429) / прочее → окончательный log в errorHandler
      // Если бы мы ловили ошибку здесь, queue никогда не узнал бы о ней
      // и не сделал retry — сообщение потерялось бы при транзиентной ошибке.
      //
      // Про at-least-once: при retry возможен теоретический дубль (sendMessage
      // прошёл, но Telegram ответил 5xx после доставки). На практике это
      // редкий сценарий, и лучше дубль, чем потеря. Дополнительно:
      // markRssItemsSentBulk вызывается ДО queue (см. шаг 6), поэтому
      // при краше между постановкой в очередь и отправкой — запись
      // не будет повторно отправлена со следующего цикла.
      for (const target of targets) {
        queue.add(
          async () => {
            await bot.telegram.sendMessage(target.channel_id, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: false
            });
            rssLogger.info(
              `📨 Отправлено ${userId} → ${target.channel_id}: ${item.title}`
            );
          },
          {
            context: `newsService: sendMessage → ${target.channel_id} (user=${userId}, item="${item.title || ''}")`
          }
        );
      }
    }

    // 6. Помечаем все просмотренные записи как «виденные» в БД.
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

      // FIX (perf): запрашиваем keywords и targets один раз на пользователя,
      // а не по разу на каждый фид. У активного пользователя легко может
      // быть 5–10 фидов — раньше это давало 10–20 лишних SELECT'ов за цикл.
      const keywords = await db.getKeywords(uid);
      const targets = await db.getTargetChannels(uid);
      if (keywords.length === 0 || targets.length === 0) {
        rssLogger.debug(`⏭️ Пользователь ${uid}: нет keywords или targets, пропускаем`);
        continue;
      }

      const personalFeeds = userFeedsMap[uid] || [];
      const feedsForUser = [...new Set([...personalFeeds, ...systemFeeds])];

      if (feedsForUser.length === 0) continue;

      processedUsers++;
      for (const feedUrl of feedsForUser) {
        await checkFeedForUser(uid, feedUrl, bot, keywords, targets);
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