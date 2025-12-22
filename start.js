const parsing = require('./parsing');
const {loadDbs} = require('./db');
const {loadCache,getCache} = require('./cache');
async function main(){
    const { shojoDb, toongodDb,mangaDb } = await loadDbs();
    await parsing.fetchShojo(shojoDb);
    await parsing.fetchToonGod(toongodDb);
    await parsing.fetchManga(mangaDb,shojoDb,toongodDb);
    await loadCache();
    const {toongod,shojo,manga} = getCache();
    console.log(`Done, fetched ${shojo.length} shojo, ${toongod.length} toongod, and ${manga.length} manga titles.`);
}
main();
