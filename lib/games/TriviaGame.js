const BaseGame = require('./BaseGame');
const TriviaService = require('../TriviaService');

class TriviaGame extends BaseGame {
  constructor() {
    super('trivia', 'Bad Data Trivia', 'High-stakes party trivia with decaying cash values & AI roasts');
  }

  async setup(room, options = {}) {
    let questions = [];
    if (Array.isArray(options)) {
      questions = options;
    } else if (Array.isArray(options.questions)) {
      questions = options.questions;
    } else {
      const mode = options.sourceMode || 'mix';
      const packIds = Array.isArray(options.selectedPacks) ? options.selectedPacks : [];
      questions = await TriviaService.fetchQuestions(15, mode, packIds);
    }

    room.questions = questions;
    room.currentQuestionIndex = 0;
    room.status = 'QUESTION';
    room.roundDurationMs = 15000;
    
    room.players.forEach(p => {
      p.score = 0;
      p.answered = false;
      p.answerIndex = null;
      p.cashAtSubmission = 0;
      p.lastRoundGain = 0;
    });

    return room;
  }

  startRound(room) {
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

  handlePlayerInput(room, socketId, payload) {
    if (room.status !== 'QUESTION') {
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
    const durationMs = room.roundDurationMs || 15000;

    // Cash value decreases linearly from baseValue down to 10% of baseValue over 15s
    const minFactor = 0.1;
    const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
    const factor = 1 - progress * (1 - minFactor);

    const cashValue = Math.round((room.currentQuestion.baseValue || 1000) * factor);

    player.answered = true;
    player.answerIndex = payload.answerIndex;
    player.cashAtSubmission = cashValue;

    const allAnswered = room.players.length > 0 && room.players.every(p => p.answered);

    return { success: true, player, cashValue, allAnswered, room };
  }

  evaluateRound(room) {
    room.status = 'REVEAL';
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
        player.lastRoundGain = 0;
      }
    });

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

  advanceNext(room) {
    room.currentQuestionIndex++;
    if (room.currentQuestionIndex >= room.questions.length) {
      room.status = 'GAME_OVER';
      return { isGameOver: true, room };
    }
    return { isGameOver: false, room };
  }

  isGameOver(room) {
    return room.status === 'GAME_OVER' || room.currentQuestionIndex >= room.questions.length;
  }
}

module.exports = TriviaGame;
