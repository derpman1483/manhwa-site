// --- START OF FILE db.js ---

const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const { logger } = require('./utils');
const { SHOJO_DB_PATH, TOONGOD_DB_PATH, USERS_DB_PATH, MANGA_DB_PATH } = require('./config');
let shojoDb;
let toongodDb;
let userDb;
let mangaDb;

async function openAndInitDb(dbPath) {
    try {
        const db = await sqlite.open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        await db.run(`
            CREATE TABLE IF NOT EXISTS titles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT UNIQUE NOT NULL,
                url TEXT UNIQUE NOT NULL,
                author TEXT,
                updated TEXT,
                cover_image_url TEXT,
                genres TEXT 
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS alternatives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alt_title TEXT UNIQUE NOT NULL,
                title_id INTEGER NOT NULL,
                FOREIGN KEY (title_id) REFERENCES titles (id)
            );
        `);

        logger.log(`Database '${dbPath}' connected and schema initialized successfully.`, "db");
        return db;
    } catch (err) {
        logger.error(`Error initializing database '${dbPath}': ${err}`, "db");
        process.exit(1);
    }
    
}

async function openAndInitUserDb(dbPath) {
    try {
        const db = await sqlite.open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        await db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                bookmarks TEXT,
                favorites TEXT,
                ratings TEXT,
                reading_history TEXT
            );
        `);
        logger.log(`Database '${dbPath}' connected and schema initialized successfully.`, "db");
        return db;
    } catch (err) {
        logger.error(`Error initializing database '${dbPath}': ${err}`, "db");
        process.exit(1);
    }
}

async function updateUserJsonField(userId, fieldName, jsonData) { 
    const jsonString = JSON.stringify(jsonData);
    await userDb.run(`UPDATE users SET ${fieldName} = ? WHERE id = ?`, jsonString, userId);
}
async function loadDbs() {
    shojoDb = await openAndInitDb(SHOJO_DB_PATH);
    toongodDb = await openAndInitDb(TOONGOD_DB_PATH);
    userDb = await openAndInitUserDb(USERS_DB_PATH);
    mangaDb = await openAndInitDb(MANGA_DB_PATH);
    return {
        shojoDb,
        toongodDb,
        userDb,
        mangaDb
    };
}
module.exports = {
    openAndInitDb,
    openAndInitUserDb,
    updateUserJsonField,
    loadDbs
};