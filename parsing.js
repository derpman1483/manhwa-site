// --- START OF FILE parsing.js ---

const axios = require('axios');
const { JSDOM } = require('jsdom');
const { parse } = require('path');
const stringSimilarity = require('string-similarity');
const { URL } = require('url');
const {logger} = require('./utils');
const DEFAULT_AXIOS_CONFIG = {
    timeout: 15000,
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

let globalErrs = 0;
let globalErrList = [];

function getErrorStats() {
    return { errs: globalErrs, errList: globalErrList };
}

async function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

async function fetchWithRetry(url, config = {}, retries = 3) {
    let lastError;
    const baseDelay = 3000;
    
    for (let i = 0; i < retries; i++) {
        try {
            if (i > 0) {
                const delay = baseDelay * Math.pow(2, i);
                logger.log(`Retrying fetch for ${url} in ${delay / 1000} seconds... (Attempt ${i + 1}/${retries})`);
                await sleep(delay / 1000);
            }

            const response = await axios.get(url, { ...DEFAULT_AXIOS_CONFIG, ...config });
            return response;
        } catch (error) {
            lastError = error;
        }
    }
    
    throw lastError;
}

async function saveInfo(info, dbConnection) {
    const genresJson = info.genres ? JSON.stringify(info.genres) : '[]';
    const coverImageUrl = info.cover_image_url || 'N/A';

    await dbConnection.run(`
        INSERT INTO titles (title, url, author, updated, cover_image_url, genres)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(title) DO UPDATE SET
            url=excluded.url,
            author=excluded.author,
            updated=excluded.updated,
            cover_image_url=excluded.cover_image_url,
            genres=excluded.genres
    `, [info.title, info.url, info.author, info.updated, coverImageUrl, genresJson]);

    const row = await dbConnection.get('SELECT id FROM titles WHERE title = ?', info.title);
    let titleId = row ? row.id : null;

    if (!titleId) {
        logger.error(`Could not retrieve ID for title: ${info.title}`, "parsing");
        return;
    }

    for (const alt of info.alternatives) {
        if (alt) {
            await dbConnection.run(`
                INSERT INTO alternatives (alt_title, title_id)
                VALUES (?, ?)
                ON CONFLICT(alt_title) DO NOTHING;
            `, [alt, titleId]);
        }
    }
    logger.log(`Saved/Updated: ${info.title} (ID: ${titleId}) in ${dbConnection.config.filename}`, "parsing");
}

// --- Shojo (KingOfShojo) Parsing Functions ---

async function parseALLShojo(urls, dbConnection) {
    const MAX_CONCURRENT = 40;
    const allResults = [];

    for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
        const batchUrls = urls.slice(i, i + MAX_CONCURRENT);
        const promises = batchUrls.map((url) => {
            const config = { headers: { 'Referer': 'https://kingofshojo.com/' } };
            return fetchWithRetry(url, config)
                .then(response => ({ status: 'fulfilled', value: { data: response.data, config: { url } } }))
                .catch(error => ({ status: 'rejected', reason: { message: error.message, config: { url } } }));
        });
        const results = await Promise.allSettled(promises);
        allResults.push(...results);
        await sleep(1);
    }

    for (const result of allResults) {
        if (result.status === 'fulfilled') {
            const html = result.value.value.data;
            const url = result.value.value.config.url;
            const dom = new JSDOM(html);
            const document = dom.window.document;

            const table = document.getElementsByClassName("infotable")[0];
            const titleElement = document.getElementsByClassName("entry-title")[0];

            if (!table || !titleElement || !url) {
                logger.error("Missing critical data for URL:", url || 'Unknown URL');
                continue;
            }

            const title = titleElement.textContent.trim();
            let info = { title, url, alternatives: [], genres: [], cover_image_url: 'N/A' }; 

            try {
                info.author = table.rows[4]?.cells[1]?.textContent.trim() || 'N/A';
                const alternativesText = table.rows[0]?.cells[1]?.textContent.trim();
                info.alternatives = alternativesText ? alternativesText.split(",").map(s => s.trim()).filter(s => s) : [];

                const genresContainer = document.querySelector('.seriestugenre, .manga-tags, .seriestumeta .genres');
                if (genresContainer) {
                    info.genres = Array.from(genresContainer.querySelectorAll('a, span'))
                        .map(el => el.textContent.trim())
                        .filter(text => text);
                } else {
                    info.genres = [];
                }

                const dateElement = table.rows[8]?.cells[1]?.querySelector('time');
                const date = dateElement ? dateElement.getAttribute('datetime') : 'N/A';
                
                info.updated = date;
                info.cover_image_url = document.querySelector('.thumb')?.children[0]?.getAttribute('src');
            } catch (e) {
                logger.error(`Error parsing table data for: ${title} (${url}). ${e.message}`, "parsing");
                continue;
            }
            await saveInfo(info, dbConnection);
        } else {
            const url = result.reason?.reason?.config?.url || 'Unknown URL';
            const message = result.reason?.reason?.message || 'Unknown Reason';
            globalErrs++;
            globalErrList.push(url);
            logger.error(`Error fetching URL: ${url}. Reason: ${message}`, "parsing");
        }
    }
}

