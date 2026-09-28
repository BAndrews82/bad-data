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
const cardService = require('./lib/CardService');
const AiRoaster = require('./lib/AiRoaster');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

function getLocalIp() {
  if (process.env.HOST_IP) {
    return process.env.HOST_IP;
  }
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
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

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));

app.get('/api/config', (req, res) => {
  res.json({
    hostIp,
    baseUrl,
    port: PORT,
    piperTtsUrl: process.env.PIPER_TTS_URL || null
  });
});

app.get('/api/games', (req, res) => {
  res.json({ games: roomManager.getAvailableGames() });
});

app.get('/api/card-packs', (req, res) => {
  res.json({ count: cardService.getAvailablePacks().length, packs: cardService.getAvailablePacks() });
});

app.get('/api/packs', (req, res) => {
  const packs = TriviaService.getAvailablePacks();
  res.json({ count: packs.length, packs });
});

app.get('/api/questions', (req, res) => {
  const customQuestions = TriviaService.loadCustomQuestions();
  res.json({ count: customQuestions.length, questions: customQuestions });
});

app.post('/api/questions', (req, res) => {
  const { question, correct_answer, incorrect_answers, category, difficulty } = req.body;
  if (!question || !correct_answer || !Array.isArray(incorrect_answers) || incorrect_answers.length < 3) {
    return res.status(400).json({ error: 'Required fields: question, correct_answer, incorrect_answers (array of 3+ strings)' });
  }

  const mainPath = path.join(__dirname, 'data/questions.json');
  let existing = [];
  if (fs.existsSync(mainPath)) {
    try { existing = JSON.parse(fs.readFileSync(mainPath, 'utf8')); } catch(e) {}
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
  res.status(201).json({ success: true, question: newQuestion });
});

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

const ttsAudioCache = new Map();
const ttsInFlightPromises = new Map();

async function getOrSynthesizeTts(rawText, isBackground = false, voiceOverride = null) {
  const text = preprocessTtsText(rawText);
  if (!text) return null;

  const targetVoice = voiceOverride || process.env.KOKORO_VOICE || 'am_michael';
  const cacheKey = `${targetVoice}:${text}`;

  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey);
  }

  if (ttsInFlightPromises.has(cacheKey)) {
    return await ttsInFlightPromises.get(cacheKey);
  }

  const synthesisPromise = (async () => {
    const providerPreference = (process.env.TTS_PROVIDER || 'kokoro').toLowerCase();
    const kokoroUrl = process.env.KOKORO_TTS_URL || 'http://localhost:8880';

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
            voice: targetVoice,
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
          ttsAudioCache.set(cacheKey, entry);
          return entry;
        }
      } catch (err) {}
    }

    if (targetVoice.startsWith('am_') || targetVoice.startsWith('bm_') || targetVoice.startsWith('af_') || targetVoice.startsWith('bf_')) {
      return null;
    }

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
        ttsAudioCache.set(cacheKey, entry);
        return entry;
      }
    } catch (err) {}

    return null;
  })();

  ttsInFlightPromises.set(cacheKey, synthesisPromise);
  try {
    const result = await synthesisPromise;
    return result;
  } finally {
    ttsInFlightPromises.delete(cacheKey);
  }
}

async function preSynthesizeQuestions(questions) {
  if (!Array.isArray(questions)) return;
  const labels = ['A', 'B', 'C', 'D'];
  const announcerVoice = process.env.KOKORO_VOICE || 'am_michael';
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    await getOrSynthesizeTts(q.question, true, announcerVoice);
    const correctText = q.choices ? q.choices[q.correctIndex] : '';
    const rText = `The correct answer was... option ${labels[q.correctIndex]}! ... ${correctText}`;
    await getOrSynthesizeTts(rText, true, announcerVoice);
  }
}

app.get('/api/tts', async (req, res) => {
  const rawText = (req.query.text || '').substring(0, 500).trim();
  if (!rawText) return res.status(400).send('No text specified.');

  const requestedVoice = req.query.voice || null;
  const cachedResult = await getOrSynthesizeTts(rawText, false, requestedVoice);
  if (cachedResult) {
    res.setHeader('Content-Type', cachedResult.contentType);
    return res.send(cachedResult.buffer);
  }

  const text = preprocessTtsText(rawText);
  const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
  const ttsReq = https.get(fallbackUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }, (ttsRes) => {
    if (ttsRes.statusCode === 200) {
      res.setHeader('Content-Type', 'audio/mpeg');
      ttsRes.pipe(res);
    } else {
      res.status(ttsRes.statusCode).send('TTS service unavailable');
    }
  });

  ttsReq.on('error', (err) => {
    res.status(500).send('TTS server error');
  });
});

