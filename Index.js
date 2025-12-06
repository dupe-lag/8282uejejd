// Required dependencies - install with:
// npm install telegraf axios cheerio libphonenumber-js
// npm install --save-dev @types/node (if using TypeScript)

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

// Token from env for safety
const TOKEN = process.env.TELEGRAM_TOKEN || "8289958887:AAFrdtHwtDSZyfI77ECJONkAMXkEF0QbQIQ";

// Logging setup
const logger = {
    info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
    debug: (msg) => console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`),
    exception: (msg, error) => console.error(`[EXCEPTION] ${new Date().toISOString()} - ${msg}`, error)
};

const userData = {};

// --- Async wrapper for blocking requests ---
async function fetch(url, headers = null, timeout = 10000) {
    /**
     * Run axios.get to fetch URL content.
     */
    const defaultHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const requestHeaders = headers || defaultHeaders;
    
    try {
        const response = await axios.get(url, {
            headers: requestHeaders,
            timeout: timeout,
            validateStatus: () => true // Don't throw on any status code
        });
        return response;
    } catch (error) {
        logger.debug(`fetch error for ${url}: ${error.message}`);
        throw error;
    }
}

// --- Helper to send text whether update is message or callback_query ---
async function sendText(ctx, text, parseMode = 'Markdown', replyMarkup = null, editIfCallback = true) {
    /**
     * If ctx is from callback query and editIfCallback True -> edit message text.
     * Otherwise send new message to chat.
     */
    try {
        if (ctx.callbackQuery && editIfCallback) {
            // if callback has a message, edit it; otherwise answer with new message
            try {
                await ctx.editMessageText(text, {
                    parse_mode: parseMode,
                    reply_markup: replyMarkup,
                    ...Markup.inlineKeyboard(replyMarkup ? replyMarkup.inline_keyboard : [])
                });
                return;
            } catch (error) {
                // fallback to replying in chat
            }
        }

        if (ctx.message) {
            await ctx.reply(text, {
                parse_mode: parseMode,
                ...Markup.inlineKeyboard(replyMarkup ? replyMarkup.inline_keyboard : [])
            });
        } else if (ctx.callbackQuery && ctx.callbackQuery.message) {
            await ctx.telegram.sendMessage(ctx.callbackQuery.message.chat.id, text, {
                parse_mode: parseMode,
                ...Markup.inlineKeyboard(replyMarkup ? replyMarkup.inline_keyboard : [])
            });
        } else {
            // Last resort: try to answer callback
            if (ctx.callbackQuery) {
                await ctx.answerCbQuery(text);
            }
        }
    } catch (error) {
        logger.error(`sendText failed: ${error.message}`);
    }
}

// --- Handlers ---
async function start(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Поиск по никнейму", 'osint_username')],
        [Markup.button.callback("🌐 Парсинг сайта", 'parse_website')],
        [Markup.button.callback("📡 IP информация", 'ip_info')],
        [Markup.button.callback("📚 Wikipedia поиск", 'wiki_search')],
        [Markup.button.callback("🔎 Поиск телефона", 'phone_lookup')],
        [Markup.button.callback("👤 Парсинг ВК", 'vk_parse')],
        [Markup.button.callback("🆔 ID по username ВК", 'vk_id')],
        [Markup.button.callback("📱 ID Telegram", 'tg_id')],
        [Markup.button.callback("🌐 Полезные сайты", 'useful_sites')],
        [Markup.button.callback("🤖 Полезные боты", 'useful_bots')]
    ]);
    
    const welcomeText = 
        "🕵️ *OSINT Парсинг Бот*\n\n" +
        "Выберите опцию из меню:\n\n" +
        "• *Поиск по никнейму* - поиск аккаунтов по username\n" +
        "• *Парсинг сайта* - извлечение данных с веб-страниц\n" +
        "• *IP информация* - геолокация и информация об IP\n" +
        "• *Wikipedia поиск* - поиск информации в Wikipedia\n" +
        "• *Поиск телефона* - информация о номере телефона\n" +
        "• *Парсинг ВК* - информация о странице ВКонтакте\n" +
        "• *ID по username ВК* - получение ID по username ВК\n" +
        "• *ID Telegram* - получение ID по username Telegram\n" +
        "• *Полезные сайты* - список полезных OSINT-сайтов\n" +
        "• *Полезные боты* - список полезных OSINT-ботов";
    
    await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...keyboard });
}

async function handleQuery(ctx) {
    const query = ctx.callbackQuery;
    if (!query) {
        return;
    }
    await ctx.answerCbQuery();
    const userId = query.from.id;
    
    if (query.data === 'osint_username') {
        userData[userId] = { action: 'osint_username' };
        await ctx.editMessageText("Введите username для поиска:");
    } else if (query.data === 'parse_website') {
        userData[userId] = { action: 'parse_website' };
        await ctx.editMessageText("Введите URL сайта для парсинга:");
    } else if (query.data === 'ip_info') {
        userData[userId] = { action: 'ip_info' };
        await ctx.editMessageText("Введите IP адрес для проверки:");
    } else if (query.data === 'wiki_search') {
        userData[userId] = { action: 'wiki_search' };
        await ctx.editMessageText("Введите запрос для поиска в Wikipedia:");
    } else if (query.data === 'phone_lookup') {
        userData[userId] = { action: 'phone_lookup' };
        await ctx.editMessageText("Введите номер телефона (с кодом страны):");
    } else if (query.data === 'vk_parse') {
        userData[userId] = { action: 'vk_parse' };
        await ctx.editMessageText("Введите username или ID страницы ВКонтакте:");
    } else if (query.data === 'vk_id') {
        userData[userId] = { action: 'vk_id' };
        await ctx.editMessageText("Введите username ВКонтакте для получения ID:");
    } else if (query.data === 'tg_id') {
        userData[userId] = { action: 'tg_id' };
        await ctx.editMessageText("Введите username Telegram (без @):");
    } else if (query.data === 'useful_sites') {
        await usefulSites(ctx);
    } else if (query.data === 'useful_bots') {
        await usefulBots(ctx);
    } else if (query.data === 'back_to_menu') {
        await showMainMenu(ctx);
    }
}

async function showMainMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Поиск по никнейму", 'osint_username')],
        [Markup.button.callback("🌐 Парсинг сайта", 'parse_website')],
        [Markup.button.callback("📡 IP информация", 'ip_info')],
        [Markup.button.callback("📚 Wikipedia поиск", 'wiki_search')],
        [Markup.button.callback("🔎 Поиск телефона", 'phone_lookup')],
        [Markup.button.callback("👤 Парсинг ВК", 'vk_parse')],
        [Markup.button.callback("🆔 ID по username ВК", 'vk_id')],
        [Markup.button.callback("📱 ID Telegram", 'tg_id')],
        [Markup.button.callback("🌐 Полезные сайты", 'useful_sites')],
        [Markup.button.callback("🤖 Полезные боты", 'useful_bots')]
    ]);
    
    if (ctx.callbackQuery) {
        await ctx.editMessageText("🕵️ Выберите действие:", keyboard);
    } else {
        await ctx.reply("🕵️ Выберите действие:", keyboard);
    }
}

async function handleMessage(ctx) {
    if (!ctx.message) {
        return;
    }
    const userId = ctx.message.from.id;
    const text = ctx.message.text.trim();
    
    if (!userData[userId]) {
        await ctx.reply("Пожалуйста, выберите действие из меню.");
        return;
    }
    
    const action = userData[userId].action;
    
    try {
        if (action === 'osint_username') {
            await usernameSearch(ctx, text);
        } else if (action === 'parse_website') {
            await websiteParse(ctx, text);
        } else if (action === 'ip_info') {
            await ipInfo(ctx, text);
        } else if (action === 'wiki_search') {
            await wikiSearch(ctx, text);
        } else if (action === 'phone_lookup') {
            await phoneLookup(ctx, text);
        } else if (action === 'vk_parse') {
            await vkParse(ctx, text);
        } else if (action === 'vk_id') {
            await vkGetId(ctx, text);
        } else if (action === 'tg_id') {
            await tgGetId(ctx, text);
        }
    } finally {
        // clear state no matter what to avoid stuck
        delete userData[userId];
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад в меню", 'back_to_menu')]
    ]);
    await ctx.reply("Выберите дальнейшее действие:", keyboard);
}

// --- Feature implementations (use async fetch) ---
async function usernameSearch(ctx, username) {
    try {
        const platforms = {
            "GitHub": `https://github.com/${username}`,
            "Twitter": `https://twitter.com/${username}`,
            "Instagram": `https://instagram.com/${username}`,
            "Reddit": `https://reddit.com/user/${username}`,
            "Steam": `https://steamcommunity.com/id/${username}`,
            "Vk": `https://vk.com/${username}`,
            "Facebook": `https://facebook.com/${username}`,
            "LinkedIn": `https://linkedin.com/in/${username}`,
            "Pinterest": `https://pinterest.com/${username}`,
            "SoundCloud": `https://soundcloud.com/${username}`,
            "Telegram": `https://t.me/${username}`,
            "YouTube": `https://youtube.com/@${username}`,
            "Twitch": `https://twitch.tv/${username}`,
            "TikTok": `https://tiktok.com/@${username}`,
            "Spotify": `https://www.google.com/search?q=spotify+user+${username}`,
            "Medium": `https://medium.com/@${username}`
        };
        
        const results = [];
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        
        for (const [platform, url] of Object.entries(platforms)) {
            try {
                const resp = await fetch(url, headers);
                const text = resp.data.toLowerCase();
                // basic existence checks
                if (resp.status === 200) {
                    if (platform === "Instagram") {
                        if (!text.includes("sorry, this page isn't available.")) {
                            results.push(`✅ ${platform}: ${url}`);
                        } else {
                            results.push(`❌ ${platform}: не найден`);
                        }
                    } else if (platform === "Twitter") {
                        if (!text.includes("страница не найдена") && !text.includes("account suspended")) {
                            results.push(`✅ ${platform}: ${url}`);
                        } else {
                            results.push(`❌ ${platform}: не найден`);
                        }
                    } else {
                        results.push(`✅ ${platform}: ${url}`);
                    }
                } else {
                    results.push(`❌ ${platform}: не найден`);
                }
            } catch (error) {
                results.push(`❌ ${platform}: ошибка проверки`);
            }
        }
        
        const resultText = `🔍 *Результаты поиска для ${username}:*\n\n` + results.join("\n");
        await sendText(ctx, resultText);
    } catch (error) {
        logger.exception("Error in username_search", error);
        await sendText(ctx, `❌ Ошибка при поиске: ${error.message}`);
    }
}

