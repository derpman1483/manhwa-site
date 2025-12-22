const express = require('express');
const http = require('http');
const { Server } = require('socket.io'); 
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
const { logger, setSocketServer } = require('./utils'); 
const { auth, router: routes } = require('./mangaroutes'); 
const { main: cacheMain } = require('./cache');

const app = express();
const server = http.createServer(app); 
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
setSocketServer(io); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));

app.use('/', routes);
app.use(express.static('public'));
async function main() {
    await cacheMain();
    server.listen(PORT, "0.0.0.0", () => {
        logger.log(`Server is running on http://0.0.0.0:${PORT}`, 'main');
    });
}

main();
