# WA Manager — WhatsApp Multi-Account Dashboard

A web application to manage multiple WhatsApp accounts in one unified dashboard. Connect accounts via QR code, view all chats, and have team members reply to messages in real time.

## Features

- Connect multiple WhatsApp accounts via QR code (regular WhatsApp, no Business API)
- Unified chat dashboard with real-time message updates via Socket.io
- Role-based access: **Owner** (full access) and **Agent** (view & reply only)
- Sessions persist on disk — no rescanning after server restart
- Supports 15+ simultaneous WhatsApp connections
- JWT authentication with 30-day sessions
- **No Chromium/Puppeteer** — uses [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), pure Node.js

## Requirements

- Node.js 18+
- Works on Railway, Render, VPS, or any Node.js host (no browser required)

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo-url> wa-manager
cd wa-manager
npm install
```

### 3. Configure environment

```bash
cp .env.example .env   # or edit .env directly
```

Edit `.env`:
```
PORT=3000
JWT_SECRET=your_long_random_secret_here
NODE_ENV=production
```

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 4. Run

**Development:**
```bash
node server.js
```

**Production with PM2:**
```bash
npm install -g pm2
pm2 start server.js --name wa-manager
pm2 save
pm2 startup   # follow the printed command
```

Visit `http://your-server-ip:3000` — the first user to sign up becomes the **Owner**.

---

## Railway Deployment

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard:
   - `PORT` → Railway sets this automatically
   - `JWT_SECRET` → set a long random string
   - `NODE_ENV` → `production`
4. **Important — Session persistence:** Railway has ephemeral storage by default. Add a Railway Volume mounted at `/app/sessions` so WhatsApp sessions survive redeploys. Without this you'll need to re-scan QR codes after each deploy.

## Nginx Reverse Proxy

Install Nginx and create a config:

```bash
sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/wa-manager
```

Paste:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable it:
```bash
sudo ln -s /etc/nginx/sites-available/wa-manager /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## SSL with Certbot

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Certbot automatically edits your Nginx config and sets up auto-renewal.

---

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/signup` | — | Register (first user = owner) |
| POST | `/api/auth/login` | — | Login, returns JWT |
| GET | `/api/whatsapp/accounts` | User | List all WA accounts |
| POST | `/api/whatsapp/connect` | Owner | Start new WA connection |
| POST | `/api/whatsapp/disconnect/:id` | Owner | Disconnect an account |
| DELETE | `/api/whatsapp/accounts/:id` | Owner | Remove an account |
| GET | `/api/chats/:accountId` | User | Get chats for an account |
| GET | `/api/messages/:accountId/:chatId` | User | Get messages in a chat |
| POST | `/api/messages/send` | User | Send a message |

## Socket.io Events (Server → Client)

| Event | Payload | Description |
|-------|---------|-------------|
| `qr` | `{ accountId, qr }` | QR code data URL |
| `account-ready` | `{ accountId, phone, label }` | Account connected |
| `account-status` | `{ accountId, status }` | Status change |
| `new-message` | Message object | Incoming/outgoing message |

## Roles

- **Owner**: First user to sign up. Can add/remove WhatsApp accounts.
- **Agent**: Can view all chats and send replies, cannot manage accounts.

## Troubleshooting

**Sessions not persisting:** Ensure the `sessions/` directory is writable:
```bash
chmod 755 sessions/
```

**Port already in use:**
```bash
lsof -i :3000
kill -9 <PID>
```
