const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('./database');

const clients = new Map(); // accountId -> { client, status, label }
const qrCache = new Map(); // accountId -> { qr, generatedAt }
let io = null;

function setIO(socketIO) { io = socketIO; }
function emit(event, data) { if (io) io.emit(event, data); }

async function createClient(accountId, label) {
  if (clients.has(accountId)) {
    const old = clients.get(accountId);
    try { await old.client.destroy(); } catch (_) {}
    clients.delete(accountId);
  }

  const entry = { client: null, status: 'connecting', label };
  clients.set(accountId, entry);

  db.prepare(
    "INSERT INTO wa_accounts (id, label, status) VALUES (?, ?, 'connecting') ON CONFLICT(id) DO UPDATE SET status='connecting', label=?"
  ).run(accountId, label, label);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: '/var/www/wa-manager/sessions',
    }),
    puppeteer: {
      executablePath: '/usr/bin/chromium-browser',
      userDataDir: '/tmp/wa-' + accountId + '-' + Date.now(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  entry.client = client;

  client.on('qr', async (qr) => {
    try {
      const url = await qrcode.toDataURL(qr);
      qrCache.set(accountId, { qr: url, generatedAt: Date.now() });
      emit('qr', { accountId, qr: url });
      entry.status = 'qr';
      db.prepare("UPDATE wa_accounts SET status='qr' WHERE id=?").run(accountId);
      emit('account-status', { accountId, status: 'qr' });
    } catch (err) {
      console.error('QR error:', err);
    }
  });

  client.on('ready', async () => {
    entry.status = 'connected';
    qrCache.delete(accountId);
    try {
      const phone = client.info?.wid?.user || '';
      db.prepare("UPDATE wa_accounts SET phone=?, status='connected' WHERE id=?").run(phone, accountId);
      emit('account-ready', { accountId, phone, label });
      emit('account-status', { accountId, status: 'connected' });
    } catch (err) {
      console.error('Ready handler error:', err);
    }
  });

  client.on('authenticated', () => {
    entry.status = 'authenticated';
    db.prepare("UPDATE wa_accounts SET status='authenticated' WHERE id=?").run(accountId);
    emit('account-status', { accountId, status: 'authenticated' });
  });

  client.on('auth_failure', () => {
    entry.status = 'disconnected';
    qrCache.delete(accountId);
    db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
    emit('account-status', { accountId, status: 'auth_failure' });
  });

  client.on('disconnected', () => {
    entry.status = 'disconnected';
    qrCache.delete(accountId);
    db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
    emit('account-status', { accountId, status: 'disconnected' });
    setTimeout(() => {
      if (clients.has(accountId) && clients.get(accountId).status === 'disconnected') {
        createClient(accountId, label).catch(console.error);
      }
    }, 5000);
  });

  client.on('message', async (msg) => handleMessage(accountId, msg, false));
  client.on('message_create', async (msg) => { if (msg.fromMe) handleMessage(accountId, msg, true); });

  client.initialize().catch((err) => {
    console.error(`Client init error [${accountId}]:`, err.message);
    entry.status = 'disconnected';
    db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
    emit('account-status', { accountId, status: 'disconnected' });
  });

  return entry;
}

async function handleMessage(accountId, msg, fromMe) {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const msgId = msg.id._serialized || `${accountId}_${Date.now()}_${Math.random()}`;
    const chatId = chat.id._serialized;
    const author = fromMe ? 'me' : (contact.pushname || contact.number || msg.from);
    const chatName = chat.name || contact.pushname || contact.number;

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, accountId, chatId, fromMe ? 1 : 0, author, msg.body, msg.timestamp);

    emit('new-message', { id: msgId, accountId, chatId, chatName, fromMe, author, body: msg.body, timestamp: msg.timestamp });
  } catch (err) {
    console.error('Message handler error:', err.message);
  }
}

function getQR(accountId) {
  const cached = qrCache.get(accountId);
  if (!cached) return null;
  if (Date.now() - cached.generatedAt > 60000) { qrCache.delete(accountId); return null; }
  return cached.qr;
}

async function getChats(accountId) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') throw new Error('Account not connected');
  const chats = await entry.client.getChats();
  return chats.slice(0, 100).map((c) => ({
    id: c.id._serialized, name: c.name,
    lastMessage: c.lastMessage
      ? { body: c.lastMessage.body, timestamp: c.lastMessage.timestamp, fromMe: c.lastMessage.fromMe }
      : null,
    unreadCount: c.unreadCount, isGroup: c.isGroup,
  }));
}

async function getMessages(accountId, chatId, limit = 50) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') {
    return db.prepare(
      'SELECT * FROM messages WHERE account_id=? AND chat_id=? ORDER BY timestamp DESC LIMIT ?'
    ).all(accountId, chatId, limit).reverse();
  }
  try {
    const chat = await entry.client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    for (const m of messages) {
      try {
        const contact = await m.getContact();
        db.prepare('INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(m.id._serialized, accountId, chatId, m.fromMe ? 1 : 0,
            m.fromMe ? 'me' : (contact.pushname || contact.number || m.from), m.body, m.timestamp);
      } catch (_) {}
    }
    return messages.map((m) => ({ id: m.id._serialized, fromMe: m.fromMe, body: m.body, timestamp: m.timestamp, type: m.type, ack: m.ack }));
  } catch (err) {
    return db.prepare(
      'SELECT * FROM messages WHERE account_id=? AND chat_id=? ORDER BY timestamp DESC LIMIT ?'
    ).all(accountId, chatId, limit).reverse();
  }
}

async function sendMessage(accountId, chatId, message) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') throw new Error('Account not connected');
  return entry.client.sendMessage(chatId, message);
}

async function disconnectAccount(accountId) {
  const entry = clients.get(accountId);
  if (entry) {
    try { await entry.client.destroy(); } catch (_) {}
    clients.delete(accountId);
  }
  qrCache.delete(accountId);
  db.prepare("UPDATE wa_accounts SET status='disconnected' WHERE id=?").run(accountId);
}

function getAccountStatus(accountId) {
  return clients.get(accountId)?.status ?? 'disconnected';
}

async function restorePersistedSessions() {
  const accounts = db.prepare('SELECT * FROM wa_accounts').all();
  console.log(`Restoring ${accounts.length} WhatsApp session(s)...`);
  for (const acc of accounts) {
    try { await createClient(acc.id, acc.label); }
    catch (err) { console.error(`Failed to restore ${acc.id}:`, err.message); }
  }
}

module.exports = {
  setIO, createClient, getChats, getMessages,
  sendMessage, disconnectAccount, getAccountStatus,
  getQR, restorePersistedSessions, clients,
};