async function parseShojo(html, dbConnection) {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const items = document.querySelectorAll("div.bs.styletere.stylefiv");
    let urls = [];
    for (const item of items) {
        const url = item.querySelector("a")?.href;
        if (url) {
            urls.push(url);
        }
    }
    if (urls.length > 0) {
        logger.log(`Found ${urls.length} Shojo detail URLs.`, "parsing");
        await parseALLShojo(urls, dbConnection);
    } else {
        logger.log("No Shojo URLs found on this page.", "parsing");
    }
}

async function fetchShojoPage(num, dbConnection) {
    const url = `https://kingofshojo.com/page/${num}/`;
    logger.log(`\nFetching Shojo Page: ${url}`, "parsing");
    try {
        const response = await fetchWithRetry(url);
        await parseShojo(response.data, dbConnection);
    } catch (error) {
        logger.error(`Error fetching Shojo page ${num}: ${error.message}`, "parsing");
    }
}

async function fetchShojo(dbConnection) {
    const MAX_PAGES = 98;
    for (let i = 1; i <= MAX_PAGES; i++) {
        await fetchShojoPage(i, dbConnection);
        await sleep(5)
    }
    logger.log("\nShojo fetching routine complete.", "parsing");
}

// --- ToonGod (Manhwa18) Parsing Functions ---

function parseToonGodDetail(html, url, titleFromListing = null) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    let title = titleFromListing || 'Unknown';
    
    if (!titleFromListing || title === 'Unknown') {
        let titleEl = document.getElementsByClassName('series-name')[0]?.children[0];
        if (titleEl) {
            title = titleEl.textContent.trim(); 
        } else {
            const headerLink = document.querySelector('.series-title a[title]');
            if (headerLink) title = headerLink.getAttribute('title').trim();
        }
    }
    
    let cover_image_url = 'N/A';
    
    const bgDiv = document.getElementsByClassName('img-in-ratio')[0];
    if (bgDiv) {
        let bgUrl = bgDiv.getAttribute('style') || 'N/A';
        if (bgUrl && bgUrl.includes('url(')) {
            const urlMatch = bgUrl.match(/url\(['"]?([^'")]+)['"]?\)/);
            bgUrl = urlMatch ? urlMatch[1] : bgUrl;
        }
        if (bgUrl && bgUrl !== 'N/A') {
            cover_image_url = bgUrl;
        }
    }
    
    if (cover_image_url === 'N/A' || !cover_image_url) {
        const coverImg = document.querySelector('.series-cover img, .thumb img, .poster img, img[itemprop="image"]');
        if (coverImg) {
            cover_image_url = coverImg.getAttribute('src') || 
                             coverImg.getAttribute('data-src') || 
                             coverImg.getAttribute('data-lazy-src') || 
                             coverImg.getAttribute('data-original') || 'N/A';
        }
    }
    
    if (cover_image_url && cover_image_url !== 'N/A' && !cover_image_url.startsWith('http')) {
        cover_image_url = new URL(cover_image_url, 'https://manhwa18.net/').href;
    }
    
    let author = 'N/A';
    const authorEl = document.querySelector('[itemprop="author"] a, .author-content a, .author a, .creator a, [data-author] a');
    if (authorEl) {
        author = authorEl.textContent.trim();
    }
    
    let genres = [];
    const genreLinks = document.querySelectorAll('.genres-content a, .series-genres a, .item-genres a, a[href*="/genre/"]');
    genreLinks.forEach(link => {
        const genre = link.textContent.trim();
        if (genre && genre.length > 0 && genre.length < 50) {
            genres.push(genre);
        }
    });

    let updated = new Date().toISOString().split('T')[0];
    const updatedEl = document.querySelector('.time-since, .updated, [data-time], .update-date, .last-update, .chapter-time');
    if (updatedEl) {
        const timeAttr = updatedEl.querySelector('time')?.getAttribute('datetime');
        if (timeAttr) {
            updated = timeAttr;
        } else {
            updated = updatedEl.textContent.trim();
        }
    }
    
    if (title === 'Unknown') {
        logger.warn(`Warning: Could not parse title from ${url}`, "parsing");
    }
    
    return {
        title,
        url,
        cover_image_url,
        author,
        genres: [...new Set(genres)],
        updated,
        alternatives: []
    };
}