async function websiteParse(ctx, url) {
    try {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        const resp = await fetch(url, headers);
        
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const $ = cheerio.load(resp.data);
        
        const title = $('title').text() || "Не найдено";
        const metaDesc = $('meta[name="description"]');
        const description = metaDesc.attr('content') || "Нет описания";
        
        const links = $('a[href]');
        const externalLinks = [];
        links.each((i, elem) => {
            const href = $(elem).attr('href');
            if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                externalLinks.push(href);
            }
        });
        
        const resultText = 
            `🌐 *Результаты парсинга:* ${url}\n\n` +
            `📝 *Заголовок:* ${title}\n\n` +
            `📄 *Описание:* ${description}\n\n` +
            `🔗 *Найдено ссылок:* ${links.length}\n` +
            `🌍 *Внешних ссылок:* ${externalLinks.length}`;
        
        await sendText(ctx, resultText);
    } catch (error) {
        await sendText(ctx, `❌ Ошибка при доступе к сайту: ${error.message}`);
    }
}

async function ipInfo(ctx, ip) {
    try {
        // Validate IP address
        if (!net.isIP(ip)) {
            await sendText(ctx, "❌ Неверный формат IP адреса");
            return;
        }
        
        const whoisUrl = `https://www.whois.com/whois/${ip}`;
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        
        try {
            const resp = await fetch(whoisUrl, headers);
            
            if (resp.status < 200 || resp.status >= 300) {
                throw new Error(`HTTP ${resp.status}`);
            }
            
            const $ = cheerio.load(resp.data);
            const whoisData = $('pre.df-raw');
            
            if (whoisData.length > 0) {
                let whoisText = whoisData.text();
                if (whoisText.length > 500) {
                    whoisText = whoisText.substring(0, 500) + "...";
                }
                const resultText = `📡 *Информация об IP:* ${ip}\n\n\`\`\`\n${whoisText}\n\`\`\``;
                await sendText(ctx, resultText);
            } else {
                const resultText = `📡 *Информация об IP:* ${ip}\n\nНе удалось получить информацию через WHOIS`;
                await sendText(ctx, resultText);
            }
        } catch (error) {
            await sendText(ctx, "❌ Не удалось получить информацию об IP");
        }
    } catch (error) {
        logger.exception("Error in ip_info", error);
        await sendText(ctx, `❌ Ошибка: ${error.message}`);
    }
}