// Socket.io Handlers
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('create_room', async () => {
    const room = roomManager.createRoom(socket.id);
    socket.join(`room_${room.code}`);
    socket.join(`host_${room.code}`);

    const playUrl = `${baseUrl}/play/index.html?code=${room.code}`;
    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(playUrl, { margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
    } catch (err) {}

    console.log(`[Room] Created room ${room.code} by host ${socket.id}`);

    socket.emit('room_created', {
      roomCode: room.code,
      qrCodeDataUrl,
      playUrl,
      players: room.players,
      availablePacks: TriviaService.getAvailablePacks(),
      availableCardPacks: cardService.getAvailablePacks(),
      availableGames: roomManager.getAvailableGames(),
      selectedGameId: room.selectedGameId
    });
  });

  socket.on('select_game', ({ roomCode, gameId }) => {
    const room = roomManager.selectGame(roomCode, gameId);
    if (!room) return;

    console.log(`[Room ${roomCode}] Selected Game: ${gameId}`);
    io.to(`host_${room.code}`).emit('game_selected', { selectedGameId: room.selectedGameId });
    io.to(`room_${room.code}`).emit('game_selected', { selectedGameId: room.selectedGameId });
  });

  socket.on('add_bot_players', ({ roomCode, count }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.status !== 'LOBBY') return;

    const numToAdd = count || 2;
    for (let i = 0; i < numToAdd; i++) {
      const result = roomManager.addBotPlayer(roomCode);
      if (result) {
        console.log(`[Room ${roomCode}] Added bot player: '${result.player.nickname}'`);
      }
    }

    io.to(`host_${room.code}`).emit('roster_update', { players: room.players });
    io.to(`room_${room.code}`).emit('roster_update', { players: room.players });
  });

  socket.on('join_room', ({ roomCode, nickname }) => {
    const result = roomManager.joinRoom(roomCode, nickname, socket.id);
    if (result.error) {
      return socket.emit('join_error', { message: result.error });
    }

    const { room, player } = result;
    socket.join(`room_${room.code}`);

    socket.emit('joined_successfully', {
      roomCode: room.code,
      nickname: player.nickname,
      color: player.color,
      selectedGameId: room.selectedGameId
    });

    io.to(`host_${room.code}`).emit('roster_update', { players: room.players });
  });

  socket.on('start_game', async ({ roomCode, sourceMode, selectedPacks, selectedCardPacks, enableRoaster, enablePopularVote }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) {
      return socket.emit('error_message', { message: 'Only room host can start game.' });
    }

    if (room.players.length === 0) {
      return socket.emit('error_message', { message: 'Need at least 1 player to start!' });
    }

    room.enableRoaster = Boolean(enableRoaster);

    await roomManager.setupGame(roomCode, { sourceMode, selectedPacks, selectedCardPacks, enablePopularVote });

    io.to(`room_${roomCode}`).emit('game_starting_notice', { selectedGameId: room.selectedGameId });

    if (room.selectedGameId === 'cah') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await runCahRound(io, roomCode);
    } else {
      preSynthesizeQuestions(room.questions);
      if (room.questions && room.questions.length > 0) {
        await getOrSynthesizeTts(room.questions[0].question);
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
      await runQuestionRound(io, roomCode);
    }
  });

  // Trivia answer submission
  socket.on('submit_answer', ({ roomCode, answerIndex }) => {
    const res = roomManager.submitPlayerInput(roomCode, socket.id, { answerIndex });
    if (res.error) return socket.emit('answer_error', { message: res.error });

    const { player, cashValue, allAnswered, room } = res;

    socket.emit('answer_received', { cashAtSubmission: cashValue, answerIndex });
    io.to(`host_${room.code}`).emit('player_answered_update', {
      socketId: player.socketId,
      nickname: player.nickname,
      totalAnswered: room.players.filter(p => p.answered).length,
      totalPlayers: room.players.length
    });

    if (allAnswered) {
      roomManager.clearRoomTimer(room);
      io.to(`host_${room.code}`).emit('all_players_answered');
      io.to(`room_${room.code}`).emit('all_players_answered');
      evaluateAndReveal(io, room.code);
    }
  });

  // Bad Cards white card submission
  socket.on('submit_card', ({ roomCode, cardIndex }) => {
    const res = roomManager.submitPlayerInput(roomCode, socket.id, { action: 'SUBMIT_CARD', cardIndex });
    if (res.error) return socket.emit('card_error', { message: res.error });

    const { player, submittedCount, totalRequired, allSubmitted, room } = res;

    socket.emit('card_submitted_confirm', { success: true });

    io.to(`host_${room.code}`).emit('cah_submission_update', {
      submittedCount,
      totalRequired,
      players: room.players.map(p => ({
        nickname: p.nickname,
        submitted: Boolean(p.submittedCard || p.socketId === room.currentJudgeSocketId),
        isJudge: p.socketId === room.currentJudgeSocketId
      }))
    });

    io.to(room.currentJudgeSocketId).emit('cah_judge_status_update', {
      submittedCount,
      totalRequired
    });

    if (allSubmitted) {
      console.log(`[Room ${room.code}] All players submitted cards! Transitioning to judging phase.`);
      startCahJudgingPhase(io, room.code);
    }
  });

  // Discard & Redraw socket handler
  socket.on('discard_redraw', ({ roomCode, cardIndices }) => {
    const res = roomManager.submitPlayerInput(roomCode, socket.id, { action: 'DISCARD_REDRAW', cardIndices });
    if (res.error) return socket.emit('redraw_error', { message: res.error });

    socket.emit('redraw_confirm', { success: true, hand: res.hand });
  });

  // Popular vote socket handler
  socket.on('popular_vote', ({ roomCode, submissionId }) => {
    const res = roomManager.submitPlayerInput(roomCode, socket.id, { action: 'POPULAR_VOTE', submissionId });
    if (res.error) return socket.emit('vote_error', { message: res.error });

    socket.emit('popular_vote_confirm', { success: true, submissionId: res.submissionId });
  });

  // Bad Cards Judge winner pick
  socket.on('pick_winner', ({ roomCode, submissionId }) => {
    const res = roomManager.submitPlayerInput(roomCode, socket.id, { action: 'PICK_WINNER', submissionId });
    if (res.error) return socket.emit('pick_error', { message: res.error });

    evaluateAndRevealCah(io, roomCode, res);
  });

  socket.on('next_question_request', async ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.selectedGameId === 'cah') {
      const adv = roomManager.advanceNextRound(roomCode);
      if (adv && !adv.isGameOver) {
        await runCahRound(io, roomCode);
      } else if (adv && adv.isGameOver) {
        const leaderboard = room.players ? [...room.players].sort((a, b) => b.score - a.score) : [];
        io.to(`room_${roomCode}`).emit('game_over', { leaderboard });
      }
    } else {
      if (room.status === 'REVEAL') {
        roomManager.clearRoomTimer(room);
        const adv = roomManager.advanceNextRound(roomCode);
        if (adv && !adv.isGameOver) {
          await runQuestionRound(io, roomCode);
        } else if (adv && adv.isGameOver) {
          const leaderboard = room.players ? [...room.players].sort((a, b) => b.score - a.score) : [];
          io.to(`room_${roomCode}`).emit('game_over', { leaderboard });
        }
      }
    }
  });

  socket.on('end_game_early', ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return;

    roomManager.clearRoomTimer(room);
    room.status = 'GAME_OVER';
    const leaderboard = room.players ? [...room.players].sort((a, b) => b.score - a.score) : [];
    io.to(`room_${roomCode}`).emit('game_over', { leaderboard });
  });

  socket.on('disconnect', () => {
    const { room, player, isHost } = roomManager.handleDisconnect(socket.id);
    if (room) {
      if (isHost) {
        io.to(`room_${room.code}`).emit('host_disconnected', { message: 'The TV host disconnected. Room closed.' });
      } else if (player) {
        io.to(`host_${room.code}`).emit('roster_update', { players: room.players });
      }
    }
  });
});

