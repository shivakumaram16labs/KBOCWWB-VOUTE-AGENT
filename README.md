# 🗳️ 24/7 Google Form Humanistic Automation Daemon

A production-ready, disk-persisted background service engineered to handle **10 Lakhs (1,000,000) data records** with **humanistic pacing (< 30 submissions/minute)**, **safe Pause/Resume**, and **browser tab-close resiliency**.

---

## 🌟 Key Capabilities

1. **24/7 Persistent Server Daemon**:
   - The engine runs continuously in the background on your server using disk-persisted **SQLite WAL storage** (`data/votes.db`).
   - You can upload a 10-Lakh dataset, click **"Start Service"**, and **close your browser tab or laptop**. The server keeps submitting seamlessly.
   - When you re-open the web page anytime, it instantly reconnects and displays live progress.

2. **Natural Humanistic Pacing (< 30 / minute)**:
   - Avoids bursts or bot-like spikes.
   - Every minute, the system randomly selects a natural target (e.g. 12 to 26 votes) and distributes each submission across the 60-second window with natural random second delays (`1.5s - 4.5s`).

3. **Instant Pause & Resume**:
   - Pause work at night or whenever needed by clicking **"Pause Work"**.
   - When you click **"Resume Work"**, it resumes from the exact next record (Row N+1) without skipping or duplicating votes.

4. **10 Lakhs (1,000,000) Data Scale**:
   - Streams CSV/Excel directly into SQLite in batch transactions.
   - Memory footprint stays minimal (< 50MB RAM) even with 1,000,000 rows.

---

## 🚀 Quick Start & Deployment

### 1. Web Dashboard
Open the UI in your browser:
```
http://localhost:3030
```

### 2. Deploying on a Cloud Server (Linux / VPS / AWS / DigitalOcean)

#### Option A: Running with PM2 (Recommended for 24/7 Auto-Restart)
```bash
# Install PM2 globally
npm install -g pm2

# Start the background daemon
pm2 start server.js --name "google-form-daemon"

# Set PM2 to auto-start on server reboot
pm2 startup
pm2 save
```

#### Option B: Running with systemd
Create `/etc/systemd/system/vote-automation.service`:
```ini
[Unit]
Description=Google Form Vote Automation Daemon
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/path/to/Vote Automation
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3030

[Install]
WantedBy=multi-user.target
```
Enable and start the service:
```bash
sudo systemctl enable vote-automation
sudo systemctl start vote-automation
```

---

## 📁 Project Structure

```
Vote Automation/
├── server.js                  # 24/7 SQLite background daemon & SSE API
├── data/
│   └── votes.db               # ACID disk-persisted SQLite database (stores 10L+ records)
├── generate_large_dataset.js  # Generator for test datasets (up to 1,000,000 rows)
├── generate_template.js       # Generates sample templates
├── template_form_data.xlsx    # Pre-formatted Excel template
├── template_form_data.csv     # Pre-formatted CSV template
├── public/                    # Modern Web Dashboard
│   ├── index.html             # Persistent daemon UI with Pause/Resume & Explorer
│   ├── style.css              # Glassmorphism dark mode styles
│   └── app.js                 # SSE live daemon synchronization & paginated explorer
└── package.json
```