async function wikiSearch(ctx, query) {
    try {
        const searchUrl = `https://ru.wikipedia.org/wiki/${encodeURIComponent(query)}`;
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        const resp = await fetch(searchUrl, headers);
        
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const $ = cheerio.load(resp.data);
        
        if ($('div#noarticletext').length > 0) {
            await sendText(ctx, "❌ Статья не найдена в Wikipedia");
            return;
        }
        
        const title = $('h1#firstHeading');
        const pageTitle = title.text() || query;
        
        const content = $('div#mw-content-text');
        let summary = "Не удалось извлечь содержание статьи";
        
        if (content.length > 0) {
            // get first non-empty paragraph
            let firstPara = null;
            content.find('> p').each((i, elem) => {
                const text = $(elem).text().trim();
                if (text && !firstPara) {
                    firstPara = text;
                    return false; // break
                }
            });
            
            if (firstPara) {
                summary = firstPara.length > 1000 ? firstPara.substring(0, 1000) + "..." : firstPara;
            }
        }
        
        const resultText = 
            `📚 *Wikipedia: ${pageTitle}*\n\n` +
            `${summary}\n\n` +
            `🔗 *Ссылка:* ${searchUrl}`;
        
        await sendText(ctx, resultText);
    } catch (error) {
        logger.exception("Error in wiki_search", error);
        await sendText(ctx, `❌ Ошибка при поиске в Wikipedia: ${error.message}`);
    }
}

