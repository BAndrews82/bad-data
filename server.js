const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');

const TriviaService = require('./lib/TriviaService');
const roomManager = require('./lib/RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * Detect local IPv4 address for home lab / local network QR code generation.
 */
function getLocalIp() {
  if (process.env.HOST_IP) {
    return process.env.HOST_IP;
  }
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Skip internal (i.e. 127.0.0.1) and non-ipv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const hostIp = getLocalIp();
const baseUrl = process.env.BASE_URL || `http://${hostIp}:${PORT}`;

console.log(`[Bad Data] Server configuration: Host IP=${hostIp}, Base URL=${baseUrl}`);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Server Config Endpoint
app.get('/api/config', (req, res) => {
  res.json({
    hostIp,
    baseUrl,
    port: PORT,
    piperTtsUrl: process.env.PIPER_TTS_URL || null
  });
});

// REST API: Get available JSON question packs
app.get('/api/packs', (req, res) => {
  const packs = TriviaService.getAvailablePacks();
  res.json({
    count: packs.length,
    packs
  });
});

// REST API: Get all loaded custom JSON questions
app.get('/api/questions', (req, res) => {
  const customQuestions = TriviaService.loadCustomQuestions();
  res.json({
    count: customQuestions.length,
    questions: customQuestions
  });
});

// REST API: Add a new custom question to data/questions.json
app.post('/api/questions', (req, res) => {
  const { question, correct_answer, incorrect_answers, category, difficulty } = req.body;

  if (!question || !correct_answer || !Array.isArray(incorrect_answers) || incorrect_answers.length < 3) {
    return res.status(400).json({ error: 'Required fields: question, correct_answer, incorrect_answers (array of 3+ strings)' });
  }

  const mainPath = path.join(__dirname, 'data/questions.json');
  let existing = [];
  if (fs.existsSync(mainPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
    } catch(e) {}
  }

  const newQuestion = {
    id: `custom-${Date.now()}`,
    question: question.trim(),
    correct_answer: correct_answer.trim(),
    incorrect_answers: incorrect_answers.map(a => String(a).trim()),
    category: category ? String(category).trim() : 'Custom Trivia',
    difficulty: difficulty || 'medium'
  };

  existing.push(newQuestion);
  fs.writeFileSync(mainPath, JSON.stringify(existing, null, 2), 'utf8');

  console.log(`[Question API] Added new custom question: "${newQuestion.question}"`);
  res.status(201).json({ success: true, question: newQuestion });
});

/**
 * Preprocesses raw text for maximum TTS expressiveness, natural pauses, and cadence.
 */
function preprocessTtsText(rawText) {
  if (!rawText) return '';
  let clean = rawText
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, " and ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\bvs\./gi, 'versus')
    .replace(/\bvs\b/gi, 'versus')
    .replace(/\betc\./gi, 'et cetera')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\bDr\./gi, 'Doctor')
    .replace(/\bMr\./gi, 'Mister')
    .replace(/\bMrs\./gi, 'Missus')
    .replace(/\bProf\./gi, 'Professor')
    .replace(/\bSt\./gi, 'Saint')
    .replace(/\bNo\./gi, 'Number')
    .replace(/\$/g, ' dollars ')
    .replace(/%/g, ' percent ')
    .replace(/Question (\d+)!/gi, 'Question $1... ')
    .replace(/Question (\d+):/gi, 'Question $1... ')
    .replace(/\.{2,}/g, '... ')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean && !/[.!?]$/.test(clean)) {
    clean += '.';
  }
  return clean;
}

// In-Memory TTS Audio RAM Cache & In-Flight Promise Map
const ttsAudioCache = new Map();
const ttsInFlightPromises = new Map();

/**
 * Pre-fetches and caches TTS audio for a given raw text string with deduplication and RAM caching.
 */
