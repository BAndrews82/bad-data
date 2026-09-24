# BAD DATA 🎮
> A self-hosted, Jackbox-style party trivia game running on Node.js, Express, Socket.io, Google Cast CAF Receiver, Kokoro-82M Neural TTS, and Gen AI Host Roasting.

---

## 🌟 Key Features
- **TV Display (Google Cast / Smart TV)**: 1080p/4K TV interface with dynamic cash tickers, Web Audio API sound FX, and host voice narration.
- **Mobile Controller View**: Zero-zoom, tactile A/B/C/D controller UI for mobile browsers with real-time feedback.
- **Host Voice & AI Roasting**: 
  - Powered by **Kokoro-82M** ultra-realistic neural TTS engine.
  - Sarcastic **Gen AI Host Roasts** powered by Gemini API or local Ollama.
  - Zero-latency RAM pre-synthesis pipeline.
- **Custom Question Packs**: Standard JSON packs stored in `data/packs/` (e.g. `silly_quirky.json`).
- **Homelab Ready**: Automated CI/CD deployment via GitHub Actions & Docker Compose inside Proxmox LXC.

---

## 🚀 Quick Start with Docker

```bash
git clone https://github.com/BAndrews82/bad-data.git
cd bad-data
docker-compose up -d
```

Access the views:
- **TV Display (Host)**: `http://localhost:3000/receiver/`
- **Mobile Controller**: `http://localhost:3000/play/`

---

## 🛠️ Proxmox LXC Homelab Setup

Run inside Proxmox VE (`nesting=1` enabled):
```bash
# LXC Container Configuration:
# - Cores: 4-6 Cores
# - Memory: 4-8 GB RAM
# - OS: Debian 12 / Ubuntu 24.04

HOST_IP=192.168.86.36 BASE_URL=http://192.168.86.36:3000 docker-compose up -d
```

---

## 🤖 CI/CD Deployment
This repository is configured with GitHub Actions (`.github/workflows/deploy.yml`). Pushing changes to `main` automatically triggers your self-hosted homelab runner to pull the latest code, rebuild the containers, and restart the game stack!