async function phoneLookup(ctx, phoneNumber) {
    try {
        const parsedNumber = parsePhoneNumber(phoneNumber);
        
        if (!parsedNumber || !parsedNumber.isValid()) {
            await sendText(ctx, "❌ Неверный формат номера телефона");
            return;
        }
        
        // Get carrier name (libphonenumber-js doesn't have carrier/timezone data by default)
        const carrierName = "Неизвестно"; // libphonenumber-js doesn't provide carrier info
        const region = parsedNumber.country || "Неизвестно";
        const timeZones = "Неизвестно"; // libphonenumber-js doesn't provide timezone info by default
        
        const resultText = 
            `📞 *Информация о номере:* ${phoneNumber}\n\n` +
            `📱 *Оператор:* ${carrierName}\n` +
            `🌍 *Регион:* ${region}\n` +
            `🕐 *Часовой пояс:* ${timeZones}\n` +
            `✅ *Валидность:* ${parsedNumber.isValid() ? 'Да' : 'Нет'}\n` +
            `🌐 *Возможный номер:* ${parsedNumber.isPossible() ? 'Да' : 'Нет'}`;
        
        await sendText(ctx, resultText);
    } catch (error) {
        logger.exception("Error in phone_lookup", error);
        await sendText(ctx, `❌ Ошибка при проверке номера: ${error.message}`);
    }
}

// get_vk_id uses fetch; made synchronous-style but async function
async function getVkId(username) {
    try {
        const url = `https://vk.com/${username}`;
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        const resp = await fetch(url, headers);
        
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const text = resp.data;
        
        let idMatch = text.match(/"uid":(\d+)/);
        if (idMatch) {
            return idMatch[1];
        }
        
        idMatch = text.match(/"id":(\d+)/);
        if (idMatch) {
            return idMatch[1];
        }
        
        idMatch = text.match(/https:\/\/vk\.com\/id(\d+)/);
        if (idMatch) {
            return idMatch[1];
        }
        
        return null;
    } catch (error) {
        logger.exception("Error in get_vk_id", error);
        return null;
    }
}