async function parseALLToonGod(urls, dbConnection, titleMap = {}) {
    const MAX_CONCURRENT = 40;
    const allResults = [];

    for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
        const batch = urls.slice(i, i + MAX_CONCURRENT);
        const promises = batch.map(url => {
            const config = { headers: { 'Referer': url.split('/').slice(0, 3).join('/') } };
            
            return fetchWithRetry(url, config)
                .then(response => ({ data: response.data, url }))
                .catch(err => ({ error: err.message, url }));
        });

        const results = await Promise.all(promises);
        for (const result of results) {
            if (result.error) {
                globalErrs++;
                globalErrList.push(result.url);
                logger.error(`Error fetching ${result.url}: ${result.error}`, "parsing");
                continue;
            }

            try {
                const info = parseToonGodDetail(result.data, result.url, titleMap[result.url]);
                allResults.push(info);
                await saveInfo(info, dbConnection);
            } catch (err) {
                globalErrs++;
                globalErrList.push(result.url);
                logger.error(`Error parsing ${result.url}: ${err.message}`, "parsing");
            }
        }
        await sleep(1);
    }

    logger.log(`Processed ${allResults.length} ToonGod titles`, "parsing");
    return allResults;
}

async function parseToonGod(html, dbConnection) {
    const listingTitles = await parseToonGodListingPage(html, 1);
    const titleMap = {};
    listingTitles.forEach(t => {
        titleMap[t.url] = t.title;
    });

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const items = document.querySelectorAll('.thumb-item-flow');
    let urls = [];
    for (const item of items) {
        const link = item.querySelector('a[href*="/manga/"]');
        if (link && link.href && link.href.includes('/manga/')) {
            const fullUrl = link.href.startsWith('http') ? link.href : new URL(link.href, 'https://manhwa18.net/').href;
            urls.push(fullUrl);
        }
    }
    if (urls.length > 0) {
        logger.log(`Found ${urls.length} ToonGod detail URLs.`, "parsing");
        await parseALLToonGod(urls, dbConnection, titleMap);
    } else {
        logger.log("No ToonGod URLs found on this page.", "parsing");
    }
}

async function fetchToonGodPage(num, dbConnection) {
    const url = `https://manhwa18.net/genre/adult?sort=update&page=${num}`; 
    logger.log(`\nFetching ToonGod List Page: ${url}`, "parsing");
    
    const config = { headers: { 'Referer': 'https://manhwa18.net/' } };
    
    try {
        const response = await fetchWithRetry(url, config);
        await parseToonGod(response.data, dbConnection);
    } catch (error) {
        logger.error(`Error fetching ToonGod list page ${num}: ${error.message}`, "parsing");
    }
}

async function fetchToonGod(dbConnection) {
    const MAX_PAGES = 62;
    for (let i = 1; i <= MAX_PAGES; i++) {
        await fetchToonGodPage(i, dbConnection);
        await sleep(5)
    }
    logger.log("\nToonGod fetching routine complete.", "parsing");
}

// --- MangaKakalot (Manga) Parsing Functions ---

