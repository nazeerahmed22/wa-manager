require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const { randomUUID } = require('crypto');

const db = require('./database');
const authRouter = require('./auth');
const wa = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

wa.setIO(io);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

// Auth routes
app.use('/api/auth', authRouter);

// WhatsApp accounts
app.get('/api/whatsapp/accounts', requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM wa_accounts ORDER BY created_at').all();
  const result = accounts.map((a) => ({
    ...a,
    status: wa.getAccountStatus(a.id),
  }));
  res.json(result);
});

app.post('/api/whatsapp/connect', requireAuth, requireOwner, async (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Label is required' });
    const accountId = randomUUID();
    await wa.createClient(accountId, label);
    res.json({ accountId, status: 'connecting', message: 'Poll GET /api/whatsapp/qr/:accountId for QR code' });
  } catch (err) {
    console.error('Connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// REST QR polling endpoint — fallback for when WebSocket is unavailable (e.g. Railway)
app.get('/api/whatsapp/qr/:accountId', requireAuth, requireOwner, (req, res) => {
  const { accountId } = req.params;
  const status = wa.getAccountStatus(accountId);

  if (status === 'connected') {
    return res.json({ status: 'connected' });
  }

  const qr = wa.getQR(accountId);
  if (qr) {
    return res.json({ status: 'qr', qr });
  }

  // Still initialising or QR not yet generated
  res.json({ status: status || 'connecting', qr: null });
});

app.post('/api/whatsapp/disconnect/:accountId', requireAuth, requireOwner, async (req, res) => {
  try {
    await wa.disconnectAccount(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/whatsapp/accounts/:accountId', requireAuth, requireOwner, async (req, res) => {
  try {
    const { accountId } = req.params;
    await wa.disconnectAccount(accountId);
    db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM wa_accounts WHERE id = ?').run(accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat routes
app.get('/api/chats/:accountId', requireAuth, async (req, res) => {
  try {
    const chats = await wa.getChats(req.params.accountId);
    res.json(chats);
  } catch (err) {
    // Return DB-cached chats on error
    const rows = db.prepare(`
      SELECT chat_id, MAX(body) as last_body, MAX(timestamp) as last_ts,
             SUM(CASE WHEN is_read = 0 AND from_me = 0 THEN 1 ELSE 0 END) as unread
      FROM messages WHERE account_id = ?
      GROUP BY chat_id ORDER BY last_ts DESC
    `).all(req.params.accountId);
    res.json(rows.map((r) => ({
      id: r.chat_id,
      name: r.chat_id,
      lastMessage: { body: r.last_body, timestamp: r.last_ts },
      unreadCount: r.unread,
    })));
  }
});

app.get('/api/messages/:accountId/:chatId', requireAuth, async (req, res) => {
  try {
    const { accountId, chatId } = req.params;
    const decoded = decodeURIComponent(chatId);
    const messages = await wa.getMessages(accountId, decoded);
    // Mark as read in DB
    db.prepare('UPDATE messages SET is_read = 1 WHERE account_id = ? AND chat_id = ? AND from_me = 0')
      .run(accountId, decoded);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/send', requireAuth, async (req, res) => {
  try {
    const { accountId, chatId, message } = req.body;
    if (!accountId || !chatId || !message)
      return res.status(400).json({ error: 'accountId, chatId, and message required' });
    await wa.sendMessage(accountId, chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io auth
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.user.email}`);

  // If client connects while a QR is waiting, replay it immediately
  socket.on('watch-qr', ({ accountId }) => {
    const qr = wa.getQR(accountId);
    if (qr) socket.emit('qr', { accountId, qr });
    else socket.emit('account-status', { accountId, status: wa.getAccountStatus(accountId) });
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.user?.email}`);
  });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.init();
    console.log('Database initialised');
  } catch (err) {
    console.error('Database init failed:', err);
    process.exit(1);
  }

  server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await wa.restorePersistedSessions();
  });
})();
