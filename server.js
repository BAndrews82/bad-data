const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const TriviaService = require('./lib/TriviaService');
const roomManager = require('./lib/RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

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
    port: PORT
  });
});

// Server-Side Text-To-Speech Endpoint (Reliable HTML5 Audio Stream)
app.get('/api/tts', (req, res) => {
  const text = (req.query.text || '').substring(0, 200).trim();
  if (!text) {
    return res.status(400).send('No text specified.');
  }

  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;

  const ttsReq = https.get(ttsUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }, (ttsRes) => {
    if (ttsRes.statusCode === 200) {
      res.setHeader('Content-Type', 'audio/mpeg');
      ttsRes.pipe(res);
    } else {
      console.warn(`[TTS Endpoint] Upstream returned HTTP ${ttsRes.statusCode}`);
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

  // Host starts the game
  socket.on('start_game', async ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) {
      return socket.emit('error_message', { message: 'Only room host can start game.' });
    }

    if (room.players.length === 0) {
      return socket.emit('error_message', { message: 'Need at least 1 player to start!' });
    }

    console.log(`[Room ${roomCode}] Starting game... Fetching 10 questions...`);
    io.to(`room_${roomCode}`).emit('game_starting_notice');

    const questions = await TriviaService.fetchQuestions(10);
    roomManager.setupGame(roomCode, questions);

    runQuestionRound(io, roomCode);
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
  socket.on('next_question_request', ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.status === 'REVEAL') {
      roomManager.clearRoomTimer(room);
      const adv = roomManager.advanceNextQuestion(roomCode);
      if (adv && !adv.isGameOver) {
        runQuestionRound(io, roomCode);
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
function runQuestionRound(ioInstance, roomCode) {
  const room = roomManager.startQuestionRound(roomCode);
  if (!room) return;

  const currentQ = room.currentQuestion;
  const questionNum = room.currentQuestionIndex + 1;
  const totalQuestions = room.questions.length;

  console.log(`[Room ${roomCode}] Round ${questionNum}/${totalQuestions}: "${currentQ.question}"`);

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

  // Set 15s round timeout
  const timerHandle = setTimeout(() => {
    evaluateAndReveal(ioInstance, roomCode);
  }, room.roundDurationMs);

  roomManager.setRoomTimer(room, timerHandle);
}

/**
 * Evaluates results, broadcasts reveals, and schedules next round or game over.
 */
function evaluateAndReveal(ioInstance, roomCode) {
  const results = roomManager.evaluateRoundResults(roomCode);
  if (!results) return;

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
    const autoAdvanceHandle = setTimeout(() => {
      const adv = roomManager.advanceNextQuestion(roomCode);
      if (adv && !adv.isGameOver) {
        runQuestionRound(ioInstance, roomCode);
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