async function runCahRound(ioInstance, roomCode) {
  const roundData = roomManager.startRound(roomCode);
  if (!roundData) return;

  const { room, roundNum, totalRounds, prompt, judgeSocketId, judgeNickname } = roundData;
  console.log(`[Room ${roomCode}] CAH Round ${roundNum}/${totalRounds}. Judge: ${judgeNickname}. Prompt: "${prompt}"`);

  getOrSynthesizeTts(prompt, true);

  ioInstance.to(`host_${roomCode}`).emit('cah_round_start', {
    roundNum,
    totalRounds,
    prompt,
    judgeNickname,
    players: room.players.map(p => ({
      nickname: p.nickname,
      score: p.score,
      isJudge: p.socketId === judgeSocketId
    }))
  });

  const nonJudgePlayers = room.players.filter(p => p.socketId !== judgeSocketId);
  room.players.forEach(p => {
    const isJudge = p.socketId === judgeSocketId;
    ioInstance.to(p.socketId).emit('cah_controller_round', {
      roundNum,
      totalRounds,
      prompt,
      isJudge,
      judgeNickname,
      hand: p.hand,
      usedRedraw: p.usedRedraw,
      totalRequired: nonJudgePlayers.length
    });
  });

  const botPlayers = room.players.filter(p => p.isBot && p.socketId !== judgeSocketId);
  botPlayers.forEach(bot => {
    const delayMs = Math.floor(Math.random() * 5000) + 1500;
    setTimeout(() => {
      if (room.status === 'CAH_SUBMIT') {
        const randomIndex = Math.floor(Math.random() * bot.hand.length);
        const res = roomManager.submitPlayerInput(roomCode, bot.socketId, { action: 'SUBMIT_CARD', cardIndex: randomIndex });
        if (res && res.success) {
          ioInstance.to(`host_${roomCode}`).emit('cah_submission_update', {
            submittedCount: res.submittedCount,
            totalRequired: res.totalRequired,
            players: room.players.map(p => ({
              nickname: p.nickname,
              submitted: Boolean(p.submittedCard || p.socketId === room.currentJudgeSocketId),
              isJudge: p.socketId === room.currentJudgeSocketId
            }))
          });

          if (res.allSubmitted) {
            startCahJudgingPhase(ioInstance, roomCode);
          }
        }
      }
    }, delayMs);
  });
}

