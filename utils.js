// --- START OF FILE utils.js ---
const fs = require('fs');
const stringSimilarity = require('string-similarity');
const path = require('path');
const cookie = require("cookie");
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { JWT_SECRET } = require('./config');
const sqlite = require('sqlite');

function getAllFiles(dirPath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        
        // Check exclusions BEFORE checking if it's a directory
        if (
            file === 'node_modules' || 
            file.startsWith('.') || 
            file.endsWith('.db') || 
            file.includes('spawner.js') || 
            file.includes('main.js')
        ) {
            return;
        }

        if (fs.statSync(fullPath).isDirectory()) {
            arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
        } else {
            arrayOfFiles.push(fullPath);
        }
    });

    return arrayOfFiles;
}

let socketIoInstance = null;
let logs = [];
const files = getAllFiles(__dirname);

// Logger instance needs to be created before it's used
class Logger {
    /**
     * General-purpose log function (INFO level)
     */
    log(message, route = 'SYSTEM') {
        const level = 'INFO';
        const timestamp = new Date().toISOString();
        console.log(`[${route}] [${timestamp}] ${level}: ${message}`);
        
        const logEntry = { 
            timestamp: timestamp, 
            message: message, 
            level: level, 
            route: route 
        };
        
        logs.push(logEntry);
        if (logs.length > 500) logs.shift(); 

        if (socketIoInstance) {
            socketIoInstance.emit('newLog', logEntry);
        }
    }

    /**
     * Error log function (ERROR level)
     */
    error(message, route = 'SYSTEM') {
        const level = 'ERROR';
        const timestamp = new Date().toISOString();
        console.error(`[${route}] [${timestamp}] ${level}: ${message}`);
        
        const logEntry = { 
            timestamp: timestamp, 
            message: message, 
            level: level, 
            route: route 
        };
        
        logs.push(logEntry);
        if (logs.length > 500) logs.shift();

        if (socketIoInstance) {
            socketIoInstance.emit('newLog', logEntry);
        }
    }

    /**
     * Warning log function (WARN level)
     */
    warn(message, route = 'SYSTEM') {
        const level = 'WARN';
        const timestamp = new Date().toISOString();
        console.warn(`[${route}] [${timestamp}] ${level}: ${message}`);
        
        const logEntry = { 
            timestamp: timestamp, 
            message: message, 
            level: level, 
            route: route 
        };

        logs.push(logEntry);
        if (logs.length > 500) logs.shift();

        if (socketIoInstance) {
            socketIoInstance.emit('newLog', logEntry);
        }
    }
}

// Create logger instance at module level
const loggerInstance = new Logger();

let userDb;

async function loadUserDb() {
    const db = await sqlite.open({
        filename: 'users.db',
        driver: sqlite3.Database
    });
    return db;
}

loadUserDb().then((db) => {
    userDb = db;
    loggerInstance.log("User DB loaded for WebSocket auth.", "WEBSOCKET");
}).catch(err => {
    loggerInstance.error(`Failed to load user DB: ${err.message}`, "WEBSOCKET");
});

/**
 * Sets the initialized Socket.IO server instance for real-time logging.
 * This MUST be called once from the main server file (e.g., server.js).
 * @param {object} ioServer - The initialized Socket.IO server instance.
 */
function setSocketServer(ioServer) {
    socketIoInstance = ioServer;
    
    // Set up connection handler to send initial logs
    socketIoInstance.on('connection', async (socket) => {
        // Handle missing cookies gracefully
        const cookief = socket.handshake.headers.cookie;
        if (!cookief) {
            socket.disconnect();
            return;
        }
        const cookies = cookie.parse(cookief);
        let token = cookies.auth;

        if (!token) {
            socket.disconnect();
            return;
        }

        // Extract JWT from signed cookie string (removes 's:' prefix and signature suffix)
        if (token.startsWith('s:')) {
            token = token.slice(2); // Remove 's:' prefix
            const lastDotIndex = token.lastIndexOf('.');
            if (lastDotIndex !== -1) {
                token = token.slice(0, lastDotIndex); // Remove the cookie signature after the last dot
            }
        }

        // Ensure DB is loaded before querying
        if (!userDb) {
            loggerInstance.warn("Socket connection attempt before DB load.", "WEBSOCKET");
            socket.disconnect();
            return;
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const inDb = await userDb.get('SELECT * FROM users WHERE id = ?', decoded.id);
            
            if (!inDb || !(inDb.username === 'coops' || inDb.is_admin === 1)) {
                socket.disconnect();
                return;
            }

            loggerInstance.log('A user connected to WebSocket', 'WEBSOCKET');
            
            // Send the initial log history
            socket.emit('initialLogs', logs); 
            socket.emit('fileList', files);
            
            socket.on('requestFile', (name) => {
                try {
                    const fileContent = fs.readFileSync(name, 'utf8');
                    socket.emit('fileContent', { name: name, content: fileContent });
                } catch (err) {
                    loggerInstance.error(`Failed to read file ${name}: ${err.message}`, 'WEBSOCKET');
                }
            });

            socket.on('refresh', () => {
                process.exit(0);
            });

            // Handle array of commits sent by the client
            socket.on('saveChanges', (commits) => {
                if (!Array.isArray(commits)) {
                    // Fallback for single file save if client hasn't updated
                    if (arguments.length === 2 && typeof commits === 'string') {
                        const content = arguments[1];
                        try {
                            fs.writeFileSync(commits, content, 'utf8');
                            loggerInstance.log(`File ${commits} saved successfully.`, 'WEBSOCKET');
                        } catch (err) {
                            loggerInstance.error(`Failed to save file ${commits}: ${err.message}`, 'WEBSOCKET');
                        }
                        return;
                    }
                    loggerInstance.error("Invalid data format for saveChanges", 'WEBSOCKET');
                    return;
                }

                commits.forEach(commit => {
                    try {
                        fs.writeFileSync(commit.filepath, commit.code, 'utf8');
                        loggerInstance.log(`File ${commit.filepath} saved successfully.`, 'WEBSOCKET');
                    } catch (err) {
                        loggerInstance.error(`Failed to save file ${commit.filepath}: ${err.message}`, 'WEBSOCKET');
                    }
                });
            });

            socket.on('disconnect', () => {
                loggerInstance.log('A user disconnected from WebSocket', 'WEBSOCKET');
            });

        } catch (err) {
            loggerInstance.error(`Socket auth error: ${err.message}`, 'WEBSOCKET');
            socket.disconnect();
        }
    });
}

