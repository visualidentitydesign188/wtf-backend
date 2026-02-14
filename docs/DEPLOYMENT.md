# Deploying wtf-backend to a VPS (production)

Steps to run this NestJS app (HTTP + WebSockets) on a Linux VPS.

---

## Option 1: Docker (single domain with host Nginx)

Use this when both frontend (e.g. Nuxt) and backend run in Docker, with one Nginx on the host handling HTTPS and routing.

### 1.1 VPS: Docker and host Nginx

- **OS:** Ubuntu 22.04 LTS (or similar).
- Install Docker and Docker Compose, and Nginx on the host (for SSL and routing).

```bash
# Docker
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture)] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Host Nginx (for HTTPS and routing to frontend + backend)
sudo apt-get install -y nginx
```

### 1.2 Run the backend stack

From the backend repo (e.g. `~/deployment/backend`):

```bash
cd ~/deployment/backend
docker compose up -d
```

This starts Redis and 3 app instances (app1–app3). Each app is exposed on the host: **3001**, **3002**, **3003**. Host Nginx load-balances across these with sticky sessions (ip_hash).

### 1.3 Host Nginx: single domain (frontend + backend)

Create a site config (e.g. `/etc/nginx/sites-available/yourdomain`) so that `/` goes to the frontend and `/socket.io/` and `/mouse/` go to an upstream of the three backend ports. Use **ip_hash** so WebSocket connections stick to one backend:

```nginx
upstream backend {
    ip_hash;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
}

server {
    listen 80;
    server_name your-domain.com;

    # Frontend (e.g. Nuxt container mapped to 3000)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend: Socket.IO
    location /socket.io/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    # Backend: HTTP API (this app serves /mouse and /mouse/users)
    location /mouse/ {
        proxy_pass http://backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- Replace `your-domain.com` with your domain.
- Replace `127.0.0.1:3000` with the host port your **frontend** container is mapped to (e.g. Nuxt).
- Backend traffic is load-balanced across `127.0.0.1:3001`, `3002`, `3003` via the `backend` upstream.

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/yourdomain /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 1.4 Frontend environment (single domain)

Point the frontend at the same origin so API and Socket.IO use the same domain (no CORS needed):

- `NUXT_PUBLIC_API_URL=https://your-domain.com` (or equivalent; use `''` or same origin if the app uses relative URLs).

### 1.5 SSL and firewall

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### 1.6 Deploy updates (Option 1)

```bash
cd ~/deployment/backend
git pull
docker compose up -d --build
```

---

## Option 2: PM2 (bare metal)

The following sections describe running the backend with Node.js and PM2 on the host (no Docker for the app).

---

## 1. VPS basics

- **OS:** Ubuntu 22.04 LTS (or similar).
- **User:** Use a non-root user with sudo; deploy under that user or a dedicated `app` user.

---

## 2. Install Node.js, pnpm, Redis

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
sudo npm install -g pnpm

# Redis
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

Check: `node -v`, `pnpm -v`, `redis-cli ping` → `PONG`.

---

## 3. Clone and build the app

```bash
cd /var/www  # or your preferred path
sudo mkdir -p wtf-backend
sudo chown $USER:$USER wtf-backend
cd wtf-backend

# Clone (or rsync/scp your code)
git clone <your-repo-url> .

pnpm install --frozen-lockfile
pnpm run build
```

Production run uses the compiled output: `node dist/main.js` (see `start:prod` in package.json).

---

## 4. Environment variables

Create a production env file (do not commit secrets):

```bash
nano .env
```

Set at least:

```env
NODE_ENV=production
PORT=3000
REDIS_URL=redis://localhost:6379
```

If Redis is on another host/port or has a password, set `REDIS_URL` accordingly (e.g. `redis://:password@host:6379`).

Restrict permissions: `chmod 600 .env`.

---

## 5. Run with PM2 (process manager)

PM2 keeps the app running and restarts it on crash.

```bash
sudo npm install -g pm2

# Start
pm2 start dist/main.js --name wtf-backend

# Or use ecosystem file (recommended)
```

Create `ecosystem.config.cjs` in the project root:

```javascript
module.exports = {
  apps: [
    {
      name: 'wtf-backend',
      script: 'dist/main.js',
      cwd: '/var/www/wtf-backend',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      env_file: '.env',
    },
  ],
};
```

Then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # run the command it prints to start PM2 on boot
```

Useful: `pm2 logs wtf-backend`, `pm2 restart wtf-backend`, `pm2 status`.

---

## 6. Nginx as reverse proxy (recommended)

Nginx handles HTTPS, terminates SSL, and proxies HTTP and WebSockets to your Node app.

Install:

```bash
sudo apt-get install -y nginx
```

Create a site config (e.g. `/etc/nginx/sites-available/wtf-backend`):

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/wtf-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

`Upgrade` / `Connection "upgrade"` and the long `proxy_read_timeout` are for Socket.IO WebSockets.

---

## 7. SSL with Let's Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Follow prompts. Certbot will adjust your Nginx config for HTTPS and auto-renewal.

---

## 8. Firewall

Allow SSH, HTTP, HTTPS; block direct access to Node port if Nginx is in front:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

(If you ever expose Node directly, you’d allow 3000; with Nginx only, you don’t need to.)

---

## 9. CORS (if frontend is on another domain)

If your frontend is on a different origin (e.g. `https://app.example.com`), enable CORS in the Nest app. In `src/main.ts`:

```ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['https://your-frontend-domain.com'],
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3000);
}
```

Rebuild and restart: `pnpm run build && pm2 restart wtf-backend`.

---

## 10. Deploy updates

```bash
cd /var/www/wtf-backend
git pull
pnpm install --frozen-lockfile
pnpm run build
pm2 restart wtf-backend
```

Optional: add a small deploy script that runs these steps.

---

## Checklist

| Step | Action |
|------|--------|
| 1 | VPS with Ubuntu (or similar) |
| 2 | Install Node 20, pnpm, Redis |
| 3 | Clone repo, `pnpm install`, `pnpm run build` |
| 4 | Create `.env` with `NODE_ENV`, `PORT`, `REDIS_URL` |
| 5 | Run with PM2 and set `pm2 startup` |
| 6 | Configure Nginx reverse proxy (HTTP + WebSocket) |
| 7 | SSL with Certbot |
| 8 | UFW: 22, 80, 443 |
| 9 | Enable CORS if frontend on another domain |
| 10 | Use `git pull` + build + `pm2 restart` for future deploys |

---

## Optional: Redis via Docker

If you prefer Redis in Docker instead of the system package:

```bash
docker run -d --name redis -p 6379:6379 --restart unless-stopped redis:7-alpine
```

Then keep `REDIS_URL=redis://localhost:6379` in `.env`.