function startCahJudgingPhase(ioInstance, roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  console.log(`[Room ${roomCode}] CAH Judging Phase. Broadcast anonymous choices.`);

  ioInstance.to(`host_${roomCode}`).emit('cah_judging_phase', {
    prompt: room.currentPrompt.text,
    judgeNickname: room.currentJudgeNickname,
    submissions: room.shuffledSubmissions.map(s => ({ id: s.id, cardText: s.cardText }))
  });

  ioInstance.to(room.currentJudgeSocketId).emit('cah_judge_pick_options', {
    prompt: room.currentPrompt.text,
    submissions: room.shuffledSubmissions.map(s => ({ id: s.id, cardText: s.cardText }))
  });

  room.players.filter(p => p.socketId !== room.currentJudgeSocketId).forEach(p => {
    ioInstance.to(p.socketId).emit('cah_waiting_for_judge', {
      judgeNickname: room.currentJudgeNickname,
      enablePopularVote: room.enablePopularVote,
      submissions: room.shuffledSubmissions.map(s => ({ id: s.id, cardText: s.cardText }))
    });
  });

  const judgePlayer = room.players.find(p => p.socketId === room.currentJudgeSocketId);
  if (judgePlayer && judgePlayer.isBot) {
    setTimeout(() => {
      if (room.status === 'CAH_JUDGE' && room.shuffledSubmissions.length > 0) {
        const randomSub = room.shuffledSubmissions[Math.floor(Math.random() * room.shuffledSubmissions.length)];
        const res = roomManager.submitPlayerInput(roomCode, judgePlayer.socketId, { action: 'PICK_WINNER', submissionId: randomSub.id });
        if (res && res.success) {
          evaluateAndRevealCah(ioInstance, roomCode, res);
        }
      }
    }, 3500);
  }
}

