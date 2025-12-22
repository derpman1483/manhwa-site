// --- START OF FILE routes.js ---

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const router = express.Router();
const { JWT_SECRET, COOKIE_SECRET } = require('./config');
const { logger } = require('./utils');
const { loadDbs } = require('./db');
const { updateUserJsonField } = require('./db');
var { createSlug, createGenreSlug, fuzzySearch } = require('./utils');
const bcrypt = require('bcrypt');
const parsing = require('./mangaparsing');
const { em } = require('./cache');
let shojoDb, toongodDb, mangaDb, userDb;
let shojoTitlesCache = [];
let toongodTitlesCache = [];
let mangaTitlesCache = [];
em.on('cache-load', async (caches) => {
    console.log('Cache load event received in routes.js');
    shojoTitlesCache = caches.shojoCache;
    toongodTitlesCache = caches.toongodCache;
    mangaTitlesCache = caches.mangaCache;
});
async function initDbs() {
    const dbs = await loadDbs();
    shojoDb = dbs.shojoDb;
    toongodDb = dbs.toongodDb;
    mangaDb = dbs.mangaDb;
    userDb = dbs.userDb;
}
initDbs();
 // Delay to ensure DBs are loaded
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
router.use(cookieParser(COOKIE_SECRET));

// --- AUTHENTICATION MIDDLEWARE ---
async function auth(req, res, next) {
    const token = req.signedCookies.auth;

    if (!token) {
        return res.redirect('/login');
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        const inDb= await userDb.get('SELECT * FROM users WHERE id = ?', decoded.id);
        if (!inDb) {
            return res.redirect('/signup');
        }
        next();
    } catch (err) {
        logger.error(`JWT verification failed: ${err.message}`, "routes");
        return res.redirect('/login');
    }
}

// --- PROTECTED FILE SERVING ROUTES ---
const protectedFiles = ['index.html', 'genre.html', 'manhwa.html', 'settings.html', 'genres.html', 'search.html', 'profile.html'];
router.get(['/', '/index.html', ...protectedFiles.map(f => `/${f}`)], auth, (req, res) => {
    // Determine the file to serve: 'index.html' for root, otherwise the matched path
    const fileName = req.path === '/' ? 'index.html' : path.basename(req.path);
    res.sendFile(fileName, { root: path.join(__dirname, 'public') }, (err) => {
        if (err) res.status(500).send(`Error loading ${fileName}`);
    });
});

// --- API ROUTES ---