function parseMangaDetail(html, url, titleFromListing = null) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const infoEl = document.getElementsByClassName('manga-info-text')[0];
    let title = titleFromListing || 'Unknown';
    if (title === 'Unknown' && infoEl) {
        const titleEl = infoEl.children[0]?.children[0];
        if (titleEl) {
            title = titleEl.textContent.trim();
        }
    }
    
    let info = { title, url, alternatives: [], genres: [], cover_image_url: 'N/A', author: 'N/A', updated: new Date().toISOString().split('T')[0] };
    
    try {
        const coverImgEl = document.getElementsByClassName('manga-info-pic')[0].children[0];
        info.cover_image_url = coverImgEl?.getAttribute('src') || coverImgEl?.getAttribute('data-src') || 'N/A';
        if (info.cover_image_url && !info.cover_image_url.startsWith('http')) {
            info.cover_image_url = new URL(info.cover_image_url, 'https://www.mangakakalot.gg/').href;
        }
        if (infoEl) {
            const author = infoEl.children[1]?.textContent.replace('Author(s) : ', '').trim() || 'N/A';
            const altNamesText = infoEl.children[0]?.children[1]?.textContent;
            const altNames = altNamesText ? altNamesText.replace('Alternative : ', '').trim().split(';').map(s => s.trim()).filter(s => s) : [];
            info.author = author;
            info.alternatives = altNames;

            const genreLinks = infoEl.children[6]?.querySelectorAll('a');
            info.genres = Array.from(genreLinks || []).map(a => a.textContent.trim()).filter(g => g.length > 0 && g.length < 50);

            const updatedEl = infoEl.children[3]?.textContent.replace('Last updated : ', '').trim();
            info.updated = updatedEl || info.updated;
        }

    } catch (e) {
        logger.error(`Error parsing MangaKakalot detail data for: ${title} (${url}). ${e.message}`, "parsing");
    }
    
    return info;
}

async function parseALLManga(urls, dbConnection, titleMap = {}) {
    const MAX_CONCURRENT = 40;
    const allResults = [];

    for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
        const batchUrls = urls.slice(i, i + MAX_CONCURRENT);
        const promises = batchUrls.map((url) => {
            const config = { headers: { 'Referer': 'https://www.mangakakalot.gg/' } };
            return fetchWithRetry(url, config)
                .then(response => ({ status: 'fulfilled', value: { data: response.data, config: { url } } }))
                .catch(error => ({ status: 'rejected', reason: { message: error.message, config: { url } } }));
        });
        const results = await Promise.allSettled(promises);
        allResults.push(...results);
        await sleep(1); 
    }

    for (const result of allResults) {
        if (result.status === 'fulfilled') {
            const html = result.value.value.data;
            const url = result.value.value.config.url;
            
            try {
                const info = parseMangaDetail(html, url, titleMap[url]);
                await saveInfo(info, dbConnection);
            } catch (e) {
                globalErrs++;
                globalErrList.push(url);
                logger.error(`Error parsing MangaKakalot detail page: ${url}. ${e.message}`, "parsing");
            }

        } else {
            const url = result.reason?.reason?.config?.url || 'Unknown URL';
            const message = result.reason?.reason?.message || 'Unknown Reason';
            globalErrs++;
            globalErrList.push(url);
            logger.error(`Error fetching URL: ${url}. Reason: ${message}`, "parsing");
        }
    }
}


async function parseManga(html, dbConnection) {
    const listingTitles = await parseMangaListingPage(html, 1);
    const titleMap = {};
    listingTitles.forEach(t => {
        titleMap[t.url] = t.title; 
    });

    const dom = new JSDOM(html);
    const document = dom.window.document;

    const items = document.getElementsByClassName('list-comic-item-wrap');
    let urls = [];
    for (const item of items) {
        const link = item.children[0];
        if (link && link.href) {
            const url = link.href.startsWith('http') ? link.href : new URL(link.href, 'https://www.mangakakalot.gg/').href;
            urls.push(url);
        }
    }
    if (urls.length > 0) {
        logger.log(`Found ${urls.length} MangaKakalot detail URLs.`, "parsing");
        await parseALLManga(urls, dbConnection, titleMap);
    } else {
        logger.log("No MangaKakalot URLs found on this page.", "parsing");
    }
}

