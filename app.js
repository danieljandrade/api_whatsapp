import 'dotenv/config'
import express from 'express'
import nodeCleanup from 'node-cleanup'
import routes from './routes.js'
import { init, cleanup } from './whatsapp.js'
import cors from 'cors'
import { initDb } from './db.js';

const app = express()

const host = process.env.HOST || undefined
const port = parseInt(process.env.PORT ?? 8000)

app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use('/', routes)

const listenerCallback = async () => {
    await initDb(); // Adicione esta linha para inicializar o SQLite
    init();
    console.log(`Server is listening on http://${host ? host : 'localhost'}:${port}`);
};

if (host) {
    app.listen(port, host, listenerCallback)
} else {
    app.listen(port, listenerCallback)
}

nodeCleanup(cleanup)

export default app
