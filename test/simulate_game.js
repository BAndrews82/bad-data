const { io } = require('socket.io-client');
const http = require('http');

async function runSimulation() {
  console.log('====================================================');
  console.log(' Starting Bad Data Automated Integration Simulation ');
  console.log('====================================================');

  // Start the server programmatically
  const express = require('express');
  const { Server } = require('socket.io');
  const path = require('path');
  const TriviaService = require('../lib/TriviaService');
  const roomManager = require('../lib/RoomManager');

  const app = express();
  const server = http.createServer(app);
  const ioServer = new Server(server);

  app.use(express.static(path.join(__dirname, '../public')));

  ioServer.on('connection', (socket) => {
    socket.on('create_room', () => {
      const room = roomManager.createRoom(socket.id);
      socket.join(`room_${room.code}`);
      socket.join(`host_${room.code}`);
      socket.emit('room_created', { roomCode: room.code, players: room.players });
    });

    socket.on('join_room', ({ roomCode, nickname }) => {
      const res = roomManager.joinRoom(roomCode, nickname, socket.id);
      if (res.error) return socket.emit('join_error', { message: res.error });
      socket.join(`room_${res.room.code}`);
      socket.emit('joined_successfully', { roomCode: res.room.code, nickname: res.player.nickname, color: res.player.color });
      ioServer.to(`host_${res.room.code}`).emit('roster_update', { players: res.room.players });
    });

    socket.on('start_game', async ({ roomCode }) => {
      const room = roomManager.getRoom(roomCode);
      if (!room) return;
      const questions = TriviaService.getFallbackQuestions(10);
      roomManager.setupGame(roomCode, questions);
      const activeRoom = roomManager.startQuestionRound(roomCode);
      const q = activeRoom.currentQuestion;

      ioServer.to(`host_${roomCode}`).emit('question_start', {
        questionNum: 1,
        totalQuestions: 10,
        question: q.question,
        choices: q.choices,
        correctIndex: q.correctIndex,
        baseValue: q.baseValue,
        durationMs: 15000
      });

      ioServer.to(`room_${roomCode}`).emit('controller_question_active', {
        questionNum: 1,
        totalQuestions: 10,
        baseValue: q.baseValue,
        durationMs: 15000
      });
    });

    socket.on('submit_answer', ({ roomCode, answerIndex }) => {
      const res = roomManager.submitAnswer(roomCode, socket.id, answerIndex);
      if (res.error) return socket.emit('answer_error', res);
      socket.emit('answer_received', { cashValue: res.cashValue, answerIndex });

      if (res.allAnswered) {
        const results = roomManager.evaluateRoundResults(roomCode);
        ioServer.to(`host_${roomCode}`).emit('round_reveal', results);
        results.players.forEach(p => {
          const isCorrect = p.answerIndex === results.correctIndex;
          ioServer.to(p.socketId).emit('round_result_controller', {
            isCorrect,
            cashChange: p.lastRoundGain,
            totalScore: p.score
          });
        });
      }
    });
  });

  await new Promise((resolve) => server.listen(3001, resolve));
  console.log('[Test Server] Listening on http://localhost:3001');

  const SERVER_URL = 'http://localhost:3001';

  // 1. Connect Host Socket (TV Display)
  const hostSocket = io(SERVER_URL);
  let roomCode = '';
  let correctIdx = -1;

  await new Promise((resolve) => {
    hostSocket.on('connect', () => {
      console.log('[Test] Host connected. Creating room...');
      hostSocket.emit('create_room');
    });

    hostSocket.on('room_created', (data) => {
      roomCode = data.roomCode;
      console.log(`[Test SUCCESS] Room Created! Code: ${roomCode}`);
      resolve();
    });
  });

  // 2. Connect Player 1 (Alice)
  const p1Socket = io(SERVER_URL);
  await new Promise((resolve) => {
    p1Socket.on('connect', () => {
      console.log('[Test] Player 1 (Alice) connecting...');
      p1Socket.emit('join_room', { roomCode, nickname: 'Alice' });
    });
    p1Socket.on('joined_successfully', (data) => {
      console.log(`[Test SUCCESS] Player 1 joined room ${data.roomCode} as '${data.nickname}'`);
      resolve();
    });
  });

  // 3. Connect Player 2 (Bob)
  const p2Socket = io(SERVER_URL);
  await new Promise((resolve) => {
    p2Socket.on('connect', () => {
      console.log('[Test] Player 2 (Bob) connecting...');
      p2Socket.emit('join_room', { roomCode, nickname: 'Bob' });
    });
    p2Socket.on('joined_successfully', (data) => {
      console.log(`[Test SUCCESS] Player 2 joined room ${data.roomCode} as '${data.nickname}'`);
      resolve();
    });
  });

  // 4. Host Starts Game
  await new Promise((resolve) => {
    hostSocket.on('question_start', (data) => {
      correctIdx = data.correctIndex;
      console.log(`[Test SUCCESS] Question Round 1 Started: "${data.question}"`);
      console.log(`[Test] Correct Answer Index is: ${correctIdx}`);
      resolve();
    });
    hostSocket.emit('start_game', { roomCode });
  });

  // 5. Submit Answers: Alice submits CORRECT answer, Bob submits WRONG answer
  const wrongIdx = (correctIdx + 1) % 4;

  const revealPromise = new Promise((resolve) => {
    hostSocket.on('round_reveal', (results) => {
      console.log('[Test SUCCESS] Round Reveal received by Host!');
      console.log('Leaderboard Standings:');
      results.leaderboard.forEach((p, idx) => {
        console.log(`  #${idx + 1} ${p.nickname}: Score $${p.score} (Round Change: ${p.lastRoundGain >= 0 ? '+' : ''}$${p.lastRoundGain})`);
      });

      // Assertions
      const alice = results.leaderboard.find(p => p.nickname === 'Alice');
      const bob = results.leaderboard.find(p => p.nickname === 'Bob');

      if (alice.score > 0 && bob.score < 0) {
        console.log('====================================================');
        console.log(' ALL INTEGRATION TESTS PASSED CLEANLY!              ');
        console.log(' Alice scored positive cash for correct answer!    ');
        console.log(' Bob lost cash penalty for wrong answer!            ');
        console.log('====================================================');
        resolve(true);
      } else {
        console.error('Test Failed: Expected Alice score > 0 and Bob score < 0');
        resolve(false);
      }
    });
  });

  p1Socket.emit('submit_answer', { roomCode, answerIndex: correctIdx });
  p2Socket.emit('submit_answer', { roomCode, answerIndex: wrongIdx });

  const passed = await revealPromise;

  // Cleanup
  p1Socket.disconnect();
  p2Socket.disconnect();
  hostSocket.disconnect();
  server.close();

  process.exit(passed ? 0 : 1);
}

runSimulation().catch((err) => {
  console.error('Simulation Failed with error:', err);
  process.exit(1);
});
