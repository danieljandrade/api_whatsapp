// força usar require dentro de módulo ESM
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const pino = require('pino')
const qrcode = require('qrcode-terminal')
const axios = require('axios')

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys')

import fs from 'fs'
import path from 'path'
import { toDataURL } from 'qrcode'

import __dirname from './dirname.js'
import response from './response.js'
import { saveMessage } from './db.js'


// ----- MAPA DE SESSÕES -----

/**
 * sessions: Map<sessionId, { sock }>
 */
const sessions = new Map()

// pasta base para auth (uma pasta por sessão)
const AUTH_BASE_DIR = path.join(__dirname, 'sessions')

// garante que a pasta base existe
if (!fs.existsSync(AUTH_BASE_DIR)) {
    fs.mkdirSync(AUTH_BASE_DIR, { recursive: true })
}

// ----- HELPERS BÁSICOS -----

const isSessionExists = (sessionId) => sessions.has(sessionId)

/**
 * Converte número em JID do WhatsApp
 * ex: 553496651771 -> 553496651771@s.whatsapp.net
 */
const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) return phone
    const formatted = phone.replace(/\D/g, '')
    return `${formatted}@s.whatsapp.net`
}

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) return group
    const formatted = group.replace(/[^\d-]/g, '')
    return `${formatted}@g.us`
}

// baixa URL e devolve Buffer
const downloadUrlToBuffer = async (url) => {
    const resp = await axios.get(url, { responseType: 'arraybuffer' })
    return Buffer.from(resp.data, 'binary')
}

// ----- INICIAR / RECONECTAR UMA SESSÃO -----

/**
 * Cria / inicia uma sessão WhatsApp.
 * Mantém a assinatura antiga: createSession(sessionId, isLegacy, res)
 * - sessionId: ID (string) que você passa no ?id=...
 * - isLegacy: ignorado (sempre multi-device)
 * - res: response HTTP (para devolver QR em base64 quando criar via /sessions/add)
 */
const startWhatsAppSession = async (sessionId, res = null) => {
    // se já existir no mapa, só retorna
    if (sessions.has(sessionId)) {
        return sessions.get(sessionId).sock
    }

    const sessionAuthDir = path.join(AUTH_BASE_DIR, `auth_${sessionId}`)

    const { state, saveCreds } = await useMultiFileAuthState(sessionAuthDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        logger: pino({ level: 'info' }),
        auth: state,
        version,
        printQRInTerminal: false // vamos usar qrcode-terminal manualmente
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log(`\n📱 Escaneie o QR abaixo para conectar à sessão "${sessionId}":`)
            qrcode.generate(qr, { small: true })

            if (res && !res.headersSent) {
                try {
                    const qrDataUrl = await toDataURL(qr)
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qr: qrDataUrl })
                } catch (e) {
                    console.error('Erro ao gerar QR DATA URL:', e)
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }
        }

        if (connection === 'open') {
            console.log(`✅ Sessão "${sessionId}" conectada ao WhatsApp!`)

            if (res && !res.headersSent) {
                response(res, 200, true, 'Session connected.', { sessionId })
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut

            console.log(`⚠️ Conexão da sessão "${sessionId}" fechada. StatusCode:`, statusCode)

            if (!loggedOut) {
                console.log(`Tentando reconectar sessão "${sessionId}"...`)
                // REMOVE a sessão do mapa antes de recriar
                sessions.delete(sessionId)

                startWhatsAppSession(sessionId).catch((err) =>
                    console.error(`Erro ao reconectar sessão "${sessionId}"`, err)
                )
            } else {
                console.log(
                    `Sessão "${sessionId}" expirada / logout. Apague a pasta auth_${sessionId} para logar de novo.`
                )
                deleteSession(sessionId)
            }
        }
    })


    sessions.set(sessionId, { sock })
    return sock
}

// compat com código antigo: createSession(sessionId, isLegacy, res)
const createSession = async (sessionId, isLegacy = false, res = null) => {
    return startWhatsAppSession(sessionId, res)
}

/**
 * Retorna a sessão pelo ID
 */
const getSession = (sessionId) => {
    const session = sessions.get(sessionId) ?? null
    return session ? session.sock : null
}