async function evaluateAndRevealCah(ioInstance, roomCode, resultData) {
  const { winningSubmission, winnerPlayer, popularWinnerPlayer, popularVoteCount, prompt, room } = resultData;

  let hostRoast = '';
  if (room.enableRoaster) {
    hostRoast = await AiRoaster.generateRoast({
      question: `Cards Against Humanity Prompt: "${prompt}"`,
      correctAnswerText: `Winning Card: "${winningSubmission.cardText}" (Played by ${winnerPlayer ? winnerPlayer.nickname : 'Unknown'})`,
      leaderboard: room.players.sort((a,b) => b.score - a.score),
      players: room.players
    });
  }

  const announcerVoice = process.env.KOKORO_VOICE || 'am_michael';
  const roasterVoice = process.env.ROASTER_VOICE || 'bm_george';

  const revealSpeech = `Winning card... ${winningSubmission.cardText}!`;
  const announcerAudio = await getOrSynthesizeTts(revealSpeech, false, announcerVoice);
  let finalRevealAudio = announcerAudio;

  if (hostRoast) {
    const roasterAudio = await getOrSynthesizeTts(hostRoast, false, roasterVoice);
    if (announcerAudio && roasterAudio && announcerAudio.contentType === 'audio/mpeg' && roasterAudio.contentType === 'audio/mpeg') {
      const combinedBuffer = Buffer.concat([announcerAudio.buffer, roasterAudio.buffer]);
      finalRevealAudio = { contentType: 'audio/mpeg', buffer: combinedBuffer };
    }
  }

  const leaderboard = [...room.players].sort((a,b) => b.score - a.score);
  const isGameOver = room.currentRound >= room.totalRounds - 1;

  console.log(`[Room ${roomCode}] CAH Winner: ${winnerPlayer ? winnerPlayer.nickname : 'Unknown'} with "${winningSubmission.cardText}". Popular Vote Winner: ${popularWinnerPlayer ? popularWinnerPlayer.nickname : 'None'}`);

  ioInstance.to(`host_${roomCode}`).emit('cah_round_reveal', {
    prompt,
    winningCardText: winningSubmission.cardText,
    winnerNickname: winnerPlayer ? winnerPlayer.nickname : 'Unknown',
    winnerColor: winnerPlayer ? winnerPlayer.color : '#3B82F6',
    popularWinnerNickname: popularWinnerPlayer ? popularWinnerPlayer.nickname : null,
    popularVoteCount: popularVoteCount || 0,
    hostRoast,
    leaderboard,
    isGameOver
  });

  room.players.forEach(p => {
    const isWinner = winnerPlayer && p.socketId === winnerPlayer.socketId;
    const isPopularWinner = popularWinnerPlayer && p.socketId === popularWinnerPlayer.socketId;
    ioInstance.to(p.socketId).emit('cah_controller_reveal', {
      isWinner,
      isPopularWinner,
      winnerNickname: winnerPlayer ? winnerPlayer.nickname : 'Unknown',
      winningCardText: winningSubmission.cardText,
      totalScore: p.score
    });
  });

  let revealDurationMs = 7000;
  if (finalRevealAudio && finalRevealAudio.buffer) {
    const audioSecs = finalRevealAudio.buffer.length / 16000;
    revealDurationMs = Math.max(7000, Math.min(10000, Math.ceil((audioSecs + 1.5) * 1000)));
  }

  if (!isGameOver) {
    const timerHandle = setTimeout(async () => {
      const currentR = roomManager.getRoom(roomCode);
      if (currentR && currentR.status === 'CAH_REVEAL') {
        const adv = roomManager.advanceNextRound(roomCode);
        if (adv && !adv.isGameOver) {
          await runCahRound(ioInstance, roomCode);
        } else {
          ioInstance.to(`room_${roomCode}`).emit('game_over', { leaderboard });
        }
      }
    }, revealDurationMs);
    roomManager.setRoomTimer(room, timerHandle);
  } else {
    ioInstance.to(`room_${roomCode}`).emit('game_over', { leaderboard });
  }
}

async function runQuestionRound(ioInstance, roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  roomManager.startRound(roomCode);

  const currentQ = room.currentQuestion;
  const questionNum = room.currentQuestionIndex + 1;
  const totalQuestions = room.questions.length;

  console.log(`[Room ${roomCode}] Trivia Round ${questionNum}/${totalQuestions}: "${currentQ.question}"`);

  const qText = currentQ.question;
  await getOrSynthesizeTts(qText);

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

  ioInstance.to(`room_${roomCode}`).emit('controller_question_active', {
    questionNum,
    totalQuestions,
    baseValue: currentQ.baseValue,
    durationMs: room.roundDurationMs,
    choiceLabels: ['A', 'B', 'C', 'D'],
    choiceColors: ['#EF4444', '#3B82F6', '#F59E0B', '#10B981']
  });

  const botPlayers = room.players.filter(p => p.isBot);
  botPlayers.forEach(bot => {
    const delayMs = Math.floor(Math.random() * 7500) + 1500;
    setTimeout(() => {
      if (room.status === 'QUESTION' && !bot.answered) {
        const isSmartChoice = Math.random() < 0.5;
        const chosenIndex = isSmartChoice ? currentQ.correctIndex : Math.floor(Math.random() * 4);
        const res = roomManager.submitPlayerInput(roomCode, bot.socketId, { answerIndex: chosenIndex });
        if (res && res.success) {
          ioInstance.to(`host_${roomCode}`).emit('player_answered_update', {
            socketId: bot.socketId,
            nickname: bot.nickname,
            totalAnswered: room.players.filter(p => p.answered).length,
            totalPlayers: room.players.length
          });

          if (res.allAnswered) {
            roomManager.clearRoomTimer(room);
            ioInstance.to(`host_${roomCode}`).emit('all_players_answered');
            ioInstance.to(`room_${roomCode}`).emit('all_players_answered');
            evaluateAndReveal(ioInstance, roomCode);
          }
        }
      }
    }, delayMs);
  });

  const timerHandle = setTimeout(() => {
    evaluateAndReveal(ioInstance, roomCode);
  }, room.roundDurationMs);

  roomManager.setRoomTimer(room, timerHandle);
}

