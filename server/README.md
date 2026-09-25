# OpenSteamTool Core CDKey & Reseller Server

A complete, high-performance Node.js backend & Web Dashboard for CDKey generation, reseller credit top-up management, and SteamID/AppID activation tracking.

---

## 🌟 Key Features

1. **Role-Based Access Control (RBAC)**:
   - **Admin**: Full control over resellers, credit top-ups, system stats, global CDKeys, and SteamID activation tracking audit logs.
   - **Reseller**: Top-up credit system, CDKey generator (multi-AppID bundling), key history management, credit balance tracking.
2. **Top-Up System**:
   - Resellers spend account credits to generate CDKeys.
   - Admins can create resellers and top up credit balances with real-time audit logs.
3. **CDKey & Activation Tracking**:
   - CDKeys are generated in standard format: `OST-XXXX-YYYY-ZZZZ`.
   - Public/Client Activation API (`POST /api/activate` or `GET /api/activate`).
   - Tracks which `SteamID32` activated which CDKey, the exact AppID(s) granted, client IP address, and activation timestamp.
4. **Modern Frontend Web Dashboard**:
   - Dark mode & glassmorphism aesthetic built with Vanilla CSS & JS.
   - Live analytics cards, batch CDKey generator, direct `ostactivation://` protocol link generation, search/filter capabilities.

---

## 🚀 Quick Start (Local Run)

```bash
cd server
npm install
npm start
```

Default Admin Account created on first startup:
- **Username**: `admin`
- **Password**: `admin123456`
- **Dashboard URL**: `http://localhost:3000`

---

## ☁️ Google Cloud Engine (GCE) / VPS Deployment Guide

### 1. Launch a GCE VM Instance
- **OS**: Ubuntu 22.04 LTS / 24.04 LTS or Debian 12.
- **Machine Type**: `e2-micro` or `e2-small` (Fits in GCP Free Tier).
- **Firewall**: Allow **HTTP (80)** and **HTTPS (443)** traffic.

### 2. Install Node.js & PM2 on GCE VM
Connect via SSH to your VM and run:
```bash
sudo apt update && sudo apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3. Upload / Clone Server Files
```bash
git clone <YOUR_GIT_REPO_URL>
cd OpenSteamTool/server
npm install
```

### 4. Run Server with PM2 (Background Daemon)
```bash
pm2 start server.js --name "ost-server"
pm2 save
pm2 startup
```

### 5. Nginx Reverse Proxy Setup (Port 80 -> Port 3000)
Create `/etc/nginx/sites-available/ost-server`:
```nginx
server {
    listen 80;
    server_name your-domain-or-ip;

    location / {
        proxy_pass http://127.0.0.1:3000;
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

Enable site and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/ost-server /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 📡 API Specifications

### Public CDKey Activation API
- **Endpoint**: `POST /api/activate` or `GET /api/activate`
- **Body / Parameters**:
  ```json
  {
    "cdkey": "OST-R97E-UAG4-CU98",
    "steamid": "69462223"
  }
  ```
- **Response Success (200 OK)**:
  ```json
  {
    "success": true,
    "message": "CDKey activated successfully!",
    "cdkey": "OST-R97E-UAG4-CU98",
    "steamid": "69462223",
    "appids": [1245620, 1086940]
  }
  ```
- **Response Error (400 Bad Request / 404 Not Found)**:
  ```json
  {
    "success": false,
    "error": "CDKey has already been activated",
    "activated_by": "69462223",
    "activated_at": "2026-09-24 19:29:34"
  }
  ```

---

## 🗄️ Database Schema (SQLite)

- `users`: `id`, `username`, `password`, `role` (admin/reseller), `credits`, `created_at`.
- `keys`: `id`, `cdkey`, `appids`, `created_by`, `cost`, `status` (active/used/disabled), `activated_by`, `activated_at`, `created_at`.
- `topup_logs`: `id`, `reseller_id`, `admin_id`, `amount`, `note`, `created_at`.
- `activations`: `id`, `cdkey`, `steamid`, `appids`, `ip_address`, `activated_at`.
