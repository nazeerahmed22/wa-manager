const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');
const db = require('./database');
const path = require('path');
const fs = require('fs');

const clients = new Map(); // accountId -> { sock, chats, contacts, status, label }
let io = null;

function setIO(socketIO) { io = socketIO; }
function emit(event, data) { if (io) io.emit(event, data); }

function extractText(msg) {
  const m = msg?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    (m.audioMessage ? '[voice message]' : '') ||
    (m.imageMessage ? '[image]' : '') ||
    (m.videoMessage ? '[video]' : '') ||
    (m.documentMessage ? '[document]' : '') ||
    (m.stickerMessage ? '[sticker]' : '') ||
    ''
  );
}

async function createClient(accountId, label) {
  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === 'connected' || existing.status === 'connecting') return existing;
    try { existing.sock.ws?.close(); } catch (_) {}
  }

  const sessDir = path.join(__dirname, 'sessions', accountId);
  fs.mkdirSync(sessDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessDir);

  let version = [2, 3000, 1015901307];
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (_) {}

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['WA Manager', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const chats = new Map();
  const contacts = new Map();
  const entry = { sock, chats, contacts, status: 'connecting', label };
  clients.set(accountId, entry);

  db.prepare(
    "INSERT INTO wa_accounts (id, label, status) VALUES (?, ?, 'connecting') ON CONFLICT(id) DO UPDATE SET status='connecting', label=?"
  ).run(accountId, label, label);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const url = await qrcode.toDataURL(qr);
        emit('qr', { accountId, qr: url });
        entry.status = 'qr';
        db.prepare("UPDATE wa_accounts SET status='qr' WHERE id=?").run(accountId);
        emit('account-status', { accountId, status: 'qr' });
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 500;
      const loggedOut = code === DisconnectReason.loggedOut;

      entry.status = 'disconnected';
      db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
      emit('account-status', { accountId, status: 'disconnected' });

      if (!loggedOut) {
        console.log(`Reconnecting ${accountId} in 5s...`);
        setTimeout(() => createClient(accountId, label).catch(console.error), 5000);
      } else {
        clients.delete(accountId);
        emit('account-status', { accountId, status: 'logged_out' });
      }
    } else if (connection === 'open') {
      entry.status = 'connected';
      const rawId = sock.user?.id || '';
      const phone = rawId.split(':')[0].split('@')[0];
      db.prepare("UPDATE wa_accounts SET phone=?, status='connected' WHERE id=?").run(phone, accountId);
      emit('account-ready', { accountId, phone, label });
      emit('account-status', { accountId, status: 'connected' });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', (cs) => {
    for (const c of cs) {
      const name = c.name || c.notify || c.id.split('@')[0];
      contacts.set(c.id, name);
      const chat = chats.get(c.id);
      if (chat) { chat.name = name; chats.set(c.id, chat); }
    }
  });

  sock.ev.on('contacts.update', (cs) => {
    for (const c of cs) {
      if (c.name || c.notify) {
        const name = c.name || c.notify;
        contacts.set(c.id, name);
        const chat = chats.get(c.id);
        if (chat) { chat.name = name; chats.set(c.id, chat); }
      }
    }
  });

  sock.ev.on('chats.upsert', (cs) => {
    for (const c of cs) {
      if (!chats.has(c.id)) {
        chats.set(c.id, {
          id: c.id,
          name: contacts.get(c.id) || c.name || c.id.split('@')[0],
          lastMessage: null,
          unreadCount: c.unreadCount || 0,
          isGroup: c.id.endsWith('@g.us'),
        });
      }
    }
  });

  sock.ev.on('chats.update', (cs) => {
    for (const c of cs) {
      const existing = chats.get(c.id);
      if (existing && c.unreadCount !== undefined) {
        existing.unreadCount = c.unreadCount;
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const body = extractText(msg);
      if (!body) continue;

      const fromMe = !!msg.key.fromMe;
      const ts = Number(msg.messageTimestamp);
      const contactName = contacts.get(jid) || jid.split('@')[0];

      // Update in-memory chat
      const chat = chats.get(jid) || {
        id: jid, name: contactName, lastMessage: null,
        unreadCount: 0, isGroup: jid.endsWith('@g.us'),
      };
      chat.lastMessage = { body, timestamp: ts, fromMe };
      if (!fromMe) chat.unreadCount = (chat.unreadCount || 0) + 1;
      chats.set(jid, chat);

      // Persist to DB
      const msgId = msg.key.id || `${accountId}_${ts}_${Math.random()}`;
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(msgId, accountId, jid, fromMe ? 1 : 0, fromMe ? 'me' : contactName, body, ts);
      } catch (_) {}

      emit('new-message', {
        id: msgId, accountId, chatId: jid,
        chatName: chat.name, fromMe,
        author: fromMe ? 'me' : contactName,
        body, timestamp: ts,
      });
    }
  });

  return entry;
}

async function getChats(accountId) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') throw new Error('Account not connected');

  return [...entry.chats.values()]
    .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0))
    .slice(0, 100);
}

async function getMessages(accountId, chatId, limit = 50) {
  // Always return from DB first (messages.upsert persists everything)
  const rows = db.prepare(
    'SELECT * FROM messages WHERE account_id=? AND chat_id=? ORDER BY timestamp DESC LIMIT ?'
  ).all(accountId, chatId, limit).reverse();

  if (rows.length) return rows;

  // If DB empty, try fetching from WhatsApp
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') return rows;

  try {
    const result = await entry.sock.loadMessages(chatId, limit, undefined);
    const msgs = (result?.messages || [])
      .map(m => ({
        id: m.key.id,
        fromMe: !!m.key.fromMe,
        body: extractText(m),
        timestamp: Number(m.messageTimestamp),
        type: 'chat',
      }))
      .filter(m => m.body);

    for (const m of msgs) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(m.id, accountId, chatId, m.fromMe ? 1 : 0,
          m.fromMe ? 'me' : chatId.split('@')[0], m.body, m.timestamp);
      } catch (_) {}
    }
    return msgs;
  } catch (err) {
    console.error('loadMessages error:', err.message);
    return rows;
  }
}

async function sendMessage(accountId, chatId, message) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') throw new Error('Account not connected');
  return entry.sock.sendMessage(chatId, { text: message });
}

async function disconnectAccount(accountId) {
  const entry = clients.get(accountId);
  if (entry) {
    try { await entry.sock.logout(); } catch (_) {}
    clients.delete(accountId);
  }
  db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
}

function getAccountStatus(accountId) {
  const entry = clients.get(accountId);
  return entry ? entry.status : 'disconnected';
}

async function restorePersistedSessions() {
  const accounts = db.prepare('SELECT * FROM wa_accounts').all();
  console.log(`Restoring ${accounts.length} WhatsApp session(s)...`);
  for (const acc of accounts) {
    try {
      await createClient(acc.id, acc.label);
    } catch (err) {
      console.error(`Failed to restore session ${acc.id}:`, err.message);
    }
  }
}

module.exports = {
  setIO,
  createClient,
  getChats,
  getMessages,
  sendMessage,
  disconnectAccount,
  getAccountStatus,
  restorePersistedSessions,
  clients,
};
