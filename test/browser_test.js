const puppeteer = require('puppeteer');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const TriviaService = require('../lib/TriviaService');
const roomManager = require('../lib/RoomManager');
const cardService = require('../lib/CardService');

const ARTIFACT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function runBrowserTest() {
  console.log('====================================================');
  console.log(' Starting Real Headless Chrome Browser Diagnostic ');
  console.log('====================================================');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  app.use(express.static(path.join(__dirname, '../public')));

  io.on('connection', (socket) => {
    socket.on('create_room', () => {
      const room = roomManager.createRoom(socket.id);
      socket.join(`room_${room.code}`);
      socket.join(`host_${room.code}`);

      socket.emit('room_created', {
        roomCode: room.code,
        qrCodeDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        playUrl: `http://localhost:3001/play/?code=${room.code}`,
        players: room.players,
        availablePacks: TriviaService.getAvailablePacks(),
        availableCardPacks: cardService.getAvailablePacks(),
        availableGames: roomManager.getAvailableGames(),
        selectedGameId: room.selectedGameId,
        themeId: room.themeId || 'midnight'
      });
    });

    socket.on('select_theme', ({ roomCode, themeId }) => {
      const room = roomManager.selectTheme(roomCode, themeId);
      if (!room) return;
      io.to(`host_${room.code}`).emit('theme_selected', { themeId: room.themeId, sfxPack: room.sfxPack });
      io.to(`room_${room.code}`).emit('theme_selected', { themeId: room.themeId, sfxPack: room.sfxPack });
      io.to(`host_${room.code}`).emit('sfx_pack_selected', { sfxPack: room.sfxPack, themeId: room.themeId });
      io.to(`room_${room.code}`).emit('sfx_pack_selected', { sfxPack: room.sfxPack, themeId: room.themeId });
    });

    socket.on('join_room', ({ roomCode, nickname }) => {
      const res = roomManager.joinRoom(roomCode, nickname, socket.id, true);
      if (res.error) return socket.emit('join_error', { message: res.error });
      socket.join(`room_${res.room.code}`);
      socket.emit('joined_successfully', { roomCode: res.room.code, nickname: res.player.nickname, color: res.player.color, isVip: true });
      io.to(`host_${res.room.code}`).emit('roster_update', { players: res.room.players });
    });
  });

  await new Promise(r => server.listen(3001, r));
  console.log('[Test Server] Running local server on http://localhost:3001');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
  });

  const receiverPage = await browser.newPage();
  await receiverPage.setViewport({ width: 1920, height: 1080 });

  const consoleLogs = [];
  const pageErrors = [];

  receiverPage.on('console', msg => consoleLogs.push(`[Receiver Console ${msg.type()}] ${msg.text()}`));
  receiverPage.on('pageerror', err => pageErrors.push(`[Receiver JS Error] ${err.toString()}`));

  console.log('[Browser] Navigating to TV Receiver view: http://localhost:3001/receiver/');
  await receiverPage.goto('http://localhost:3001/receiver/', { waitUntil: 'networkidle0' });

  await new Promise(r => setTimeout(r, 2000));

  console.log('--- Receiver Page Console Logs ---');
  consoleLogs.forEach(log => console.log(log));

  if (pageErrors.length > 0) {
    console.error('--- Receiver Page JS Errors ---');
    pageErrors.forEach(err => console.error(err));
    await browser.close();
    server.close();
    process.exit(1);
  }

  const initialData = await receiverPage.evaluate(() => {
    const codeEl = document.getElementById('room-code-display');
    const urlEl = document.getElementById('play-url-text');
    const qrEl = document.getElementById('qr-code-img');
    const bodyClass = document.body.className;

    return {
      roomCode: codeEl ? codeEl.textContent.trim() : null,
      playUrl: urlEl ? urlEl.textContent.trim() : null,
      qrSrc: qrEl ? qrEl.src : null,
      bodyClass
    };
  });

  console.log('[Receiver State On Load]:', JSON.stringify(initialData, null, 2));

  await receiverPage.screenshot({ path: path.join(ARTIFACT_DIR, '01_receiver_initial.png') });
  console.log('[Screenshot] Saved 01_receiver_initial.png');

  if (!initialData.roomCode || initialData.roomCode === '----') {
    console.error('FAIL: Room Code was NOT generated! Stuck on ----');
    await browser.close();
    server.close();
    process.exit(1);
  }

  const roomCode = initialData.roomCode;
  console.log(`[Browser SUCCESS] Room Created! Room Code: ${roomCode}`);

  // Open Mobile Player Controller
  const playerPage = await browser.newPage();
  await playerPage.setViewport({ width: 390, height: 844 });

  console.log(`[Browser] Navigating Mobile Controller to: http://localhost:3001/play/?code=${roomCode}`);
  await playerPage.goto(`http://localhost:3001/play/?code=${roomCode}`, { waitUntil: 'networkidle0' });

  // Type Nickname & Join Room
  await playerPage.type('#input-nickname', 'BrowserVIP');
  await playerPage.click('button[type="submit"]');

  await new Promise(r => setTimeout(r, 2000));

  // Directly call selectThemeMobile('matrix') on mobile controller
  console.log('[Browser] Executing selectThemeMobile("matrix") on Mobile Controller...');
  await playerPage.evaluate((code) => {
    window.selectThemeMobile('matrix');
  }, roomCode);

  await new Promise(r => setTimeout(r, 2000));

  // Inspect Receiver Page After Matrix Theme Selection
  const matrixState = await receiverPage.evaluate(() => {
    const codeEl = document.getElementById('room-code-display');
    const computed = window.getComputedStyle(codeEl);
    const bodyClass = document.body.className;

    return {
      roomCode: codeEl ? codeEl.textContent.trim() : null,
      bodyClass,
      sfxPack: window.sfx ? window.sfx.pack : 'N/A',
      computedStyles: {
        color: computed.color,
        webkitTextFillColor: computed.webkitTextFillColor,
        background: computed.background,
        textShadow: computed.textShadow,
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity
      }
    };
  });

  console.log('[Receiver State After Matrix Theme Selection]:', JSON.stringify(matrixState, null, 2));

  await receiverPage.screenshot({ path: path.join(ARTIFACT_DIR, '02_receiver_matrix_theme.png') });
  console.log('[Screenshot] Saved 02_receiver_matrix_theme.png');

  if (!matrixState.bodyClass.includes('theme-matrix')) {
    console.error('FAIL: Body class does not contain theme-matrix!');
    await browser.close();
    server.close();
    process.exit(1);
  }

  if (matrixState.sfxPack !== 'matrix') {
    console.error(`FAIL: sfxPack is '${matrixState.sfxPack}', expected 'matrix'!`);
    await browser.close();
    server.close();
    process.exit(1);
  }

  console.log('====================================================');
  console.log(' BROWSER DIAGNOSTIC COMPLETED WITH 100% SUCCESS!   ');
  console.log('====================================================');

  await browser.close();
  server.close();
  process.exit(0);
}

runBrowserTest().catch(err => {
  console.error('Browser Test Error:', err);
  process.exit(1);
});