async function vkParse(ctx, username) {
    try {
        const userId = await getVkId(username);
        if (!userId) {
            await sendText(ctx, "❌ Пользователь ВКонтакте не найден");
            return;
        }
        
        const url = `https://vk.com/${username}`;
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        const resp = await fetch(url, headers);
        
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const text = resp.data;
        const $ = cheerio.load(text);
        
        const title = $('title');
        let profileName = "Неизвестно";
        if (title.length > 0) {
            const titleText = title.text();
            const parts = titleText.split('|');
            if (parts.length > 0) {
                profileName = parts[0].trim();
            }
        }
        
        let followersText = "Неизвестно";
        const followersMatch = text.match(/(\d+)\s*подписчик/);
        if (followersMatch) {
            followersText = followersMatch[1];
        }
        
        let friendsText = "Неизвестно";
        const friendsMatch = text.match(/(\d+)\s*друг/);
        if (friendsMatch) {
            friendsText = friendsMatch[1];
        }
        
        let photosText = "Неизвестно";
        const photosMatch = text.match(/(\d+)\s*фотографi/i) || text.match(/(\d+)\s*фотограф/i);
        if (photosMatch) {
            photosText = photosMatch[1];
        }
        
        const resultText = 
            `👤 *Информация о странице ВКонтакте:*\n\n` +
            `📛 *Имя:* ${profileName}\n` +
            `🆔 *ID:* ${userId}\n` +
            `👥 *Подписчики:* ${followersText}\n` +
            `🤝 *Друзья:* ${friendsText}\n` +
            `📸 *Фотографии:* ${photosText}\n` +
            `🔗 *Ссылка:* ${url}`;
        
        await sendText(ctx, resultText);
    } catch (error) {
        logger.exception("Error in vk_parse", error);
        await sendText(ctx, `❌ Ошибка при парсинге ВК: ${error.message}`);
    }
}

async function vkGetId(ctx, username) {
    try {
        const userId = await getVkId(username);
        if (userId) {
            const resultText = 
                `👤 *ВКонтакте ID:*\n\n` +
                `📛 *Username:* ${username}\n` +
                `🆔 *ID:* ${userId}\n` +
                `🔗 *Ссылка:* https://vk.com/id${userId}`;
            
            await sendText(ctx, resultText);
        } else {
            await sendText(ctx, "❌ Пользователь ВКонтакте не найден");
        }
    } catch (error) {
        logger.exception("Error in vk_get_id", error);
        await sendText(ctx, `❌ Ошибка при получении ID: ${error.message}`);
    }
}

async function tgGetId(ctx, username) {
    try {
        const url = `https://t.me/${username}`;
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        const resp = await fetch(url, headers);
        
        if (resp.status === 200) {
            const $ = cheerio.load(resp.data);
            
            let profileName = "Неизвестно";
            const title = $('title');
            if (title.length > 0) {
                profileName = title.text()
                    .replace('Telegram: Contact ', '')
                    .replace('Telegram: Join ', '')
                    .trim();
            }
            
            let description = "Не найдено";
            const descElem = $('div.tgme_page_description');
            if (descElem.length > 0) {
                description = descElem.text().trim();
            }
            
            let membersText = "Неизвестно";
            const membersElem = $('div.tgme_page_extra');
            if (membersElem.length > 0) {
                membersText = membersElem.text().trim();
            }
            
            const resultText = 
                `👤 *Информация о профиле Telegram:*\n\n` +
                `📛 *Имя:* ${profileName}\n` +
                `🔗 *Username:* @${username}\n` +
                `📝 *Описание:* ${description}\n` +
                `👥 *Подписчики/Участники:* ${membersText}\n` +
                `🌐 *Ссылка:* ${url}`;
            
            await sendText(ctx, resultText);
        } else {
            await sendText(ctx, "❌ Пользователь Telegram не найден");
        }
    } catch (error) {
        logger.exception("Error in tg_get_id", error);
        await sendText(ctx, `❌ Ошибка при получении информации: ${error.message}`);
    }
}