async function fetchMangaPage(num, dbConnection) {
    const url = `https://www.mangakakalot.gg/manga-list/latest-manga?page=${num}`;
    logger.log(`\nFetching MangaKakalot Page: ${url}`, "parsing");
    
    const config = { headers: { 'Referer': 'https://www.mangakakalot.gg/' } };
    
    try {
        const response = await fetchWithRetry(url, config);
        await parseManga(response.data, dbConnection);
    } catch (error) {
        logger.error(`Error fetching MangaKakalot page ${num}: ${error.message}`, "parsing");
    }
}

async function fetchManga(dbConnection) {
    const MAX_PAGES = await (async () => {
        try {
            const response = await fetchWithRetry('https://www.mangakakalot.gg/manga-list/latest-manga?page=1');
            const dom = new JSDOM(response.data);
            const document = dom.window.document;
            const lastPageLink = document.getElementsByClassName('page_last')[0];
            if (lastPageLink) {
                const url = new URL(lastPageLink.href);
                return parseInt(url.searchParams.get('page')) || 1;
            }
            return 1;
        } catch (error) {
            logger.error(`Error fetching max pages: ${error.message}`, "parsing");
            return 1;
        }
    })();
    console.log(`MangaKakalot Max Pages: ${MAX_PAGES}`);
    const startPage = 1;
    for (let i = startPage; i <= MAX_PAGES; i++) {
        await fetchMangaPage(i, dbConnection);
        await sleep(5)
    }
    logger.log("\nMangaKakalot fetching routine complete.", "parsing");
}

// --- Listing Page Parsers (For API Routes) ---

async function parseShojoListingPage(html, pageNum) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const items = document.querySelectorAll("div.bs.styletere.stylefiv");
    const results = [];

    for (const item of items) {
        try {
            const link = item.querySelector("a");
            const url = link?.href;
            let title = 'Unknown Title';
            try {
                const titleElement = item.querySelector(".tt, .series-title, .title");
                title = titleElement?.textContent?.trim() || 'Unknown Title';
            } catch (e) {
                const titleAttr = item.children[0]?.children[0]?.getAttribute("title");
                title = titleAttr ? titleAttr.trim() : 'Unknown Title';
            }
            const coverImg = item.querySelector("img")?.getAttribute("src");
            
            if (url && title) {
                results.push({
                    title: title,
                    url: url,
                    cover_image_url: coverImg || 'N/A'
                });
            }
        } catch (error) {
            logger.error(`Error parsing shojo item: ${error}`, "parsing");
            continue;
        }
    }

    return results;
}

async function parseToonGodListingPage(html, pageNum) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const titles = [];
    
    const items = document.querySelectorAll('.thumb-item-flow');
    
    for (const item of items) {
        try {
            let title = 'Unknown';
            let href = null;
            let cover_image_url = 'N/A';

            const link = item.children[1]?.children[0];
            if (link) {
                href = link.getAttribute('href');
                title = link.getAttribute('title') || link.textContent.trim() || 'Unknown';
            }
            
            const imgEl = item.children[0]?.children[0]?.children[0]?.children[0]; 
            if (imgEl) {
                let bgUrl = imgEl.getAttribute('data-bg') || 
                            imgEl.getAttribute('data-src') || 
                            imgEl.getAttribute('src');
                
                if (bgUrl) {
                    const urlMatch = bgUrl.match(/url\(['"]?([^'")]+)['"]?\)/);
                    cover_image_url = urlMatch ? urlMatch[1] : bgUrl;
                }
            }
            
            if (href && title !== 'Unknown') {
                const fullUrl = href.startsWith('http') ? href : new URL(href, 'https://manhwa18.net/').href;
                
                titles.push({
                    title: title.replace(/\s+/g, ' ').trim(),
                    url: fullUrl,
                    cover_image_url: cover_image_url && cover_image_url !== 'N/A' ? cover_image_url : undefined,
                    genres: [],
                    author: 'N/A',
                    updated: new Date().toISOString().split('T')[0]
                });
            }
        } catch (error) {
            logger.error(`Error parsing ToonGod listing item: ${error}`, "parsing");
            continue;
        }
    }
    
    return titles;
}

