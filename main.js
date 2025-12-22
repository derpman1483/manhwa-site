// --- START OF FILE main.js ---

const express = require('express');
const http = require('http'); // 1. Import 'http' module
const { Server } = require('socket.io'); // 2. Import Socket.IO Server
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config');
const { loadDbs } = require('./db');
async function loadUserDb() {
    const { userDb: loadedUserDb } = await loadDbs();
    return loadedUserDb;
}
let userDb;
loadUserDb().then((db) => {
    userDb = db;
});
const cookieParser = require('cookie-parser');
const { 
   COOKIE_SECRET,
   PORT
} = require('./config');
// 3. Import setSocketServer along with log functions
const { logger, setSocketServer } = require('./utils'); 
const { auth, router: routes } = require('./mangaroutes'); 
const { main: cacheMain } = require('./cache');

const app = express();
// 4. Create an HTTP server instance using the Express app
const server = http.createServer(app); 
// 5. Initialize Socket.IO and attach it to the HTTP server
const io = new Server(server); 
async function isAuthed(req, res, next) {
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
        if(!(inDb.username==='coops'||inDb.is_admin===1)){
            return res.redirect('/');
        }
        next();
    } catch (err) {
        logger.error(`JWT verification failed: ${err.message}`, "main");
        return res.redirect('/login');
    }
}
// 6. Pass the Socket.IO instance to utils.js
setSocketServer(io); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));


// Serve other routes
app.get('/admin.html',auth,isAuthed, (req, res) => { // <-- CHANGED FROM /admin.html
    const adminHtmlPath = path.join(__dirname, 'public', 'admin.html'); // <-- CHANGED FILE NAME

    logger.log("--- DEBUG CONSOLE: Handler reached. Path check:", adminHtmlPath, 'main'); 
    
    const fs = require('fs');
    if (!fs.existsSync(adminHtmlPath)) {
        console.error("--- DEBUG CONSOLE: FILE DOES NOT EXIST AT PATH ---");
        return res.status(500).send('Internal Server Error: Console HTML file missing.');
    }

    // Use the reliable fs.readFileSync method for now to eliminate res.sendFile issues
    try {
        const fileContent = fs.readFileSync(adminHtmlPath, 'utf8');
        logger.log("SUCCESS: File content length:", fileContent.length, 'main'); 
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(fileContent);
    } catch (err) {
        logger.error(`--- CRITICAL FAILURE READING FILE --- Error: ${err.code}`, 'main'); 
        res.status(500).send(`Error accessing file: ${err.code}`);
    }
});

// REMEMBER TO RE-ADD app.use(auth, ...) IF YOU WANT TO PROTECT IT:
// app.get('/console.html', auth, (req, res) => { ... });
app.use('/', routes);
app.use(express.static('public'));
async function main() {
    await cacheMain();
    
    // 7. Start the HTTP server instead of the Express app
    server.listen(PORT, "0.0.0.0", () => {
        logger.log(`Server is running on http://0.0.0.0:${PORT}`, 'main');
    });
}

main();
// --- END OF FILE main.js ---