async function usefulSites(ctx) {
    try {
        const sitesText = 
            "🌐 *Полезные OSINT-сайты:*\n\n" +
            "• *Whois Lookup* - https://whois.domaintools.com\n" +
            "• *IP Lookup* - https://ipinfo.io\n" +
            "• *Email Checker* - https://verify-email.org\n" +
            "• *Social Media Search* - https://social-searcher.com\n" +
            "• *Username Search* - https://whatsmyname.app\n" +
            "• *Image Reverse Search* - https://images.google.com\n" +
            "• *Archive.org* - https://archive.org\n" +
            "• *Phone Lookup* - https://truecaller.com\n" +
            "• *Domain Search* - https://builtwith.com\n" +
            "• *Data Breach Check* - https://haveibeenpwned.com\n" +
            "• *Metadata Analysis* - https://exifdata.com\n" +
            "• *Password Leaks* - https://dehashed.com\n" +
            "• *VPN/Proxy Detection* - https://ipqualityscore.com\n" +
            "• *Website History* - https://archive.ph\n" +
            "• *DNS Lookup* - https://dnsdumpster.com";
        
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад в меню", 'back_to_menu')]
        ]);
        await sendText(ctx, sitesText, 'Markdown', keyboard);
    } catch (error) {
        logger.exception("Error in useful_sites", error);
        await sendText(ctx, `❌ Ошибка: ${error.message}`);
    }
}

async function usefulBots(ctx) {
    try {
        const botsText = 
            "🤖 *Полезные OSINT-боты:*\n\n" +
            "• @SangMataInfo_bot - история изменений профиля\n" +
            "• @tgscanbot - анализ Telegram-аккаунтов\n" +
            "• @myipbot - информация об IP-адресе\n" +
            "• @WhoisBot - WHOIS информация о доменах\n" +
            "• @SpamBot - проверка на спам-аккаунты\n" +
            "• @ImageSearchBot - обратный поиск изображений\n" +
            "• @VK_Bot - поиск по ВКонтакте\n" +
            "• @GitHubBot - поиск по GitHub\n" +
            "• @YouTubeBot - поиск по YouTube\n" +
            "• @TwitterBot - поиск по Twitter\n" +
            "• @InstagramBot - поиск по Instagram\n" +
            "• @RedditBot - поиск по Reddit\n" +
            "• @PhoneInfoBot - информация о номерах\n" +
            "• @EmailVerifierBot - проверка email\n" +
            "• @DomainToolsBot - инструменты для доменов\n" +
            "• @VKHistoryRobot история профиля вк\n" +
            "• @osint_maigret_bot поиск по нику";
        
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад в меню", 'back_to_menu')]
        ]);
        await sendText(ctx, botsText, 'Markdown', keyboard);
    } catch (error) {
        logger.exception("Error in useful_bots", error);
        await sendText(ctx, `❌ Ошибка: ${error.message}`);
    }
}

async function errorHandler(error, ctx) {
    logger.error(`Exception while handling an update: ${error.message}`);
    console.error(error);
    
    try {
        if (ctx && ctx.message) {
            await ctx.reply("❌ Произошла ошибка при обработке запроса");
        } else if (ctx && ctx.callbackQuery && ctx.callbackQuery.message) {
            await ctx.telegram.sendMessage(
                ctx.callbackQuery.message.chat.id,
                "❌ Произошла ошибка при обработке запроса"
            );
        }
    } catch (e) {
        logger.error(`Error in error handler: ${e.message}`);
    }
}

// --- Main Bot Setup ---
const bot = new Telegraf(TOKEN);

// Command handlers
bot.start(start);
bot.command('start', start);

// Callback query handler
bot.on('callback_query', handleQuery);

// Message handler
bot.on('text', handleMessage);

// Error handler
bot.catch(errorHandler);

// Start the bot
bot.launch().then(() => {
    logger.info('Bot started successfully');
}).catch((error) => {
    logger.error(`Failed to start bot: ${error.message}`);
});

// Enable graceful stop
process.once('SIGINT', () => {
    logger.info('Stopping bot (SIGINT)');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    logger.info('Stopping bot (SIGTERM)');
    bot.stop('SIGTERM');
});

module.exports = bot;