async function evaluateAndReveal(ioInstance, roomCode) {
  const results = roomManager.evaluateRoundResults(roomCode);
  if (!results) return;

  roomManager.clearRoomTimer(results.room);

  const labels = ['A', 'B', 'C', 'D'];
  const currentQ = results.room.questions[results.room.currentQuestionIndex];

  let hostRoast = '';
  if (results.room.enableRoaster) {
    hostRoast = await AiRoaster.generateRoast({
      question: currentQ ? currentQ.question : '',
      correctAnswerText: results.correctAnswerText,
      leaderboard: results.leaderboard,
      players: results.players
    });
  }

  const announcerRevealText = `The correct answer was... option ${labels[results.correctIndex]}! ... ${results.correctAnswerText}`;
  const announcerVoice = process.env.KOKORO_VOICE || 'am_michael';
  const roasterVoice = process.env.ROASTER_VOICE || 'bm_george';

  const announcerAudio = await getOrSynthesizeTts(announcerRevealText, false, announcerVoice);
  let finalRevealAudio = announcerAudio;

  if (hostRoast) {
    const roasterAudio = await getOrSynthesizeTts(hostRoast, false, roasterVoice);
    if (announcerAudio && roasterAudio && announcerAudio.contentType === 'audio/mpeg' && roasterAudio.contentType === 'audio/mpeg') {
      const combinedBuffer = Buffer.concat([announcerAudio.buffer, roasterAudio.buffer]);
      finalRevealAudio = { contentType: 'audio/mpeg', buffer: combinedBuffer };
    }
  }

  let revealDurationMs = 6500;
  if (finalRevealAudio && finalRevealAudio.buffer) {
    const audioSecs = finalRevealAudio.buffer.length / 16000;
    revealDurationMs = Math.max(6500, Math.min(9500, Math.ceil((audioSecs + 1.5) * 1000)));
  }

  ioInstance.to(`host_${roomCode}`).emit('round_reveal', {
    questionNum: results.room.currentQuestionIndex + 1,
    totalQuestions: results.room.questions.length,
    correctIndex: results.correctIndex,
    correctAnswerText: results.correctAnswerText,
    hostRoast,
    players: results.players,
    leaderboard: results.leaderboard,
    isLastQuestion: results.isLastQuestion,
    revealDurationMs
  });

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

  if (!results.isLastQuestion) {
    const autoAdvanceHandle = setTimeout(async () => {
      const currentR = roomManager.getRoom(roomCode);
      if (currentR && currentR.status === 'REVEAL') {
        const adv = roomManager.advanceNextRound(roomCode);
        if (adv && !adv.isGameOver) {
          await runQuestionRound(ioInstance, roomCode);
        } else if (adv && adv.isGameOver) {
          const leaderboard = currentR.players ? [...currentR.players].sort((a, b) => b.score - a.score) : [];
          ioInstance.to(`room_${roomCode}`).emit('game_over', { leaderboard });
        }
      }
    }, revealDurationMs);
    roomManager.setRoomTimer(results.room, autoAdvanceHandle);
  } else {
    ioInstance.to(`room_${roomCode}`).emit('game_over', { leaderboard: results.leaderboard });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(` BAD DATA Multi-Game Server Running on Port ${PORT}`);
  console.log(` Local TV View:      http://localhost:${PORT}/receiver/`);
  console.log(` Mobile Controller:  http://localhost:${PORT}/play/`);
  console.log(` Server Base URL:    ${baseUrl}`);
  console.log(`===================================================`);
});
