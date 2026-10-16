const { io } = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const roomManager = require('../lib/RoomManager');
const cardService = require('../lib/CardService');

async function testCahSocketIntegration() {
  console.log('====================================================');
  console.log(' Testing Bad Cards Full Socket Integration Flow    ');
  console.log('====================================================');

  const app = express();
  const server = http.createServer(app);
  const ioServer = new Server(server);

  const PORT = 3002;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[Test Server] Listening on http://localhost:${PORT}`);

  // Wire up the same socket events as server.js
  ioServer.on('connection', (socket) => {
    socket.on('create_room', () => {
      const room = roomManager.createRoom(socket.id);
      socket.join(`room_${room.code}`);
      socket.join(`host_${room.code}`);
      socket.emit('room_created', {
        roomCode: room.code,
        players: room.players,
        selectedGameId: room.selectedGameId
      });
    });

    socket.on('join_room', ({ roomCode, nickname, avatar, color }) => {
      const res = roomManager.joinRoom(roomCode, nickname, socket.id, null, avatar, color);
      if (res.error) return socket.emit('join_error', { message: res.error });
      socket.join(`room_${res.room.code}`);
      socket.emit('joined_successfully', {
        roomCode: res.room.code,
        nickname: res.player.nickname
      });
      ioServer.to(`host_${res.room.code}`).emit('roster_update', { players: res.room.players });
    });

    socket.on('start_game', async ({ roomCode }) => {
      const room = roomManager.getRoom(roomCode);
      if (!room) return;

      if (room.selectedGameId === 'cah' && room.players.length < 3) {
        return socket.emit('error_message', { message: 'Bad Cards requires at least 3 players to start!' });
      }

      await roomManager.setupGame(roomCode, {
        selectedCardPacks: [],
        enablePopularVote: true,
        targetScore: 3
      });

      ioServer.to(`host_${roomCode}`).emit('game_starting_notice', { selectedGameId: room.selectedGameId });
      ioServer.to(`room_${roomCode}`).emit('game_starting_notice', { selectedGameId: room.selectedGameId });

      // Run round
      const roundData = roomManager.startRound(roomCode);
      const submissionDurationMs = 60000;
      const { roundNum, totalRounds, prompt, judgeSocketId, judgeNickname } = roundData;

      ioServer.to(`host_${roomCode}`).emit('cah_round_start', {
        roundNum,
        totalRounds,
        prompt,
        judgeNickname,
        targetScore: room.targetScore,
        durationMs: submissionDurationMs,
        players: room.players.map(p => ({
          nickname: p.nickname,
          score: p.score,
          isJudge: p.socketId === judgeSocketId
        }))
      });

      room.players.forEach(p => {
        ioServer.to(p.socketId).emit('cah_controller_round', {
          roundNum,
          prompt,
          isJudge: p.socketId === judgeSocketId,
          judgeNickname,
          hand: p.hand
        });
      });
    });
  });

  const hostSocket = io(`http://localhost:${PORT}`);
  const client1 = io(`http://localhost:${PORT}`);
  const client2 = io(`http://localhost:${PORT}`);
  const client3 = io(`http://localhost:${PORT}`);

  await new Promise(resolve => hostSocket.on('connect', resolve));
  console.log('[Test] Host connected. Requesting room creation...');

  const roomCode = await new Promise(resolve => {
    hostSocket.emit('create_room');
    hostSocket.on('room_created', (data) => {
      console.log(`[Test SUCCESS] Room Created: ${data.roomCode}, Default Game: ${data.selectedGameId}`);
      if (data.selectedGameId !== 'cah') {
        throw new Error('Default game must be cah!');
      }
      resolve(data.roomCode);
    });
  });

  // Test start with < 3 players (should emit error_message)
  console.log('[Test] Testing start with 0 players (should fail)...');
  const errorMsg = await new Promise(resolve => {
    hostSocket.emit('start_game', { roomCode });
    hostSocket.on('error_message', (data) => {
      console.log(`[Test SUCCESS] Received expected error: "${data.message}"`);
      resolve(data.message);
    });
  });
  if (!errorMsg.includes('requires at least 3 players')) {
    throw new Error('Expected 3 player requirement error!');
  }

  // Join 3 players
  console.log('[Test] Joining 3 players...');
  await new Promise(r => {
    client1.once('joined_successfully', r);
    client1.emit('join_room', { roomCode, nickname: 'Alice', avatar: '🚀', color: '#10B981' });
  });
  await new Promise(r => {
    client2.once('joined_successfully', r);
    client2.emit('join_room', { roomCode, nickname: 'Bob', avatar: '🍕', color: '#EF4444' });
  });
  await new Promise(r => {
    client3.once('joined_successfully', r);
    client3.emit('join_room', { roomCode, nickname: 'Charlie', avatar: '🐱', color: '#3B82F6' });
  });
  console.log('[Test SUCCESS] 3 players joined successfully.');

  // Now start game
  console.log('[Test] Starting Bad Cards game with 3 players...');
  const roundStartPromise = new Promise(resolve => {
    hostSocket.on('cah_round_start', (data) => {
      console.log(`[Test SUCCESS] cah_round_start received by host! Round: ${data.roundNum}, Judge: ${data.judgeNickname}, Prompt: "${data.prompt}"`);
      resolve(data);
    });
  });

  hostSocket.emit('start_game', { roomCode });
  const roundData = await roundStartPromise;

  if (!roundData.prompt || !roundData.judgeNickname) {
    throw new Error('Invalid round start data');
  }

  // Cleanup
  hostSocket.disconnect();
  client1.disconnect();
  client2.disconnect();
  client3.disconnect();
  server.close();
  console.log('====================================================');
  console.log(' ALL BAD CARDS SOCKET TESTS PASSED CLEANLY!         ');
  console.log('====================================================');
}

testCahSocketIntegration().catch(err => {
  console.error('[Test FAILED]:', err);
  process.exit(1);
});
