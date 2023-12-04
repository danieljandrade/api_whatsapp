import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_PATH = './whatsapp.db';

async function initDb() {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            name TEXT NOT NULL,
            receiver TEXT NOT NULL,
            text TEXT DEFAULT '',
            link TEXT DEFAULT '',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

async function saveMessage(text, phone, name, link, receiver) {
    const db = await initDb();
    const timestamp = new Date();
    const localTimestamp = timestamp.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
      });
    const query = `INSERT INTO messages (text, phone, name, link, timestamp, receiver) VALUES (?, ?, ?, ?, ?, ?)`;
    await db.run(query, [text, phone, name, link, localTimestamp, receiver]);
}


async function getAllMessages() {
    const db = await initDb();
    const messages = await db.all('SELECT * FROM messages');
    return messages;
}

export { initDb, saveMessage, getAllMessages };