router.get('/api/profile', auth, async (req, res) => {
    try {
        const user = await userDb.get('SELECT * FROM users WHERE id = ?', req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const bookmarks = JSON.parse(user.bookmarks || '[]');
        const favorites = JSON.parse(user.favorites || '[]');
        const readingHistory = JSON.parse(user.reading_history || '[]');
        const ratings = JSON.parse(user.ratings || '[]');
        
        res.json({
            username: user.username,
            memberSince: user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A',
            favoritesCount: favorites.length,
            bookmarksCount: bookmarks.length,
            ratedCount: ratings.length, 
            readingHistory: readingHistory,
            ratings: ratings,
            bookmarks: bookmarks,
            favorites: favorites
        });
    } catch (error) {
        logger.error(`Error fetching profile data: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/manhwa/:slug', async (req, res) => {
    try {
        const slug = decodeURIComponent(req.params.slug).toLowerCase();
        
        let result = null;
        let dbType = null;
        
        const allTitles = [
            ...shojoTitlesCache.map(t => ({ ...t, dbType: 'shojo' })),
            ...toongodTitlesCache.map(t => ({ ...t, dbType: 'toongod' })),
            ...mangaTitlesCache.map(t => ({ ...t, dbType: 'manga' })),
        ];
        
        // Exact match search
        for (const title of allTitles) {
            const titleSlug = createSlug(title.title);
            if (titleSlug === slug) {
                result = title;
                dbType = title.dbType;
                break;
            }
            if (title.searchableNames) {
                for (const altName of title.searchableNames) {
                    if (createSlug(altName) === slug) {
                        result = title;
                        dbType = title.dbType;
                        break;
                    }
                }
            }
            if (result) break;
        }

        // Fuzzy Matching Search (Fallback)
        if (!result) {
            const searchTerm = slug.replace(/-/g, ' ');
            const FUZZY_THRESHOLD = 0.6;
            
            const shojoFuzzy = fuzzySearch(searchTerm, shojoTitlesCache, FUZZY_THRESHOLD);
            const toongodFuzzy = fuzzySearch(searchTerm, toongodTitlesCache, FUZZY_THRESHOLD);
            const mangaFuzzy = fuzzySearch(searchTerm, mangaTitlesCache, FUZZY_THRESHOLD);
            
            const results = [
                ...shojoFuzzy.map(r => ({ ...r, type: 'shojo' })),
                ...toongodFuzzy.map(r => ({ ...r, type: 'toongod' })),
                ...mangaFuzzy.map(r => ({ ...r, type: 'manga' }))
            ].sort((a, b) => b.similarityScore - a.similarityScore);
            
            if (results.length > 0) {
                // The issue here is that `result` is assigned the full array, but then used as a single object. 
                // Assigning the best match to result is the correct logic for a detail page.
                result = results[0];
                dbType = results[0].type;
            }
        }
        
        if (!result) {
            return res.status(404).json({ error: 'Manhwa not found' });
        }
        
        let alternatives = [];
        if (result.searchableNames) {
            alternatives = result.searchableNames.filter(name => name !== result.title);
        } else {
            let selectedDb;
            if (dbType === 'shojo') selectedDb = shojoDb;
            else if (dbType === 'toongod') selectedDb = toongodDb;
            else selectedDb = mangaDb;
            
            const altRows = await selectedDb.all(
                `SELECT alt_title FROM alternatives WHERE title_id = ?`,
                [result.id]
            );
            alternatives = altRows.map(a => a.alt_title);
        }

        const genres = Array.isArray(result.genres) ? result.genres : JSON.parse(result.genres || '[]');
        
        res.json({
            ...result,
            genres: genres,
            alternatives: alternatives,
            type: dbType
        });
    } catch (error) {
        logger.error(`Error fetching manhwa details: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});


router.get('/api/genre/:genreSlug', async (req, res) => {
    try {
        const genreSlug = decodeURIComponent(req.params.genreSlug).toLowerCase();
        const type = req.query.type;
        
        const results = [];
        let cachesToSearch = [];
        if (type === 'shojo') {
            cachesToSearch = [{ cache: shojoTitlesCache, type: 'shojo' }];
        } else if (type === 'toongod') {
            cachesToSearch = [{ cache: toongodTitlesCache, type: 'toongod' }];
        } else if (type === 'manga') {
            cachesToSearch = [{ cache: mangaTitlesCache, type: 'manga' }];
        } else {
            cachesToSearch = [
                { cache: mangaTitlesCache, type: 'manga' },
                { cache: shojoTitlesCache, type: 'shojo' },
                { cache: toongodTitlesCache, type: 'toongod' }
            ];
        }
        
        const uniqueTitles = new Set();
        
        for (const { cache, type: dbType } of cachesToSearch) {
            for (const title of cache) {
                const hasMatchingGenre = (title.genres || []).some(g => createGenreSlug(g) === genreSlug);
                
                if (hasMatchingGenre) {
                    if (!uniqueTitles.has(title.id + dbType)) {
                        uniqueTitles.add(title.id + dbType);
                        results.push({
                            id: title.id,
                            title: title.title,
                            url: title.url,
                            author: title.author,
                            updated: title.updated,
                            cover_image_url: title.cover_image_url,
                            genres: title.genres,
                            type: dbType
                        });
                    }
                }
            }
        }
        
        res.json(results);
    } catch (error) {
        logger.error(`Error fetching genre: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

router.get('/genre/:genreName', auth, (req, res) => {
    res.sendFile('genre.html', { root: path.join(__dirname, 'public') }, (err) => {
        if (err) {
            logger.error(`Error sending genre.html: ${err}`, "routes");
            res.status(404).send('Page not found');
        }
    });
});

router.get('/api/user/favorites', auth, async (req, res) => {
    try {
        const user = await userDb.get('SELECT favorites FROM users WHERE id = ?', req.user.id);
        const favorites = JSON.parse(user?.favorites || '[]');
        res.json(favorites);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error fetching favorites.' });
    }
});

router.post('/api/user/favorite', auth, async (req, res) => {
    const { slug, title, isFavorite } = req.body;

    if (!slug || title === undefined || isFavorite === undefined) {
        return res.status(400).json({ error: 'Missing required parameters: slug, title, or isFavorite.' });
    }

    try {
        const user = await userDb.get('SELECT favorites FROM users WHERE id = ?', req.user.id);
        let favorites = JSON.parse(user?.favorites || '[]');
        
        if (isFavorite) {
            if (!favorites.find(f => f.slug === slug)) {
                favorites.push({ slug, title });
            }
        } else {
            favorites = favorites.filter(f => f.slug !== slug);
        }

        await updateUserJsonField(req.user.id, 'favorites', favorites);
        res.json({ success: true, isFavorite: isFavorite, favoritesCount: favorites.length });
    } catch (error) {
        logger.error('Error updating favorite:', error);
        res.status(500).json({ error: 'Internal server error updating favorite.' });
    }
});

router.post('/api/user/bookmark', auth, async (req, res) => {
    const {slug, title, isBookmarked } = req.body;

    if (!slug || title === undefined || isBookmarked === undefined) {
         return res.status(400).json({ error: 'Missing required parameters: slug, title, or isBookmarked.' });
    }

    try {
        const user = await userDb.get('SELECT bookmarks FROM users WHERE id = ?', req.user.id);
        let bookmarks = JSON.parse(user?.bookmarks || '[]');
        
        const existingIndex = bookmarks.findIndex(b => b.slug === slug);

        if (isBookmarked) {
            if (existingIndex === -1) {
                bookmarks.push({ title, slug });
            }
        } else {
            if (existingIndex > -1) {
                bookmarks = bookmarks.filter(b => b.slug !== slug);
            }
        }

        await updateUserJsonField(req.user.id, 'bookmarks', bookmarks);
        res.json({ success: true, isBookmarked: isBookmarked, bookmarksCount: bookmarks.length });
    } catch (error) {
        logger.error(`Error updating bookmark: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error updating bookmark.' });
    }
});

router.post('/api/user/rating', auth, async (req, res) => {
    const { slug, title, rating} = req.body;

    if (!slug || title === undefined || (rating === undefined) ) {
        return res.status(400).json({ error: 'Missing required parameters for rating.' });
    }
    if (rating !== undefined && (rating < 0 || rating > 5)) {
        return res.status(400).json({ error: 'Rating must be between 0 and 5 (0 for removal).' });
    }

    try {
        const user = await userDb.get('SELECT ratings FROM users WHERE id = ?', req.user.id);
        let ratings = JSON.parse(user?.ratings || '[]');
        
        const existingIndex = ratings.findIndex(r => r.slug === slug);

        if (rating === 0) {
            if (existingIndex > -1) {
                ratings.splice(existingIndex, 1);
            }
        } else {
            const newRating = { slug, title, rating, timestamp: new Date().toISOString() };
            if (existingIndex > -1) {
                ratings[existingIndex] = newRating;
            } else {
                ratings.push(newRating);
            }
        }
        
        await updateUserJsonField(req.user.id, 'ratings', ratings);
        res.json({ success: true, ratedCount: ratings.length, currentRating: rating });
    } catch (error) {
        logger.error(`Error updating rating: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error updating rating.' });
    }
});

router.get('/manhwa/:title', auth, (req, res) => {
    res.sendFile('manhwa.html', { root: path.join(__dirname, 'public') }, (err) => {
        if (err) {
            logger.error(`Error sending manhwa.html: ${err}`, "routes");
            res.status(404).send('Page not found');
        }
    });
});

// --- USER AUTH ROUTES ---

router.get('/signup', (req, res) => {
    res.sendFile('signup.html', { root: path.join(__dirname, 'public') }, (err) => {
        if (err) res.status(500).send('Error loading sign-up page');
    });
});

router.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('Username and password are required.');
    }

    try {
        const existingUser = await userDb.get('SELECT * FROM users WHERE username = ?', username);
        if (existingUser) {
            return res.status(409).send('User already exists.'); 
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await userDb.run('INSERT INTO users (username, password,is_admin) VALUES (?, ?, ?)', username, hashedPassword, username === 'admin' ? 1 : 0);
        
        res.redirect('/login'); 
    } catch (error) {
        logger.error(`Sign-up error: ${error}`, "routes");
        res.status(500).send('Internal server error during registration.');
    }
});

router.get('/login', (req, res) => {
    res.sendFile('login.html', { root: path.join(__dirname, 'public') }, (err) => {
        if (err) res.status(500).send('Error loading login page');
    });
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('Username and password are required.');
    }

    try {
        const user = await userDb.get('SELECT * FROM users WHERE username = ?', username);
        
        if (!user) {
            return res.status(401).send('Invalid username or password.');
        }

        const match = await bcrypt.compare(password, user.password);
        const MAX_AGE = 259200000;
        
        if (match) {
            const payload = { id: user.id, username: user.username };
            const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '3d' });

            res.cookie('auth', token, { 
                httpOnly: true,
                signed: true,
                maxAge: MAX_AGE, 
            });
            
            res.cookie('username', user.username, {
                httpOnly: false,
                maxAge: MAX_AGE
            });
            
            res.redirect('/');
        } else {
            res.status(401).send('Invalid username or password.');
        }

    } catch (error) {
        logger.error(`Login error: ${error}`, "routes");
        res.status(500).send('Internal server error during login.');
    }
});

router.post('/logout', (req, res) => {
    res.clearCookie('auth', { signed: true }); 
    res.clearCookie('username'); 
    res.json({ message: 'Logout successful.' });
});

// --- END USER AUTH ROUTES ---

router.get('/api/debug/genres/:type', async (req, res) => {
    try {
        const { type } = req.params;
        let db;
        
        if (type === 'shojo') {
            db = shojoDb;
        } else if (type === 'toongod') {
            db = toongodDb;
        } else {
            db = mangaDb;
        }
        
        const allTitles = await db.all(`SELECT COUNT(*) as count FROM titles`);
        const withGenres = await db.all(`SELECT COUNT(*) as count FROM titles WHERE genres IS NOT NULL AND genres != '[]'`);
        const sampleTitles = await db.all(`SELECT title, genres FROM titles LIMIT 5`);
        
        res.json({
            type,
            totalTitles: allTitles[0]?.count || 0,
            titlesWithGenres: withGenres[0]?.count || 0,
            samples: sampleTitles.map(t => ({
                title: t.title,
                genres: t.genres ? JSON.parse(t.genres) : []
            }))
        });
    } catch (error) {
        logger.error(`Debug error: ${error}`, "routes");
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/genres', async (req, res) => {
    try {
        const { type } = req.query;
        let dbsToQuery = [];
        if (type === 'shojo') {
            dbsToQuery = [shojoDb];
        } else if (type === 'toongod') {
            dbsToQuery = [toongodDb];
        } else if (type === 'manga') {
            dbsToQuery = [mangaDb];
        } else {
            dbsToQuery = [shojoDb, toongodDb, mangaDb];
        }
        
        const genreSet = new Set();
        
        for (const db of dbsToQuery) {
            const titles = await db.all(`SELECT genres FROM titles WHERE genres IS NOT NULL AND genres != '[]'`);
            
            titles.forEach(title => {
                try {
                    const genres = JSON.parse(title.genres || '[]');
                    genres.forEach(genre => genreSet.add(genre));
                } catch (e) {
                    // Skip invalid JSON
                }
            });
        }
        
        const genres = Array.from(genreSet).sort();
        res.json(genres);
    } catch (error) {
        logger.error(`Error fetching genres: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/shojo/search', (req, res) => {
    try {
    const query = req.query.q;
        const genre = req.query.genre || null;
    if (!query) {
        return res.json([]);
    }
        const results = fuzzySearch(query, shojoTitlesCache, 0.2, genre);
        const filtered = results.map(r => ({
            ...r,
            cover_image_url: (r.cover_image_url && r.cover_image_url !== 'N/A') ? r.cover_image_url : undefined
        }));
    res.json(filtered.slice(0, 50));
    } catch (error) {
        logger.error(`Error in shojo search: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/toongod/search', (req, res) => {
    try {
        const query = req.query.q;
        const genre = req.query.genre || null;
        
        if (!query) {
            return res.json([]);
        }
        
        const results = fuzzySearch(query, toongodTitlesCache, 0.2, genre);
        const filtered = results.map(r => ({
            ...r,
            cover_image_url: (r.cover_image_url && r.cover_image_url !== 'N/A') ? r.cover_image_url : undefined
        }));
        res.json(filtered.slice(0, 50));
    } catch (error) {
        logger.error(`Error in toongod search: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/mg/search', (req, res) => {
    try {
        const query = req.query.q;
        const genre = req.query.genre || null;
        
        if (!query) {
            return res.json([]);
        }
        
        const results = fuzzySearch(query, mangaTitlesCache, 0.2, genre);
        const filtered = results.map(r => ({
            ...r,
            cover_image_url: ((r.cover_image_url && r.cover_image_url !== 'N/A')? r.cover_image_url : undefined)
        }));
        res.json(filtered.slice(0, 50));
    } catch (error) {
        logger.error(`Error in manga search: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/shojo/listing', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const url = `https://kingofshojo.com/page/${page}/`;
        
        const response = await parsing.fetchWithRetry(url);
        const results = await parsing.parseShojoListingPage(response.data, page);
        
        res.json({ page, results, totalPages: 98 });
    } catch (error) {
        logger.error(`Error fetching shojo listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});


router.get('/api/shojo/listing/batch', async (req, res) => {
    try {
        const currentPage = parseInt(req.query.page) || 1;
        const pages = [
            Math.max(1, currentPage - 1),
            currentPage,
            currentPage + 1
        ].filter((p, i, arr) => p <= 98 && (i === 0 || p !== arr[i-1]));

        const promises = pages.map(async (page) => {
            try {
                const url = `https://kingofshojo.com/page/${page}/`;
                const response = await parsing.fetchWithRetry(url);
                const results = await parsing.parseShojoListingPage(response.data, page);
                return { page, results, success: true };
            } catch (error) {
                logger.error(`Error fetching shojo page ${page}: ${error}`, "routes");
                return { page, results: [], success: false, error: error.message };
            }
        });

        const results = await Promise.all(promises);
        res.json({ pages: results });
    } catch (error) {
        logger.error(`Error in batch shojo listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});
router.get('/api/mg/listing', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const url = `https://www.mangakakalot.gg/manga-list/latest-manga?page=${page}`;
        logger.log(`listing page ${page} with url ${url} recieved`);
        const response = await parsing.fetchWithRetry(url);
        const results = await parsing.parseMangaListingPage(response.data, page);
        
        res.json({ page, results, totalPages: 2959 });
    } catch (error) {
        logger.error(`Error fetching manga listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});


router.get('/api/mg/listing/batch', async (req, res) => {
    try {
        const currentPage = parseInt(req.query.page) || 1;
        const pages = [
            Math.max(1, currentPage - 1),
            currentPage,
            currentPage + 1
        ].filter((p, i, arr) => p <= 98 && (i === 0 || p !== arr[i-1]));

        const promises = pages.map(async (page) => {
            try {
                const url = `https://www.mangakakalot.gg/manga-list/latest-manga?page=${page}`;
                const response = await parsing.fetchWithRetry(url);
                const results = await parsing.parseMangaListingPage(response.data, page);
                return { page, results, success: true };
            } catch (error) {
                logger.error(`Error fetching manga page ${page}: ${error}`, "routes");
                return { page, results: [], success: false, error: error.message };
            }
        });

        const results = await Promise.all(promises);
        res.json({ pages: results });
    } catch (error) {
        logger.error(`Error in batch shojo listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/toongod/listing', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const url = `https://manhwa18.net/genre/adult?sort=update&page=${page}`;
        
        const config = { headers: { 'Referer': 'https://manhwa18.net/' } };
        const response = await parsing.fetchWithRetry(url, config);
        let results = await parsing.parseToonGodListingPage(response.data, page);
        
        const titlesToFetch = results.map(r => r.title);
        if (titlesToFetch.length > 0) {
             const placeholders = titlesToFetch.map(() => '?').join(',');
             const dbResults = await toongodDb.all(
                 `SELECT title, cover_image_url FROM titles WHERE title IN (${placeholders})`,
                 titlesToFetch
             );
             const dbImageMap = dbResults.reduce((map, row) => {
                 if (row.cover_image_url && row.cover_image_url !== 'N/A') {
                     map[row.title] = row.cover_image_url;
                 }
                 return map;
             }, {});

             results = results.map(item => ({
                 ...item,
                 cover_image_url: dbImageMap[item.title] || item.cover_image_url
             }));
        }
        
        res.json({ page, results, totalPages: 62 });
    } catch (error) {
        logger.error(`Error fetching toongod listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/toongod/listing/batch', async (req, res) => {
    try {
        const currentPage = parseInt(req.query.page) || 1;
        const pages = [
            Math.max(1, currentPage - 1),
            currentPage,
            currentPage + 1
        ].filter((p, i, arr) => p <= 62 && (i === 0 || p !== arr[i-1]));

        const promises = pages.map(async (page) => {
            try {
                const url = `https://manhwa18.net/genre/adult?sort=update&page=${page}`;
                const config = { headers: { 'Referer': 'https://manhwa18.net/' } };
                const response = await parsing.fetchWithRetry(url, config);
                let results = await parsing.parseToonGodListingPage(response.data, page);

                const titlesToFetch = results.map(r => r.title);
                if (titlesToFetch.length > 0) {
                    const placeholders = titlesToFetch.map(() => '?').join(',');
                    const dbResults = await toongodDb.all(
                        `SELECT title, cover_image_url FROM titles WHERE title IN (${placeholders})`,
                        titlesToFetch
                    );
                    const dbImageMap = dbResults.reduce((map, row) => {
                        if (row.cover_image_url && row.cover_image_url !== 'N/A') {
                            map[row.title] = row.cover_image_url;
                        }
                        return map;
                    }, {});

                    results = results.map(item => ({
                        ...item,
                        cover_image_url: dbImageMap[item.title] || item.cover_image_url
                    }));
                }
                return { page, results, success: true, totalPages: 62 };
            } catch (error) {
                logger.error(`Error fetching toongod page ${page}: ${error}`, "routes");
                return { page, results: [], success: false, error: error.message, totalPages: 62 };
            }
        });

        const results = await Promise.all(promises);
        res.json({ pages: results });
    } catch (error) {
        logger.error(`Error in batch toongod listing: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/chapters', async (req, res) => {
    try {
        const { url, type } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }
        const config = {};
        if (url.includes('manhwa18.net')) {
             config.headers = { 'Referer': 'https://manhwa18.net/' };
        }

        const response = await parsing.fetchWithRetry(url, config);
        
        let chapters = [];
        if (type === 'shojo' || url.includes('kingofshojo.com')) {
            chapters = await parsing.parseShojoChapters(response.data, url);
        } else if (type === 'toongod' || url.includes('manhwa18.net')) {
            chapters = await parsing.parseToonGodChapters(response.data, url);
        } else if (type === 'manga' || url.includes('mangakakalot')) {
            chapters = await parsing.parseMangaChapters(response.data, url);
        } else {
            if (url.includes('kingofshojo')) {
                chapters = await parsing.parseShojoChapters(response.data, url);
            } else if (url.includes('manhwa18')) {
                chapters = await parsing.parseToonGodChapters(response.data, url);
            } else if (url.includes('mangakakalot')) {
                chapters = await parsing.parseMangaChapters(response.data, url);
            }
        }
        
        res.json({ chapters });
    } catch (error) {
        logger.error(`Error fetching chapters: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/chapter/images', auth, async (req, res) => {
    try {
        const { url, type } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        let dbToUse = null;
        let titleInfo = null;

        if (type === 'shojo' || url.includes('kingofshojo.com')) {
            dbToUse = shojoDb;
        } else if (type === 'toongod' || url.includes('manhwa18.net')) {
            dbToUse = toongodDb;
        } else if (type === 'manga' || url.includes('mangakakalot')) {
            dbToUse = mangaDb;
        }

        // --- Reading History Update Logic ---
        if (dbToUse && req.user && req.user.id) {
            let titleUrlPart = null;
            let queryUrl = url.substring(0, url.lastIndexOf('/'));
            let isShojo = (type === 'shojo' || url.includes('kingofshojo.com'));
            let isToonGod = (type === 'toongod' || url.includes('manhwa18.net'));
            let isManga = (type === 'manga' || url.includes('mangakakalot'));

            if (isShojo) {
                const parts = url.substring(0, url.lastIndexOf('/')).split('/');
                const slugPart = parts[parts.length - 1].split('-chapter')[0];
                titleUrlPart = `https://kingofshojo.com/manga/${slugPart}`;
            } else if (isToonGod || isManga) {
                titleUrlPart = queryUrl; 
            }
            
            if (titleUrlPart) {
                let query = 'SELECT title, url FROM titles WHERE url = ? LIMIT 1';
                let params = [titleUrlPart];

                if (isToonGod || isManga) {
                    query = 'SELECT title, url FROM titles WHERE url LIKE ? LIMIT 1';
                    params = [`%${titleUrlPart}%`]; 
                }
                
                titleInfo = await dbToUse.get(query, params); 
                
                if (titleInfo) {
                    const curTitle = titleInfo.title;
                    const user = await userDb.get('SELECT reading_history FROM users WHERE id = ?', req.user.id);
                    let history = JSON.parse(user?.reading_history || '[]');
                    const timestamp = new Date().toISOString();
                    const titleSlug = createSlug(curTitle);
                    
                    const newEntry = { 
                        title: curTitle, 
                        url: titleInfo.url,
                        slug: titleSlug,
                        last_read: timestamp,
                        chapter:  url
                    };
                    
                    history = history.filter(h => h.slug !== titleSlug);
                    history.push(newEntry);
                    
                    history.sort((a, b) => new Date(b.last_read) - new Date(a.last_read));
                    history = history.slice(0, 200);
                    
                    await updateUserJsonField(req.user.id, 'reading_history', history);
                }
            }
        }
        // --- End Reading History Update Logic ---

        const config = {};
        if (url.includes('manhwa18.net')) {
             let referer = titleInfo ? titleInfo.url : url.split('/').slice(0, 3).join('/'); 
             config.headers = { 'Referer': referer }; 
        }

        const response = await parsing.fetchWithRetry(url, config);
        
        let images = [];
        if (type === 'shojo' || url.includes('kingofshojo.com')) {
            images = await parsing.parseShojoChapterImages(response.data, url);
        } else if (type === 'toongod' || url.includes('manhwa18.net')) {
            images = await parsing.parseToonGodChapterImages(response.data, url);
        } else if (type === 'manga' || url.includes('mangakakalot')) {
            images = await parsing.parseMangaChapterImages(response.data, url);
        } else {
            if (url.includes('kingofshojo')) {
                images = await parsing.parseShojoChapterImages(response.data, url);
            } else if (url.includes('manhwa18')) {
                images = await parsing.parseToonGodChapterImages(response.data, url);
            } else if (url.includes('mangakakalot')) {
                images = await parsing.parseMangaChapterImages(response.data, url);
            }
        }
        res.json({ images });
    } catch (error) {
        logger.error(`Error fetching chapter images: ${error}`, "routes");
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/health/ping', (req, res) => {
    try {
        const status = {
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        };
        res.json(status);
    } catch (error) {
        res.status(200).json({ status: 'ok (but with internal anomaly)', error: error.message });
    }
});

router.get('/api/img/:url', async (req, res) => {
    try {
        let b64url = decodeURIComponent(req.params.url);
        const decodedIntermediateBuffer = Buffer.from(b64url, 'base64');
        const decodedText = decodedIntermediateBuffer.toString('utf8'); 
        const finalBuffer = Buffer.from(decodedText, 'base64');
        const imageUrl = finalBuffer.toString('utf8');
        const { gotScraping } = await import('got-scraping');
        console.log(`Fetching image from URL: ${imageUrl}`);
        const response = await gotScraping.get(imageUrl, {
            headers: {
                'referer': 'https://www.nelomanga.net/',
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome' }],
                devices: ['desktop'],
            }
        });

        res.set('Content-Type', response.headers['content-type']);
        res.send(response.rawBody);
        
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

router.use(express.static('public'));
module.exports = {router,auth};