async function parseMangaListingPage(html, pageNum) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const titles = [];

    const items = document.getElementsByClassName('list-comic-item-wrap');
    
    for (const item of items) {
        try {
            const link = item.children[0];
            if (!link || !link.href) continue;

            const href = link.href.startsWith('http') ? link.href : new URL(link.href, 'https://www.mangakakalot.gg/').href;
            const title = (link.getAttribute('title') || link.textContent.trim()).replace(/\s+/g, ' ').trim();
            
            const coverImg = link.children[0];
            let cover_image_url = coverImg?.getAttribute('data-src') || coverImg?.getAttribute('src') || 'N/A';
            if (cover_image_url && !cover_image_url.startsWith('http')) {
                cover_image_url = new URL(cover_image_url, 'https://mangakakalot.com/').href;
            }

            titles.push({
                title: title,
                url: href,
                cover_image_url: cover_image_url !== 'N/A' ? cover_image_url : undefined
            });

        } catch (error) {
            logger.error(`Error parsing MangaKakalot listing item: ${error}`, "parsing");
            continue;
        }
    }

    return titles;
}


// --- Chapter & Image Parsing Functions ---

async function parseShojoChapters(html, detailUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const chapters = [];
    
    const chapterList = document.querySelector('#chapterlist');
    if (!chapterList) {
        return chapters;
    }
    
    const chapterItems = chapterList.querySelectorAll('ul.clstyle li, li[data-num]');
    
    for (const item of chapterItems) {
        try {
            let link = item.querySelector('div.chbox div.eph-num a') || 
                      item.querySelector('div.eph-num a') || 
                      item.querySelector('a');
            
            if (!link) continue;
            
            const chapterUrl = link.getAttribute('href');
            const dataNum = item.getAttribute('data-num');
            
            const titleSpan = link.querySelector('span.chapternum') || link.querySelector('span');
            let chapterTitle = titleSpan?.textContent?.trim() || `Chapter ${dataNum || ''}`;
            
            chapterTitle = chapterTitle.replace(/\s+/g, ' ').trim();
            
            if (chapterUrl) {
                const fullUrl = chapterUrl.startsWith('http') ? chapterUrl : new URL(chapterUrl, 'https://kingofshojo.com/').href;
                
                chapters.push({
                    title: chapterTitle || `Chapter ${dataNum || ''}`,
                    url: fullUrl
                });
            }
        } catch (error) {
            logger.error(`Error parsing shojo chapter: ${error}`, "parsing");
            continue;
        }
    }
    
    return chapters.reverse();
}

async function parseShojoChapterImages(html, chapterUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const images = [];
    
    const imageElements = document.getElementById('readerarea')?.children[0]?.children || [];
    for (const img of imageElements) {
        try {
            let src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
            if (src && !src.includes('data:image')) {
                if (!src.startsWith('http')) {
                    const baseUrl = 'https://kingofshojo.com/';
                    src = new URL(src, baseUrl).href;
                }
                images.push(src);
            }  
        } catch (error) {
            logger.error(`Error parsing shojo chapter image: ${error}`, "parsing");
            continue;
        }
    }
    return images;
}

