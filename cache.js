// --- START OF FILE cache.js ---
const parsing = require('./mangaparsing');
const dbModule = require('./db'); 
const { openAndInitDb, openAndInitUserDb } = require('./db');
const { SHOJO_DB_PATH, TOONGOD_DB_PATH, USERS_DB_PATH, MANGA_DB_PATH } = require('./config');
const { logger } = require('./utils');
const EventEmitter = require('events');
const em = new EventEmitter();
async function getAllTitlesForSearch(dbConnection) {
    if (!dbConnection) return [];
    
    const titles = await dbConnection.all(`SELECT id, title, url, author, updated, cover_image_url, genres FROM titles`);
    const alternatives = await dbConnection.all(`SELECT alt_title, title_id FROM alternatives`);

    const alternativesMap = alternatives.reduce((acc, alt) => {
        acc[alt.title_id] = acc[alt.title_id] || [];
        acc[alt.title_id].push(alt.alt_title);
        return acc;
    }, {});

    return titles.map(title => {
        let genres = [];
        try {
            genres = JSON.parse(title.genres || '[]');
        } catch (e) {
            genres = [];
        }
        return {
            ...title,
            genres: genres,
            searchableNames: [title.title, ...(alternativesMap[title.id] || [])].filter(n => n)
        };
    });
}

// Internal cache state
let shojoTitlesCache = [];
let toongodTitlesCache = [];
let mangaTitlesCache = [];

async function refetch() {
    // Large fetch interval (1 hour)
    setInterval(async () => {
        try {
            await parsing.fetchShojoPage(1, dbModule.shojoDb);
            await parsing.fetchToonGodPage(1, dbModule.toongodDb);
            await parsing.fetchShojoPage(2, dbModule.shojoDb);
            await parsing.fetchToonGodPage(2, dbModule.toongodDb);
            await parsing.fetchShojoPage(3, dbModule.shojoDb);
            await parsing.fetchToonGodPage(3, dbModule.toongodDb);
            await parsing.fetchMangaPage(1, dbModule.mangaDb);
            await parsing.fetchMangaPage(2, dbModule.mangaDb);
            await parsing.fetchMangaPage(3, dbModule.mangaDb);
            
            logger.log('\nRefetch complete. Updating search caches...', "cache");
            // Reuse loadCaches to ensure consistency
            await loadCaches();
            logger.log(`\nCaches successfully updated. Manga: ${mangaTitlesCache.length}, Shojo: ${shojoTitlesCache.length}, ToonGod: ${toongodTitlesCache.length}`, "cache");
        } catch (err) {
            logger.error(`error in refetch routine: ${err}`, "cache");
        }
    }, 3600000);
    
    // Quick update interval (10 minutes)
    setInterval(async () => {
        try {
            await parsing.fetchMangaPage(1, dbModule.mangaDb);
            await parsing.fetchMangaPage(2, dbModule.mangaDb);
            await parsing.fetchMangaPage(3, dbModule.mangaDb);
            
            mangaTitlesCache = await getAllTitlesForSearch(dbModule.mangaDb);
            em.emit('cache-load', {shojoCache: shojoTitlesCache, toongodCache: toongodTitlesCache, mangaCache: mangaTitlesCache});
            logger.log(`\nManga cache successfully updated. Total titles: ${mangaTitlesCache.length}`, "cache");
        } catch (err) {
            logger.error(`error updating manga cache: ${err}`, "cache");
        }
    }, 600000);
}

async function loadCaches(){
    // FIX: Used dbModule.* instead of undefined local variables
    shojoTitlesCache = await getAllTitlesForSearch(dbModule.shojoDb);
    toongodTitlesCache = await getAllTitlesForSearch(dbModule.toongodDb);
    mangaTitlesCache = await getAllTitlesForSearch(dbModule.mangaDb);
    em.emit('cache-load', {shojoCache: shojoTitlesCache, toongodCache: toongodTitlesCache, mangaCache: mangaTitlesCache});
}

function getCaches(){
    return {
        shojo: shojoTitlesCache,
        toongod: toongodTitlesCache,
        manga: mangaTitlesCache
    };
}

async function main() {
    await initServer(); 
    
    // Check if geterrorStats exists on parsing
    if (parsing.geterrorStats) {
        const { errs } = parsing.geterrorStats();
        if (errs > 0) {
            logger.log(`\nTotal Detail Fetch errors: ${errs}`, "cache");
        }
    }
    
    refetch();
}

async function initServer() {
    const localShojoDb = await openAndInitDb(SHOJO_DB_PATH);
    const localToongodDb = await openAndInitDb(TOONGOD_DB_PATH);
    const localUserDb = await openAndInitUserDb(USERS_DB_PATH);
    const localMangaDb = await openAndInitDb(MANGA_DB_PATH);
    // parsing.fetchManga(localMangaDb);
    // Inject connections into the db module
    Object.assign(dbModule, { 
        shojoDb: localShojoDb, 
        toongodDb: localToongodDb, 
        userDb: localUserDb, 
        mangaDb: localMangaDb 
    });

    await loadCaches();
    
    const { shojo: shojoCache, toongod: toongodCache, manga: mangaCache } = getCaches();
    em.emit('cache-load', {shojoCache: shojoCache, toongodCache: toongodCache, mangaCache: mangaCache});
    logger.log(`Loaded ${shojoCache.length} shojo, ${toongodCache.length} toongod, and ${mangaCache.length} manga titles into cache for search.`, "cache");
}

module.exports = {
    loadCaches,
    refetch,
    getAllTitlesForSearch,
    initServer,
    getCaches,
    main,
    // Export getters to ensure external modules see live updates
    get shojoTitlesCache() { return shojoTitlesCache; },
    get toongodTitlesCache() { return toongodTitlesCache; },
    get mangaTitlesCache() { return mangaTitlesCache; },
    em
};