const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('./database');
const path = require('path');

const clients = new Map(); // accountId -> { client, status }
let io = null;

function setIO(socketIO) {
  io = socketIO;
}

function emit(event, data) {
  if (io) io.emit(event, data);
}

async function createClient(accountId, label) {
  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === 'connected' || existing.status === 'connecting') {
      return existing;
    }
    try { await existing.client.destroy(); } catch (_) {}
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: path.join(__dirname, 'sessions'),
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
    restartOnAuthFail: true,
  });

  const entry = { client, status: 'connecting', label };
  clients.set(accountId, entry);

  db.prepare(
    "INSERT INTO wa_accounts (id, label, status) VALUES (?, ?, 'connecting') ON CONFLICT(id) DO UPDATE SET status='connecting'"
  ).run(accountId, label);

  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      emit('qr', { accountId, qr: qrDataUrl });
      updateStatus(accountId, 'qr');
    } catch (err) {
      console.error('QR generation error:', err);
    }
  });

  client.on('ready', async () => {
    entry.status = 'connected';
    updateStatus(accountId, 'connected');
    try {
      const info = client.info;
      const phone = info?.wid?.user || '';
      db.prepare('UPDATE wa_accounts SET phone = ?, status = ? WHERE id = ?')
        .run(phone, 'connected', accountId);
      emit('account-ready', { accountId, phone, label });
    } catch (err) {
      console.error('Ready handler error:', err);
    }
  });

  client.on('authenticated', () => {
    entry.status = 'authenticated';
    updateStatus(accountId, 'authenticated');
  });

  client.on('auth_failure', () => {
    entry.status = 'disconnected';
    updateStatus(accountId, 'disconnected');
    emit('account-status', { accountId, status: 'auth_failure' });
  });

  client.on('disconnected', () => {
    entry.status = 'disconnected';
    updateStatus(accountId, 'disconnected');
    emit('account-status', { accountId, status: 'disconnected' });
    // Auto-reconnect after 5s
    setTimeout(() => {
      if (clients.has(accountId) && clients.get(accountId).status === 'disconnected') {
        console.log(`Auto-reconnecting account ${accountId}...`);
        createClient(accountId, label).catch(console.error);
      }
    }, 5000);
  });

  client.on('message', async (msg) => {
    await handleIncomingMessage(accountId, msg, false);
  });

  client.on('message_create', async (msg) => {
    if (msg.fromMe) {
      await handleIncomingMessage(accountId, msg, true);
    }
  });

  client.initialize().catch((err) => {
    console.error(`Client init error for ${accountId}:`, err.message);
    entry.status = 'disconnected';
    updateStatus(accountId, 'disconnected');
  });

  return entry;
}

async function handleIncomingMessage(accountId, msg, fromMe) {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    const messageData = {
      id: msg.id._serialized || `${accountId}_${Date.now()}_${Math.random()}`,
      accountId,
      chatId: chat.id._serialized,
      chatName: chat.name || contact.pushname || contact.number,
      fromMe,
      author: fromMe ? 'me' : (contact.pushname || contact.number || msg.from),
      body: msg.body,
      timestamp: msg.timestamp,
      type: msg.type,
    };

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageData.id,
      accountId,
      messageData.chatId,
      fromMe ? 1 : 0,
      messageData.author,
      messageData.body,
      messageData.timestamp
    );

    emit('new-message', messageData);
  } catch (err) {
    console.error('Message handler error:', err.message);
  }
}

function updateStatus(accountId, status) {
  db.prepare('UPDATE wa_accounts SET status = ? WHERE id = ?').run(status, accountId);
  emit('account-status', { accountId, status });
}

async function getChats(accountId) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Account not connected');
  }
  const chats = await entry.client.getChats();
  return chats.slice(0, 100).map((c) => ({
    id: c.id._serialized,
    name: c.name,
    lastMessage: c.lastMessage
      ? {
          body: c.lastMessage.body,
          timestamp: c.lastMessage.timestamp,
          fromMe: c.lastMessage.fromMe,
        }
      : null,
    unreadCount: c.unreadCount,
    isGroup: c.isGroup,
  }));
}

async function getMessages(accountId, chatId, limit = 50) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') {
    // Fall back to DB messages
    return db.prepare(
      'SELECT * FROM messages WHERE account_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(accountId, chatId, limit).reverse();
  }
  try {
    const chat = await entry.client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    // Persist to DB
    for (const msg of messages) {
      try {
        const contact = await msg.getContact();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, account_id, chat_id, from_me, author, body, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          msg.id._serialized,
          accountId,
          chatId,
          msg.fromMe ? 1 : 0,
          msg.fromMe ? 'me' : (contact.pushname || contact.number || msg.from),
          msg.body,
          msg.timestamp
        );
      } catch (_) {}
    }
    return messages.map((m) => ({
      id: m.id._serialized,
      fromMe: m.fromMe,
      body: m.body,
      timestamp: m.timestamp,
      type: m.type,
    }));
  } catch (err) {
    console.error('getMessages error:', err.message);
    return db.prepare(
      'SELECT * FROM messages WHERE account_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(accountId, chatId, limit).reverse();
  }
}

async function sendMessage(accountId, chatId, message) {
  const entry = clients.get(accountId);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Account not connected');
  }
  const result = await entry.client.sendMessage(chatId, message);
  return result;
}

async function disconnectAccount(accountId) {
  const entry = clients.get(accountId);
  if (entry) {
    try { await entry.client.destroy(); } catch (_) {}
    clients.delete(accountId);
  }
  db.prepare("UPDATE wa_accounts SET status = 'disconnected' WHERE id = ?").run(accountId);
}

function getAccountStatus(accountId) {
  const entry = clients.get(accountId);
  return entry ? entry.status : 'disconnected';
}

async function restorePersistedSessions() {
  const accounts = db.prepare("SELECT * FROM wa_accounts").all();
  console.log(`Restoring ${accounts.length} WhatsApp sessions...`);
  for (const account of accounts) {
    try {
      await createClient(account.id, account.label);
    } catch (err) {
      console.error(`Failed to restore session ${account.id}:`, err.message);
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
