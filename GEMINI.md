# 🎲 BAD DATA — Project Architecture & Deployment Documentation

Comprehensive guide to the architecture, infrastructure, neural TTS voice engine, AI roaster, Proxmox deployment, and Google TV integration for **Bad Data**.

---

## 📌 Executive Summary

**Bad Data** is a self-hosted Jackbox-style high-stakes trivia party game. It features human-quality neural voice hosting (Kokoro 82M), instant zero-delay RAM pre-buffered audio playback, real-time Gen AI host roasting (Google Gemini API), and native Google TV launcher integration.

---

## 🌐 Network & Infrastructure Details

| Infrastructure Component | Host / IP / Path | Details |
| :--- | :--- | :--- |
| **Proxmox VE Host** | `192.168.86.50` (node `anton`) | Proxmox VE 8 Hypervisor |
| **Proxmox LXC Container** | **LXC 104** (`dataverse` / `192.168.86.36`) | Debian 12 LXC Container |
| **Google TV Device (`den tv`)** | `192.168.86.31` (ADB port `5555`) | Smart TV / Android TV OS 11+ |
| **TV Receiver Display URL** | `http://192.168.86.36:3000/receiver/` | Main TV Game Show View |
| **Mobile Play URL** | `http://192.168.86.36:3000/play/` | Mobile Phone Player Controller |
| **GitHub Repository** | `https://github.com/BAndrews82/bad-data.git` | Main Code Base & CI/CD Pipeline |

---

## 📊 Proxmox LXC 104 Capacity & Resource Allocation

* **CPU**: **6 Cores** (< 2% idle usage, ~60% spike during background pre-synthesis)
* **RAM**: **8.5 GB Total** (~1.4 GB used, **~7.1 GB free headroom / 83% free**)
* **Disk**: **20.0 GB NVMe** (9.8 GB used / 53%, **10.2 GB free / 47%**)
* **Proxmox Recovery Settings**: `pct set 104 --onboot 1 --features nesting=1,keyctl=1`

---

## 🐳 Docker Stack & Container Microservices

All services run inside LXC 104 via Docker Compose (`docker-compose.yml`):

1. **`bad-data-party-game` (Port 3000)**:
   * **Engine**: Node.js + Express + Socket.IO
   * **Role**: Game state machine, WebSocket server, RAM pre-buffering pipeline, and AI Roaster dispatcher.
   * **RAM Footprint**: ~80 MB

2. **`bad-data-kokoro-tts` (Port 8880)**:
   * **Engine**: Kokoro-82M PyTorch FastAPI (`ghcr.io/remsky/kokoro-fastapi-cpu:latest`)
   * **Voice**: `am_michael` (Human-quality neural male voice)
   * **RAM Footprint**: ~800 MB

3. **`bad-data-piper-tts` (Port 5000)**:
   * **Engine**: Piper C++ HTTP (`artibex/piper-http:latest`)
   * **Voice**: `en_US-ryan-high` (22.05kHz lightweight fallback voice)
   * **RAM Footprint**: ~150 MB

4. **`actions.runner` (GitHub Self-Hosted CI/CD Runner)**:
   * **Systemd Service**: `actions.runner.BAndrews82-bad-data.dataverse.service`
   * **Role**: Listens for `git push origin main` and auto-deploys updates in < 15s.

---

## 🎙️ Neural TTS & Audio Pipeline Optimization

* **RAM Pre-Synthesis (`preSynthesizeQuestions()`)**:
  When a game starts, `server.js` renders all 10 questions and reveal answers sequentially into RAM (`ttsAudioCache`).
* **0ms Latency**: Question audio streams directly out of RAM memory when hitting the TV screen, eliminating multi-second synthesis delays.
* **Audio Processing (`public/receiver/index.html`)**:
  Includes Web Audio API Broadcast Dynamics Compressor + 3.2kHz presence EQ filter for crisp TV speaker playback.

---

## 🤖 Gen AI Host Roaster (`lib/AiRoaster.js`)

* **Primary Model**: Google Gemini API (`gemini-3.6-flash`).
* **Sub-300ms Optimization**: Configured `thinkingConfig: { thinkingBudget: 0 }` to eliminate thinking model delays, returning roasts in **under 300ms**.
* **Prompting**: Generates 1-sentence Jackbox-style host commentary under 20 words tailored to round standings (leading player vs biggest cash loser).
* **100% Free Quota**: Uses under 1% of Google's 15 RPM / 1M TPM free limits.
* **Zero-Crash Protection**: Automatically falls back to built-in host quips if network is offline or API fails.

---

## 📺 Google TV Integration & Native App (`BadData-TV.apk`)

* **Native APK Path**: `public/BadData-TV.apk` (897 KB lightweight signed Android TV Webview app).
* **Home Screen Banner**: Implements `LEANBACK_LAUNCHER` intent filter with custom 3D glowing neon logo icon, placing **Bad Data TV** directly on the main Google TV home screen grid.
* **Overscan & Viewport Fit**:
  * Receiver layout uses strict 2-column grid (`grid-cols-2`) and 2.5vh / 3vw TV safe-area overscan padding.
  * Android WebView uses `setUseWideViewPort(true)` & `setLoadWithOverviewMode(true)` so all controls stay 100% visible.
* **Auto-Retry Guard**: Built-in 2.5s connection retry loop handles server container restarts cleanly.

---

## 🛠️ Handy Operational & Maintenance Commands

### 1. SSH Access into Proxmox LXC 104
```bash
ssh root@192.168.86.36
```

### 2. Manual Container Stack Rebuild
```bash
cd /root/bad-data
docker-compose up -d --build
```

### 3. Check Live Service Telemetry
```bash
docker ps
free -h
df -h /
```

### 4. Re-install Native App on Google TV over Wireless ADB
```bash
adb connect 192.168.86.31:5555
adb -s 192.168.86.31:5555 install -r /root/bad-data/public/BadData-TV.apk
adb -s 192.168.86.31:5555 shell am start -n com.baddata.tv/.MainActivity
```

---

## 🚀 CI/CD Pipeline Workflow (`.github/workflows/deploy.yml`)

Every `git push origin main` triggers the self-hosted runner inside LXC 104:
1. Pulls latest code from GitHub.
2. Auto-copies `.env.example` -> `.env` if missing.
3. Rebuilds Docker container `bad-data-party-game`.
4. Relaunches service with status: **`Job completed with result: Succeeded`**.
