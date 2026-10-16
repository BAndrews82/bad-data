const TriviaGame = require('./games/TriviaGame');
const CahGame = require('./games/CahGame');
const cardService = require('./CardService');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.disconnectTimers = new Map();
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
      sfxPack: 'midnight',
      ttsEnabled: false,
      soundEnabled: true,
      gameEngine: this.gameRegistry.cah,
      targetScore: 5,
      selectedCardPacks: [],
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

    const validThemes = ['midnight', 'neon', 'matrix', 'gameshow', 'halloween', 'retro'];
    if (validThemes.includes(themeId)) {
      room.themeId = themeId;
      room.sfxPack = themeId;
    }
    return room;
  }

  selectSfxPack(code, sfxPack) {
    const room = this.getRoom(code);
    if (!room) return null;

    const validPacks = ['midnight', 'neon', 'matrix', 'gameshow', 'halloween', 'retro', 'game_show', 'subtle'];
    if (validPacks.includes(sfxPack)) {
      const map = { game_show: 'gameshow', subtle: 'midnight' };
      const unifiedTheme = map[sfxPack] || sfxPack;
      room.themeId = unifiedTheme;
      room.sfxPack = unifiedTheme;
    }
    return room;
  }

  setRoomSetting(code, settingKey, value) {
    const room = this.getRoom(code);
    if (!room) return null;

    if (settingKey === 'ttsEnabled') room.ttsEnabled = Boolean(value);
    if (settingKey === 'soundEnabled') room.soundEnabled = Boolean(value);
    if (settingKey === 'roasterEnabled') room.roasterEnabled = Boolean(value);
    if (settingKey === 'popularVoteEnabled') room.popularVoteEnabled = Boolean(value);
    if (settingKey === 'targetScore') room.targetScore = Number(value) || 5;
    return room;
  }

  joinRoom(code, nickname, socketId, vipToken = null, avatar = null, customColor = null) {
    const room = this.getRoom(code);
    if (!room) {
      return { error: 'Room not found. Check the code on the TV screen.' };
    }

    if (room.status !== 'LOBBY') {
      return { error: 'Game is already in progress!' };
    }

    const rawNickname = (nickname || '').trim().substring(0, 12) || 'Player';
    const cleanNickname = (rawNickname.replace(/[<>&"']/g, '') || 'Player').substring(0, 12);
    const existingCount = room.players.filter(p => p.nickname.toLowerCase() === cleanNickname.toLowerCase()).length;
    const finalNickname = existingCount > 0 ? `${cleanNickname} ${existingCount + 1}` : cleanNickname;

    const AVATARS = ['👾', '🍕', '🤖', '👻', '🤠', '🦊', '⚡', '🥑', '🚀', '💎'];
    const chosenAvatar = (avatar && typeof avatar === 'string' && avatar.trim()) ? avatar.trim() : AVATARS[room.players.length % AVATARS.length];
    const colors = ['#EF4444', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
    const playerColor = (customColor && typeof customColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(customColor)) ? customColor : colors[room.players.length % colors.length];

    const targetVipToken = process.env.VIP_TOKEN || 'VIP_AUTHENTICATED_8282';
    const isValidVip = (vipToken === targetVipToken);
    if (isValidVip) {
      room.vipSocketId = socketId;
    }

    const sessionToken = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

    const player = {
      socketId,
      sessionToken,
      nickname: finalNickname,
      avatar: chosenAvatar,
      color: playerColor,
      score: 0,
      answered: false,
      usedRedraw: false,
      isBot: false,
      isVip: isValidVip,
      isDisconnected: false,
      disconnectedAt: null,
      correctCount: 0,
      currentStreak: 0,
      bestStreak: 0,
      streakBonus: 0,
      cahWins: 0,
      popularWins: 0
    };

    room.players.push(player);
    return { success: true, room, player };
  }

  reconnectPlayer(code, sessionToken, newSocketId) {
    const room = this.getRoom(code);
    if (!room) return null;

    const player = room.players ? room.players.find(p => p.sessionToken === sessionToken) : null;
    if (!player) return null;

    if (this.disconnectTimers.has(player.sessionToken)) {
      clearTimeout(this.disconnectTimers.get(player.sessionToken));
      this.disconnectTimers.delete(player.sessionToken);
    }

    const oldSocketId = player.socketId;
    player.socketId = newSocketId;
    player.isDisconnected = false;
    player.disconnectedAt = null;

    if (player.isVip) {
      room.vipSocketId = newSocketId;
    }

    if (room.selectedGameId === 'cah') {
      if (room.currentJudgeSocketId === oldSocketId || (room.currentJudgeSessionToken && room.currentJudgeSessionToken === player.sessionToken)) {
        room.currentJudgeSocketId = newSocketId;
      }

      if (room.roundSubmissions && room.roundSubmissions.has(oldSocketId)) {
        const submitted = room.roundSubmissions.get(oldSocketId);
        room.roundSubmissions.delete(oldSocketId);
        room.roundSubmissions.set(newSocketId, submitted);
      }

      if (room.popularVotes && room.popularVotes.has(oldSocketId)) {
        const vote = room.popularVotes.get(oldSocketId);
        room.popularVotes.delete(oldSocketId);
        room.popularVotes.set(newSocketId, vote);
      }

      if (room.shuffledSubmissions) {
        room.shuffledSubmissions.forEach(sub => {
          if (sub.socketId === oldSocketId) {
            sub.socketId = newSocketId;
          }
        });
      }
    }

    return { success: true, room, player };
  }

  isVipPlayer(code, socketId) {
    const room = this.getRoom(code);
    if (!room) return false;
    const player = room.players.find(p => p.socketId === socketId);
    return player ? !!player.isVip : (room.vipSocketId === socketId);
  }

  addBotPlayer(code, nickname = null, avatar = null) {
    const room = this.getRoom(code);
    if (!room || room.status !== 'LOBBY') return null;

    const botNames = ['🤖 Bot Alice', '🤖 Bot Bob', '🤖 Bot Charlie', '🤖 Bot Daisy', '🤖 Bot Echo'];
    const botAvatars = ['🤖', '👾', '⚡', '🦊', '🚀', '👻'];
    const existingBotCount = room.players.filter(p => p.isBot).length;
    const botName = nickname || botNames[existingBotCount % botNames.length];
    const botAvatar = avatar || botAvatars[existingBotCount % botAvatars.length];

    const botSocketId = `bot_${Math.random().toString(36).substring(2, 9)}`;
    const colors = ['#EF4444', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
    const playerColor = colors[room.players.length % colors.length];

    const player = {
      socketId: botSocketId,
      sessionToken: `bot_token_${botSocketId}`,
      nickname: botName,
      avatar: botAvatar,
      color: playerColor,
      score: 0,
      answered: false,
      usedRedraw: false,
      isBot: true,
      isDisconnected: false,
      correctCount: 0,
      currentStreak: 0,
      bestStreak: 0,
      streakBonus: 0,
      cahWins: 0,
      popularWins: 0
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

      const player = room.players.find(p => p.socketId === socketId);
      if (player) {
        disconnectedPlayer = player;
        affectedRoom = room;

        if (player.isBot) {
          const idx = room.players.indexOf(player);
          if (idx !== -1) room.players.splice(idx, 1);
        } else {
          player.isDisconnected = true;
          player.disconnectedAt = Date.now();

          if (this.disconnectTimers.has(player.sessionToken)) {
            clearTimeout(this.disconnectTimers.get(player.sessionToken));
          }

          const tHandle = setTimeout(() => {
            this.disconnectTimers.delete(player.sessionToken);
            const pIdx = room.players.findIndex(p => p.sessionToken === player.sessionToken);
            if (pIdx !== -1 && room.players[pIdx].isDisconnected) {
              room.players.splice(pIdx, 1);
            }
          }, 60000);
          this.disconnectTimers.set(player.sessionToken, tHandle);
        }
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
      p.correctCount = 0;
      p.cahWins = 0;
      p.popularWins = 0;
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
