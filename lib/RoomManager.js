const TriviaGame = require('./games/TriviaGame');
const CahGame = require('./games/CahGame');
const cardService = require('./CardService');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.gameRegistry = {
      trivia: new TriviaGame(),
      cah: new CahGame()
    };
  }

  getAvailableGames() {
    return Object.values(this.gameRegistry).map(g => ({
      id: g.gameId,
      name: g.name,
      description: g.description
    }));
  }

  getAvailableCardPacks() {
    return cardService.getAvailablePacks();
  }

  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostSocketId) {
    const code = this.generateRoomCode();
    const room = {
      code,
      hostSocketId,
      status: 'LOBBY',
      selectedGameId: 'cah',
      themeId: 'midnight',
      sfxPack: 'game_show',
      ttsEnabled: false,
      gameEngine: this.gameRegistry.cah,
      players: [],
      timerHandle: null
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.toUpperCase().trim());
  }

  selectGame(code, gameId) {
    const room = this.getRoom(code);
    if (!room || room.status !== 'LOBBY') return null;

    if (this.gameRegistry[gameId]) {
      room.selectedGameId = gameId;
      room.gameEngine = this.gameRegistry[gameId];
    }
    return room;
  }

  selectTheme(code, themeId) {
    const room = this.getRoom(code);
    if (!room) return null;

    const validThemes = ['midnight', 'neon', 'halloween'];
    if (validThemes.includes(themeId)) {
      room.themeId = themeId;
    }
    return room;
  }

  selectSfxPack(code, sfxPack) {
    const room = this.getRoom(code);
    if (!room) return null;

    const validPacks = ['game_show', 'retro', 'subtle'];
    if (validPacks.includes(sfxPack)) {
      room.sfxPack = sfxPack;
    }
    return room;
  }

  setRoomSetting(code, settingKey, value) {
    const room = this.getRoom(code);
    if (!room) return null;

    if (settingKey === 'ttsEnabled') room.ttsEnabled = Boolean(value);
    if (settingKey === 'roasterEnabled') room.roasterEnabled = Boolean(value);
    if (settingKey === 'popularVoteEnabled') room.popularVoteEnabled = Boolean(value);
    return room;
  }

  joinRoom(code, nickname, socketId, vipToken = null) {
    const room = this.getRoom(code);
    if (!room) {
      return { error: 'Room not found. Check the code on the TV screen.' };
    }

    if (room.status !== 'LOBBY') {
      return { error: 'Game is already in progress!' };
    }

    const cleanNickname = (nickname || '').trim().substring(0, 12) || 'Player';
    const existingCount = room.players.filter(p => p.nickname.toLowerCase() === cleanNickname.toLowerCase()).length;
    const finalNickname = existingCount > 0 ? `${cleanNickname} ${existingCount + 1}` : cleanNickname;

    const colors = ['#EF4444', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
    const playerColor = colors[room.players.length % colors.length];

    const isValidVip = (vipToken === 'VIP_AUTHENTICATED_8282');
    if (isValidVip) {
      room.vipSocketId = socketId;
    }

    const player = {
      socketId,
      nickname: finalNickname,
      color: playerColor,
      score: 0,
      answered: false,
      usedRedraw: false,
      isBot: false,
      isVip: isValidVip
    };

    room.players.push(player);
    return { success: true, room, player };
  }

  isVipPlayer(code, socketId) {
    const room = this.getRoom(code);
    if (!room) return false;
    const player = room.players.find(p => p.socketId === socketId);
    return player ? !!player.isVip : false;
  }

  addBotPlayer(code, nickname = null) {
    const room = this.getRoom(code);
    if (!room || room.status !== 'LOBBY') return null;

    const botNames = ['🤖 Bot Alice', '🤖 Bot Bob', '🤖 Bot Charlie', '🤖 Bot Daisy', '🤖 Bot Echo'];
    const existingBotCount = room.players.filter(p => p.isBot).length;
    const botName = nickname || botNames[existingBotCount % botNames.length];

    const botSocketId = `bot_${Math.random().toString(36).substring(2, 9)}`;
    const colors = ['#EF4444', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
    const playerColor = colors[room.players.length % colors.length];

    const player = {
      socketId: botSocketId,
      nickname: botName,
      color: playerColor,
      score: 0,
      answered: false,
      usedRedraw: false,
      isBot: true
    };

    room.players.push(player);
    return { room, player };
  }

  handleDisconnect(socketId) {
    let affectedRoom = null;
    let disconnectedPlayer = null;
    let isHost = false;

    for (const [code, room] of this.rooms.entries()) {
      if (room.hostSocketId === socketId) {
        affectedRoom = room;
        isHost = true;
        this.clearRoomTimer(room);
        this.rooms.delete(code);
        break;
      }

      const playerIndex = room.players.findIndex(p => p.socketId === socketId);
      if (playerIndex !== -1) {
        disconnectedPlayer = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        affectedRoom = room;
        break;
      }
    }

    return { room: affectedRoom, player: disconnectedPlayer, isHost };
  }

  async setupGame(code, options = {}) {
    const room = this.getRoom(code);
    if (!room) return null;

    const engine = this.gameRegistry[room.selectedGameId] || this.gameRegistry.trivia;
    room.gameEngine = engine;
    await engine.setup(room, options);
    return room;
  }

  startRound(code) {
    const room = this.getRoom(code);
    if (!room || !room.gameEngine) return null;

    return room.gameEngine.startRound(room);
  }

  submitPlayerInput(code, socketId, payload) {
    const room = this.getRoom(code);
    if (!room || !room.gameEngine) return { error: 'No active game in room.' };

    return room.gameEngine.handlePlayerInput(room, socketId, payload);
  }

  evaluateRoundResults(code) {
    const room = this.getRoom(code);
    if (!room || !room.gameEngine) return null;

    return room.gameEngine.evaluateRound(room);
  }

  advanceNextRound(code) {
    const room = this.getRoom(code);
    if (!room || !room.gameEngine) return null;

    return room.gameEngine.advanceNext(room);
  }

  resetRoomToLobby(code) {
    const room = this.getRoom(code);
    if (!room) return null;

    this.clearRoomTimer(room);
    room.status = 'LOBBY';
    room.currentRound = 0;

    room.players.forEach(p => {
      p.score = 0;
      p.answered = false;
      p.usedRedraw = false;
      p.hand = [];
      p.submittedCard = null;
    });

    return room;
  }

  setRoomTimer(room, timerHandle) {
    this.clearRoomTimer(room);
    room.timerHandle = timerHandle;
  }

  clearRoomTimer(room) {
    if (room && room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }
  }
}

module.exports = new RoomManager();
