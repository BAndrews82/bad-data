class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  /**
   * Generates a 4-character room code excluding confusing characters (0/O, 1/I/L).
   */
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

  /**
   * Creates a new room managed by hostSocketId.
   */
  createRoom(hostSocketId) {
    const code = this.generateRoomCode();
    const room = {
      code,
      hostSocketId,
      status: 'LOBBY', // LOBBY, QUESTION, REVEAL, GAME_OVER
      players: [],
      questions: [],
      currentQuestionIndex: -1,
      currentQuestion: null,
      roundStartTime: null,
      roundDurationMs: 15000,
      timerHandle: null
    };
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Retrieves a room by its 4-character code (case-insensitive).
   */
  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.toUpperCase().trim());
  }

  /**
   * Joins a player to a room.
   */
  joinRoom(code, nickname, socketId) {
    const room = this.getRoom(code);
    if (!room) {
      return { error: 'Room not found. Check the code on the TV screen.' };
    }

    if (room.status !== 'LOBBY') {
      return { error: 'Game is already in progress!' };
    }

    const cleanNickname = (nickname || '').trim().substring(0, 12) || 'Player';

    // Prevent duplicate nicknames in the same room
    const existingCount = room.players.filter(p => p.nickname.toLowerCase() === cleanNickname.toLowerCase()).length;
    const finalNickname = existingCount > 0 ? `${cleanNickname} ${existingCount + 1}` : cleanNickname;

    const colors = ['#EF4444', '#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];
    const playerColor = colors[room.players.length % colors.length];

    const player = {
      socketId,
      nickname: finalNickname,
      color: playerColor,
      score: 0,
      answered: false,
      answerIndex: null,
      cashAtSubmission: 0,
      lastRoundGain: 0
    };

    room.players.push(player);
    return { success: true, room, player };
  }

  /**
   * Removes a socket (host or player) from any room they belong to.
   */
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

  /**
   * Initializes a new game with a set of questions.
   */
  setupGame(code, questions) {
    const room = this.getRoom(code);
    if (!room) return null;

    room.questions = questions;
    room.currentQuestionIndex = 0;
    room.status = 'QUESTION';
    room.players.forEach(p => {
      p.score = 0;
      p.answered = false;
      p.answerIndex = null;
      p.cashAtSubmission = 0;
      p.lastRoundGain = 0;
    });

    return room;
  }

  /**
   * Starts a question round.
   */
  startQuestionRound(code) {
    const room = this.getRoom(code);
    if (!room) return null;

    const question = room.questions[room.currentQuestionIndex];
    if (!question) return null;

    room.status = 'QUESTION';
    room.currentQuestion = question;
    room.roundStartTime = Date.now();
    room.players.forEach(p => {
      p.answered = false;
      p.answerIndex = null;
      p.cashAtSubmission = 0;
      p.lastRoundGain = 0;
    });

    return room;
  }

  /**
   * Submits an answer for a player.
   * Calculates the remaining cash value at the exact time of submission.
   */
  submitAnswer(code, socketId, answerIndex) {
    const room = this.getRoom(code);
    if (!room || room.status !== 'QUESTION') {
      return { error: 'Question round is not active.' };
    }

    const player = room.players.find(p => p.socketId === socketId);
    if (!player) {
      return { error: 'Player not found in room.' };
    }

    if (player.answered) {
      return { error: 'Answer already submitted for this question.' };
    }

    const elapsedMs = Date.now() - room.roundStartTime;
    const durationMs = room.roundDurationMs;

    // Cash value decreases linearly from baseValue down to 10% of baseValue over 15s
    const minFactor = 0.1;
    const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
    const factor = 1 - progress * (1 - minFactor);

    const cashValue = Math.round(room.currentQuestion.baseValue * factor);

    player.answered = true;
    player.answerIndex = answerIndex;
    player.cashAtSubmission = cashValue;

    const allAnswered = room.players.length > 0 && room.players.every(p => p.answered);

    return { success: true, player, cashValue, allAnswered, room };
  }

  /**
   * Evaluates scores at round end.
   */
  evaluateRoundResults(code) {
    const room = this.getRoom(code);
    if (!room) return null;

    room.status = 'REVEAL';
    this.clearRoomTimer(room);

    const correctIdx = room.currentQuestion.correctIndex;

    room.players.forEach(player => {
      if (player.answered) {
        if (player.answerIndex === correctIdx) {
          player.lastRoundGain = player.cashAtSubmission;
          player.score += player.cashAtSubmission;
        } else {
          player.lastRoundGain = -player.cashAtSubmission;
          player.score -= player.cashAtSubmission;
        }
      } else {
        // No answer submitted
        player.lastRoundGain = 0;
      }
    });

    // Sort players by score descending
    const leaderboard = [...room.players].sort((a, b) => b.score - a.score);

    const isLastQuestion = room.currentQuestionIndex >= room.questions.length - 1;
    if (isLastQuestion) {
      room.status = 'GAME_OVER';
    }

    return {
      room,
      question: room.currentQuestion,
      correctIndex: correctIdx,
      correctAnswerText: room.currentQuestion.correctAnswerText,
      players: room.players,
      leaderboard,
      isLastQuestion
    };
  }

  /**
   * Moves to next question or ends game.
   */
  advanceNextQuestion(code) {
    const room = this.getRoom(code);
    if (!room) return null;

    room.currentQuestionIndex++;
    if (room.currentQuestionIndex >= room.questions.length) {
      room.status = 'GAME_OVER';
      return { isGameOver: true, room };
    }

    return { isGameOver: false, room };
  }

  /**
   * Helper to set active round timer handle
   */
  setRoomTimer(room, timerHandle) {
    this.clearRoomTimer(room);
    room.timerHandle = timerHandle;
  }

  /**
   * Helper to clear active round timer
   */
  clearRoomTimer(room) {
    if (room && room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }
  }
}

module.exports = new RoomManager();