/**
 * Remove sessão (do mapa + apaga pasta de auth)
 */
const deleteSession = (sessionId, isLegacy = false) => {
    const sessionAuthDir = path.join(AUTH_BASE_DIR, `auth_${sessionId}`)
    sessions.delete(sessionId)

    try {
        fs.rmSync(sessionAuthDir, { recursive: true, force: true })
    } catch {
        // ignore
    }

    console.log(`🗑️ Sessão "${sessionId}" removida`)
}

// ----- LISTA DE CHATS (aqui vamos simplificar) -----

const getChatList = (sessionId, isGroup = false) => {
    // Por simplicidade, não estamos mantendo store em memória.
    // Se precisar no futuro, dá pra integrar makeInMemoryStore aqui.
    // Por enquanto, retornamos lista vazia para evitar erros.
    return []
}

// ----- VERIFICAR SE NÚMERO / GRUPO EXISTE -----

/**
 * @param {any} session socket da sessão
 * @param {string} jid
 * @param {boolean} isGroup
 */
const isExists = async (session, jid, isGroup = false) => {
    try {
        if (isGroup) {
            const data = await session.groupMetadata(jid)
            return Boolean(data.id)
        }

        const [result] = await session.onWhatsApp(jid)
        return result?.exists
    } catch (e) {
        console.error('Erro em isExists:', e)

        // se for erro de conexão fechada (428 / Connection Closed), repassa o erro
        const statusCode = e?.output?.statusCode
        const message = e?.output?.payload?.message

        if (statusCode === 428 || message === 'Connection Closed') {
            throw e
        }

        // outros erros: assume que não existe mesmo
        return false
    }
}


// ----- ENVIO DE MENSAGENS (texto / pdf / imagem) -----

/**
 * Envia mensagem e grava no SQLite
 *
 * message pode ser:
 * 1) { text: '...' }
 * 2) { document: { url }, mimetype, fileName }
 * 3) { image: { url }, caption }
 */
const sendMessage = async (session, receiver, message, delayMs = 500) => {
    try {
        await delay(parseInt(delayMs))

        let payload = { ...message }
        let url = ''

        // Documento (ex: PDF)
        if (message.document && message.document.url) {
            url = message.document.url
            const buffer = await downloadUrlToBuffer(url)

            payload = {
                document: buffer,
                mimetype: message.mimetype || 'application/octet-stream',
                fileName: message.fileName || 'file'
            }
        }

        // Imagem
        else if (message.image && message.image.url) {
            url = message.image.url
            const buffer = await downloadUrlToBuffer(url)

            payload = {
                image: buffer,
                caption: message.caption || ''
            }
        }

        // Texto
        else if (message.text) {
            payload = { text: message.text }
        }

        const result = await session.sendMessage(receiver, payload)

        const phone = session.user?.id || ''
        const name = session.user?.name || ''
        const text = message.text || message.caption || ''

        await saveMessage(text, phone, name, url, receiver)
        console.log('Msg sent:', text || '[media]', 'For phone number:', receiver)

        return result
    } catch (error) {
        console.error('Error during sendMessage:', error)
        return Promise.reject(null)
    }
}

// ----- INIT / CLEANUP -----

/**
 * Na inicialização do app, tenta reabrir todas as sessões
 * que tiverem pasta auth_<sessionId> na pasta sessions.
 */
const init = () => {
    if (!fs.existsSync(AUTH_BASE_DIR)) return

    const dirs = fs.readdirSync(AUTH_BASE_DIR, { withFileTypes: true })
    for (const dirent of dirs) {
        if (!dirent.isDirectory()) continue
        if (!dirent.name.startsWith('auth_')) continue

        const sessionId = dirent.name.substring('auth_'.length)
        console.log('🔁 Recarregando sessão ao iniciar:', sessionId)
        startWhatsAppSession(sessionId).catch((e) => {
            console.error('Falha ao recriar sessão', sessionId, e)
        })
    }
}

/**
 * Cleanup: aqui não precisamos fazer muita coisa porque usamos useMultiFileAuthState
 * e o próprio Baileys já salva as creds. Mantemos só para compatibilidade.
 */
const cleanup = () => {
    console.log('Running cleanup before exit.')
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    getChatList,
    isExists,
    sendMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init
}