async function parseToonGodChapterImages(html, chapterUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const images = [];
    
    let imageElements = document.getElementById('chapter-content')?.children || [];
    
    for (const img of imageElements) {
        try {
            let src = img.getAttribute('src') || 
                     img.getAttribute('data-src') || 
                     img.getAttribute('data-lazy-src') ||
                     img.getAttribute('data-original');
            
            if (!src || src.includes('data:image')) {
                continue;
            }
            
            const isValidImageUrl = !src.match(/(logo|icon|placeholder|avatar|gravatar|ad|banner|widget)/i);
            if (!isValidImageUrl) {
                continue;
            }
            
            if (!src.startsWith('http')) {
                const baseUrl = 'https://manhwa18.net/';
                src = new URL(src, baseUrl).href;
            }
            
            images.push(src);
        } catch (error) {
            logger.error(`Error parsing toongod chapter image: ${error}`, "parsing");
            continue;
        }
    }
    
    const scriptContents = Array.from(document.querySelectorAll('script')).map(s => s.textContent).join('\n');
    const imageArrayMatches = scriptContents.match(/\["http[^"]+\.(jpg|png|webp|gif)"(?:, ?"[^"]+")*\]/ig);
    
    if (imageArrayMatches) {
        for (const match of imageArrayMatches) {
            try {
                const imageArray = JSON.parse(match);
                for(const imgUrl of imageArray) {
                    if (imgUrl && !images.includes(imgUrl) && imgUrl.includes('http')) {
                         images.push(imgUrl);
                    }
                }
            } catch(e) {
                // Failed to parse script content as JSON
            }
        }
    }
    
    if (images.length === 0) {
        Array.from(document.querySelectorAll('img')).forEach(img => {
            let src = img.getAttribute('src') || img.getAttribute('data-src');
            if (src && src.match(/\.(jpg|png|webp|gif)/i) && !src.match(/(logo|icon|placeholder)/i)) {
                 if (!src.startsWith('http')) {
                    src = new URL(src, 'https://manhwa18.net/').href;
                }
                if (!images.includes(src)) images.push(src);
            }
        });
    }
    
    return images;
}


async function parseToonGodChapters(html, detailUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const chapters = [];
    
    const chapterItems = document.getElementsByClassName('list-chapters')[0]?.children || [];
    
    for (const item of chapterItems) {
        try {
            const href = item.getAttribute('href');
            let title = item.getAttribute('title')  ;
            if (!href || !title) continue;
            
            const fullUrl = href.startsWith('http') ? href : `https://manhwa18.net${href}`;
            
            chapters.push({
                title: title.replace(/\s+/g, ' ').trim(),
                url: fullUrl
            });
        } catch (error) {
            logger.error(`Error parsing toongod chapter: ${error}`, "parsing");
            continue;
        }
    }
    
    return chapters.reverse();
}

async function parseMangaChapterImages(html, chapterUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const images = [];
    
    const imageElements = document.getElementsByClassName('container-chapter-reader')[0]?.children || [];
    
    for (const img of imageElements) {
        try {
            let src = img.getAttribute('src') || 
                     img.getAttribute('data-src') || 
                     img.getAttribute('data-lazy-src') ||
                     img.getAttribute('data-original');
            
            if (!src || src.includes('data:image') || !src.match(/\.(jpg|png|webp|gif)/i)) {
                continue;
            }
            
            if (!src.startsWith('http')) {
                src = new URL(src, 'https://mangakakalot.com/').href;
            }
            
            if (!images.includes(src)) {
                images.push(src);
            }
        } catch (error) {
            logger.error(`Error parsing mangakakalot chapter image: ${error}`, "parsing");
            continue;
        }
    }
    
    return images;
}


async function parseMangaChapters(html, detailUrl) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const chapters = [];
    
    const chapterItems = document.getElementsByClassName('row');
    
    for (const item of chapterItems) {
        try {
            const link = item.children[0].children[0];
            if (!link || !link.href) continue;
            
            const chapterUrl = link.getAttribute('href');
            let chapterTitle = link.textContent.trim();
            
            chapterTitle = chapterTitle.replace(/\s+/g, ' ').trim();
            
            if (chapterUrl) {
                const fullUrl = chapterUrl.startsWith('http') ? chapterUrl : new URL(chapterUrl, 'https://mangakakalot.com/').href;
                
                chapters.push({
                    title: chapterTitle,
                    url: fullUrl
                });
            }
        } catch (error) {
            logger.error(`Error parsing MangaKakalot chapter: ${error}`, "parsing");
            continue;
        }
    }
    
    return chapters.reverse();
}


module.exports = {
    sleep,
    fetchWithRetry,
    saveInfo,
    getErrorStats,
    
    fetchShojoPage,
    fetchShojo,
    fetchToonGodPage,
    fetchToonGod,
    fetchMangaPage,
    fetchManga,

    parseShojoListingPage,
    parseToonGodListingPage,
    parseMangaListingPage,
    
    parseShojoChapters,
    parseToonGodChapters,
    parseMangaChapters,
    parseShojoChapterImages,
    parseToonGodChapterImages,
    parseMangaChapterImages
};