function createSlug(title) {
    if (!title) return '';
    return title.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function createGenreSlug(genreName) {
    if (!genreName) return '';
    return genreName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function fuzzySearch(query, allTitles, threshold = 0.2, genreFilter = null) {
    // 1. Validate Input
    if (!query || !Array.isArray(allTitles)) {
        loggerInstance.warn(`Search aborted. Query: "${query}", Titles: ${Array.isArray(allTitles) ? allTitles.length : 'Not Array'}`, "SEARCH_DEBUG");
        return [];
    }
    const results = [];
    const lowerQuery = query.toLowerCase();
    const lowerGenreFilter = genreFilter ? genreFilter.toLowerCase() : null;
    
    // Precompute genre filter slug
    let filterSlug = null;
    if (lowerGenreFilter) {
        filterSlug = createGenreSlug(lowerGenreFilter);
    }

    let checkedCount = 0;
    let genrePassedCount = 0;

    for (const title of allTitles) {
        // Genre Filtering
        if (filterSlug) {
            const genres = title.genres || [];
            if (!genres.some(g => createGenreSlug(g) === filterSlug)) {
                continue;
            }
        }
        genrePassedCount++;
        
        let bestMatch = 0;
        let matchedName = title.title;
        // Ensure searchableNames is valid
        const namesToCheck = (Array.isArray(title.searchableNames) && title.searchableNames.length > 0) 
            ? title.searchableNames 
            : [title.title];

        for (const name of namesToCheck) {
            if (!name) continue;
            const lowerName = name.toLowerCase();
            let score = 0;

            // Prioritize Exact > StartsWith > Includes > Fuzzy
            if (lowerName === lowerQuery) {
                score = 1.0;
            } else if (lowerName.startsWith(lowerQuery)) {
                score = 0.85;
            } else if (lowerName.includes(lowerQuery)) {
                score = 0.7;
            } else {
                score = stringSimilarity.compareTwoStrings(lowerQuery, lowerName);
            }

            if (score > bestMatch) {
                bestMatch = score;
                matchedName = name;
            }
        }

        // 2. Log first few comparisons to check logic
        if (checkedCount < 5) {
            loggerInstance.log(`[DEBUG] "${title.title}" score: ${bestMatch.toFixed(2)} vs "${query}"`, "SEARCH_DEBUG");
        }
        checkedCount++;

        if (bestMatch >= threshold) {
            results.push({
                ...title,
                similarityScore: bestMatch,
                matchedName: matchedName
            });
        }
    }

    // 3. Summary Log
    if (results.length === 0) {
        loggerInstance.warn(`Search yielded 0 results. Items checked: ${checkedCount} (Genre Passed: ${genrePassedCount}).`, "SEARCH_DEBUG");
        if (checkedCount > 0 && checkedCount < 5) {
             loggerInstance.log(`Debug hint: If items were checked but 0 returned, threshold (${threshold}) might be too high or logic mismatch.`, "SEARCH_DEBUG");
        }
    } else {
        // loggerInstance.log(`Search found ${results.length} matches. Top match: "${results[0].title}" (${results[0].similarityScore.toFixed(2)})`, "SEARCH_DEBUG");
    }

    return results.sort((a, b) => b.similarityScore - a.similarityScore);
}

module.exports = {
    fuzzySearch,
    createSlug,
    createGenreSlug,
    logger: loggerInstance,
    log: loggerInstance.log.bind(loggerInstance),
    warn: loggerInstance.warn.bind(loggerInstance),
    error: loggerInstance.error.bind(loggerInstance),
    setSocketServer
};
// --- END OF FILE utils.js ---