async function getOrSynthesizeTts(rawText, isBackground = false) {
  const text = preprocessTtsText(rawText);
  if (!text) return null;

  // 1. Return immediately if already cached in RAM
  if (ttsAudioCache.has(text)) {
    return ttsAudioCache.get(text);
  }

  // 2. Return active promise if synthesis is currently in-flight
  if (ttsInFlightPromises.has(text)) {
    return await ttsInFlightPromises.get(text);
  }

  // 3. Create synthesis promise
  const synthesisPromise = (async () => {
    const providerPreference = (process.env.TTS_PROVIDER || 'kokoro').toLowerCase();

    // 1. Attempt Kokoro-82M Ultra-Realistic Neural TTS Container
    const kokoroUrl = process.env.KOKORO_TTS_URL || 'http://localhost:8880';
    const kokoroVoice = process.env.KOKORO_VOICE || 'am_michael';

    if (providerPreference === 'kokoro' || providerPreference === 'auto') {
      try {
        const controller = new AbortController();
        const timeoutMs = isBackground ? 12000 : 6000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const kokoroRes = await fetch(`${kokoroUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kokoro',
            input: text,
            voice: kokoroVoice,
            response_format: 'mp3',
            speed: 1.0
          }),
          signal: controller.signal
        }).catch(() => null);

        clearTimeout(timeoutId);

        if (kokoroRes && kokoroRes.ok) {
          const contentType = 'audio/mpeg';
          const arrayBuffer = await kokoroRes.arrayBuffer();
          const entry = { contentType, buffer: Buffer.from(arrayBuffer) };
          ttsAudioCache.set(text, entry);
          return entry;
        }
      } catch (err) {}
    }

    // 2. Attempt Piper Neural TTS Sidecar Container
    const piperUrl = process.env.PIPER_TTS_URL || 'http://localhost:5000';
    const piperQueryParams = `text=${encodeURIComponent(text)}&length_scale=1.02&noise_scale=0.75&noise_w=0.85`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const piperRes = await fetch(`${piperUrl}/api/tts?${piperQueryParams}`, {
        signal: controller.signal
      }).catch(() =>
        fetch(`${piperUrl}/?${piperQueryParams}`, { signal: controller.signal })
      );

      clearTimeout(timeoutId);

      if (piperRes && piperRes.ok) {
        const contentType = piperRes.headers.get('content-type') || 'audio/wav';
        const arrayBuffer = await piperRes.arrayBuffer();
        const entry = { contentType, buffer: Buffer.from(arrayBuffer) };
        ttsAudioCache.set(text, entry);
        return entry;
      }
    } catch (err) {}

    return null;
  })();

  ttsInFlightPromises.set(text, synthesisPromise);
  try {
    const result = await synthesisPromise;
    return result;
  } finally {
    ttsInFlightPromises.delete(text);
  }
}

/**
 * Sequential background pre-synthesis for all round questions & reveals.
 */
async function preSynthesizeQuestions(questions) {
  if (!Array.isArray(questions)) return;
  const labels = ['A', 'B', 'C', 'D'];
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const qText = `Question ${idx + 1}! ... ${q.question}`;
    await getOrSynthesizeTts(qText, true);

    const correctText = q.choices ? q.choices[q.correctIndex] : '';
    const rText = `The correct answer was... option ${labels[q.correctIndex]}! ... ${correctText}`;
    await getOrSynthesizeTts(rText, true);
  }
}

// Server-Side Text-To-Speech Endpoint (Multi-Provider + Instant RAM Cache)
app.get('/api/tts', async (req, res) => {
  const rawText = (req.query.text || '').substring(0, 250).trim();
  if (!rawText) {
    return res.status(400).send('No text specified.');
  }

  const cachedResult = await getOrSynthesizeTts(rawText);
  if (cachedResult) {
    res.setHeader('Content-Type', cachedResult.contentType);
    return res.send(cachedResult.buffer);
  }

  // 3. Fallback to Cloud/Online TTS Stream
  const text = preprocessTtsText(rawText);
  const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
  const ttsReq = https.get(fallbackUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }, (ttsRes) => {
    if (ttsRes.statusCode === 200) {
      res.setHeader('Content-Type', 'audio/mpeg');
      ttsRes.pipe(res);
    } else {
      res.status(ttsRes.statusCode).send('TTS service unavailable');
    }
  });

  ttsReq.on('error', (err) => {
    console.error('[TTS Endpoint Error]', err.message);
    res.status(500).send('TTS server error');
  });
});

// Socket.io Event Handling
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // TV / Host creates a room
  socket.on('create_room', async () => {
    const room = roomManager.createRoom(socket.id);
    socket.join(`room_${room.code}`);
    socket.join(`host_${room.code}`);

    const playUrl = `${baseUrl}/play/index.html?code=${room.code}`;
    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(playUrl, {
        margin: 1,
        color: { dark: '#000000', light: '#FFFFFF' }
      });
    } catch (err) {
      console.error('[QRCode] Failed to generate QR code:', err);
    }

    console.log(`[Room] Created room ${room.code} by host ${socket.id}`);

    socket.emit('room_created', {
      roomCode: room.code,
      qrCodeDataUrl,
      playUrl,
      players: room.players,
      availablePacks: TriviaService.getAvailablePacks()
    });
  });

  // Host spawns AI/Bot players for single-screen test mode
  socket.on('add_bot_players', ({ roomCode, count }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    const numToAdd = count || 2;
    for (let i = 0; i < numToAdd; i++) {
      const result = roomManager.addBotPlayer(roomCode);
      if (result) {
        console.log(`[Room ${roomCode}] Added bot player: '${result.player.nickname}'`);
      }
    }

    io.to(`host_${room.code}`).emit('roster_update', {
      players: room.players
    });
  });

  // Mobile Controller joins a room
  socket.on('join_room', ({ roomCode, nickname }) => {
    const result = roomManager.joinRoom(roomCode, nickname, socket.id);
    if (result.error) {
      return socket.emit('join_error', { message: result.error });
    }

    const { room, player } = result;
    socket.join(`room_${room.code}`);

    console.log(`[Room ${room.code}] Player '${player.nickname}' joined (${socket.id})`);

    // Confirm join to player
    socket.emit('joined_successfully', {
      roomCode: room.code,
      nickname: player.nickname,
      color: player.color
    });

    // Notify Host / TV of roster update
    io.to(`host_${room.code}`).emit('roster_update', {
      players: room.players
    });
  });

  // Host starts the game (Accepts sourceMode: 'mix' | 'custom' | 'api' & selectedPacks: [])
  socket.on('start_game', async ({ roomCode, sourceMode, selectedPacks }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) {
      return socket.emit('error_message', { message: 'Only room host can start game.' });
    }

    if (room.players.length === 0) {
      return socket.emit('error_message', { message: 'Need at least 1 player to start!' });
    }

    const mode = sourceMode || 'mix';
    const packIds = Array.isArray(selectedPacks) ? selectedPacks : [];
    console.log(`[Room ${roomCode}] Starting game (Mode: ${mode}, Packs: [${packIds.join(', ')}])...`);

    // Broadcast intro splash notice to TV & Controllers
    io.to(`room_${roomCode}`).emit('game_starting_notice');

    const questions = await TriviaService.fetchQuestions(10, mode, packIds);
    roomManager.setupGame(roomCode, questions);

    // Pre-synthesize all questions and reveals into RAM cache for 0ms voice latency
    preSynthesizeQuestions(questions);

    // Pre-fetch Question 1 audio before launching Round 1
    if (questions.length > 0) {
      await getOrSynthesizeTts(`Question 1! ... ${questions[0].question}`);
    }

    // 2.5s intro splash delay for player sync and voice pre-buffering
    await new Promise(resolve => setTimeout(resolve, 2500));

    await runQuestionRound(io, roomCode);
  });

  // Player submits an answer
  socket.on('submit_answer', ({ roomCode, answerIndex }) => {
    const result = roomManager.submitAnswer(roomCode, socket.id, answerIndex);
    if (result.error) {
      return socket.emit('answer_error', { message: result.error });
    }

    const { player, cashValue, allAnswered, room } = result;

    // Confirm to player
    socket.emit('answer_received', {
      cashAtSubmission: cashValue,
      answerIndex
    });

    // Notify host of player response
    io.to(`host_${room.code}`).emit('player_answered_update', {
      socketId: player.socketId,
      nickname: player.nickname,
      totalAnswered: room.players.filter(p => p.answered).length,
      totalPlayers: room.players.length
    });

    // If all players answered before timer expires, trigger immediate reveal!
    if (allAnswered) {
      console.log(`[Room ${room.code}] All players answered! Resolving round immediately.`);
      evaluateAndReveal(io, room.code);
    }
  });

  // Host manual next question trigger
  socket.on('next_question_request', async ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.status === 'REVEAL') {
      roomManager.clearRoomTimer(room);
      const adv = roomManager.advanceNextQuestion(roomCode);
      if (adv && !adv.isGameOver) {
        await runQuestionRound(io, roomCode);
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const { room, player, isHost } = roomManager.handleDisconnect(socket.id);

    if (room) {
      if (isHost) {
        console.log(`[Room ${room.code}] Host disconnected. Closing room.`);
        io.to(`room_${room.code}`).emit('host_disconnected', {
          message: 'The TV host disconnected. Room closed.'
        });
      } else if (player) {
        console.log(`[Room ${room.code}] Player '${player.nickname}' disconnected.`);
        io.to(`host_${room.code}`).emit('roster_update', {
          players: room.players
        });
      }
    }
  });
});

/**
 * Runs a single 15-second question round.
 */
async function runQuestionRound(ioInstance, roomCode) {
  const room = roomManager.startQuestionRound(roomCode);
  if (!room) return;

  const currentQ = room.currentQuestion;
  const questionNum = room.currentQuestionIndex + 1;
  const totalQuestions = room.questions.length;

  console.log(`[Room ${roomCode}] Round ${questionNum}/${totalQuestions}: "${currentQ.question}"`);

  // Ensure audio is cached in RAM before emitting question to TV for zero-delay speech
  const qText = `Question ${questionNum}! ... ${currentQ.question}`;
  await getOrSynthesizeTts(qText);

  // Send TV question payload (includes full choice text & correct answer masked)
  ioInstance.to(`host_${roomCode}`).emit('question_start', {
    questionNum,
    totalQuestions,
    category: currentQ.category,
    difficulty: currentQ.difficulty,
    baseValue: currentQ.baseValue,
    question: currentQ.question,
    choices: currentQ.choices,
    durationMs: room.roundDurationMs
  });

  // Send Mobile Controller question active notification
  ioInstance.to(`room_${roomCode}`).emit('controller_question_active', {
    questionNum,
    totalQuestions,
    baseValue: currentQ.baseValue,
    durationMs: room.roundDurationMs,
    choiceLabels: ['A', 'B', 'C', 'D'],
    choiceColors: ['#EF4444', '#3B82F6', '#F59E0B', '#10B981']
  });

  // Schedule Bot Players automated responses if any bots exist in room
  const botPlayers = room.players.filter(p => p.isBot);
  botPlayers.forEach(bot => {
    // Random submission delay between 1.5s and 9.0s into the round
    const delayMs = Math.floor(Math.random() * 7500) + 1500;
    setTimeout(() => {
      if (room.status === 'QUESTION' && !bot.answered) {
        // 50% chance bot picks correct answer, 50% chance random answer
        const isSmartChoice = Math.random() < 0.5;
        const chosenIndex = isSmartChoice ? currentQ.correctIndex : Math.floor(Math.random() * 4);

        const res = roomManager.submitAnswer(roomCode, bot.socketId, chosenIndex);
        if (res && res.success) {
          ioInstance.to(`host_${roomCode}`).emit('player_answered_update', {
            socketId: bot.socketId,
            nickname: bot.nickname,
            totalAnswered: room.players.filter(p => p.answered).length,
            totalPlayers: room.players.length
          });

          if (res.allAnswered) {
            evaluateAndReveal(ioInstance, roomCode);
          }
        }
      }
    }, delayMs);
  });

  // Set 15s round timeout
  const timerHandle = setTimeout(() => {
    evaluateAndReveal(ioInstance, roomCode);
  }, room.roundDurationMs);

  roomManager.setRoomTimer(room, timerHandle);
}

/**
 * Evaluates results, broadcasts reveals, and schedules next round or game over.
 */
async function evaluateAndReveal(ioInstance, roomCode) {
  const results = roomManager.evaluateRoundResults(roomCode);
  if (!results) return;

  const labels = ['A', 'B', 'C', 'D'];
  const revealText = `The correct answer was... option ${labels[results.correctIndex]}! ... ${results.correctAnswerText}`;
  await getOrSynthesizeTts(revealText);

  console.log(`[Room ${roomCode}] Question reveal. Correct answer: (${results.correctIndex}) ${results.correctAnswerText}`);

  // Broadcast reveal to TV
  ioInstance.to(`host_${roomCode}`).emit('round_reveal', {
    questionNum: results.room.currentQuestionIndex + 1,
    totalQuestions: results.room.questions.length,
    correctIndex: results.correctIndex,
    correctAnswerText: results.correctAnswerText,
    players: results.players,
    leaderboard: results.leaderboard,
    isLastQuestion: results.isLastQuestion
  });

  // Broadcast result to individual player controllers
  results.players.forEach(player => {
    const isCorrect = player.answered && player.answerIndex === results.correctIndex;
    ioInstance.to(player.socketId).emit('round_result_controller', {
      answered: player.answered,
      isCorrect,
      cashChange: player.lastRoundGain,
      totalScore: player.score,
      correctIndex: results.correctIndex
    });
  });

  // If not last question, set 7-second reveal screen timer before advancing automatically
  if (!results.isLastQuestion) {
    const autoAdvanceHandle = setTimeout(async () => {
      const adv = roomManager.advanceNextQuestion(roomCode);
      if (adv && !adv.isGameOver) {
        await runQuestionRound(ioInstance, roomCode);
      }
    }, 7000);
    roomManager.setRoomTimer(results.room, autoAdvanceHandle);
  } else {
    // Game Over! Broadcast final leaderboard
    console.log(`[Room ${roomCode}] Game Over! Winner: ${results.leaderboard[0]?.nickname || 'None'}`);
    ioInstance.to(`room_${roomCode}`).emit('game_over', {
      leaderboard: results.leaderboard
    });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(` BAD DATA Trivia Game Server Running on Port ${PORT}`);
  console.log(` Local TV View:      http://localhost:${PORT}/receiver/`);
  console.log(` Mobile Controller:  http://localhost:${PORT}/play/`);
  console.log(` Server Base URL:    ${baseUrl}`);
  console.log(`===================================================`);
});
