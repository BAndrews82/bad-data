const BaseGame = require('./BaseGame');
const cardService = require('../CardService');

class CahGame extends BaseGame {
  constructor() {
    super('cah', 'Bad Cards', 'Hilarious card-matching game with rotating player judges, popular voting, and AI roasts');
  }

  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  setup(room, options = {}) {
    const selectedPacks = options.selectedCardPacks || options.selectedPacks || [];
    const deckData = cardService.loadCombinedDeck(selectedPacks);

    room.blackDeck = this.shuffle(deckData.black.length > 0 ? deckData.black : [{ id: 'b1', text: 'My doctor warned me about ____.' }]);
    room.whiteDeck = this.shuffle(deckData.white.length > 0 ? deckData.white : ['A rogue AI', 'Eating cold pizza', 'Overthinking']);
    
    room.enablePopularVote = false;
    room.targetScore = 5;
    room.currentRound = 0;
    room.totalRounds = 99; // Play until target score of 5 is reached
    room.judgeIndex = 0;

    room.players.forEach(player => {
      player.score = 0;
      player.usedRedraw = false;
      player.hand = [];
      for (let i = 0; i < 7; i++) {
        if (room.whiteDeck.length > 0) {
          player.hand.push(room.whiteDeck.pop());
        }
      }
    });

    return room;
  }

  startRound(room) {
    if (room.blackDeck.length === 0) {
      const deckData = cardService.loadCombinedDeck([]);
      room.blackDeck = this.shuffle(deckData.black);
    }

    const currentPrompt = room.blackDeck.pop();
    const currentJudge = room.players[room.judgeIndex % room.players.length];

    room.currentPrompt = currentPrompt;
    room.currentJudgeSocketId = currentJudge ? currentJudge.socketId : null;
    room.currentJudgeNickname = currentJudge ? currentJudge.nickname : 'Judge';
    room.status = 'CAH_SUBMIT';
    room.roundSubmissions = new Map(); // socketId -> cardText
    room.popularVotes = new Map(); // socketId -> submissionId
    room.shuffledSubmissions = [];

    // Refill player hands to 7 cards & reset submission status
    room.players.forEach(player => {
      player.submittedCard = null;
      while (player.hand.length < 7 && room.whiteDeck.length > 0) {
        player.hand.push(room.whiteDeck.pop());
      }
    });

    return {
      room,
      roundNum: room.currentRound + 1,
      totalRounds: room.totalRounds,
      prompt: currentPrompt.text,
      judgeSocketId: room.currentJudgeSocketId,
      judgeNickname: room.currentJudgeNickname
    };
  }

  handlePlayerInput(room, socketId, payload) {
    const action = payload.action || (payload.cardIndex !== undefined ? 'SUBMIT_CARD' : payload.submissionId !== undefined ? 'PICK_WINNER' : null);

    if (action === 'DISCARD_REDRAW') {
      return this.handleDiscardRedraw(room, socketId, payload.cardIndices);
    }

    if (action === 'POPULAR_VOTE') {
      return this.handlePopularVote(room, socketId, payload.submissionId);
    }

    if (room.status === 'CAH_SUBMIT') {
      if (socketId === room.currentJudgeSocketId) {
        return { error: 'You are the Judge! You cannot submit a card this round.' };
      }

      const player = room.players.find(p => p.socketId === socketId);
      if (!player) return { error: 'Player not found in room.' };

      const cardIndex = payload.cardIndex;
      if (cardIndex === undefined || cardIndex < 0 || cardIndex >= player.hand.length) {
        return { error: 'Invalid card selected from hand.' };
      }

      const chosenCardText = player.hand[cardIndex];
      player.hand.splice(cardIndex, 1);
      player.submittedCard = chosenCardText;

      room.roundSubmissions.set(socketId, chosenCardText);

      const nonJudgePlayers = room.players.filter(p => p.socketId !== room.currentJudgeSocketId);
      const allSubmitted = nonJudgePlayers.length > 0 && nonJudgePlayers.every(p => room.roundSubmissions.has(p.socketId));

      if (allSubmitted) {
        room.status = 'CAH_JUDGE';
        const rawEntries = [];
        for (const [sId, cardText] of room.roundSubmissions.entries()) {
          const p = room.players.find(pl => pl.socketId === sId);
          rawEntries.push({
            socketId: sId,
            nickname: p ? p.nickname : 'Player',
            cardText
          });
        }

        const shuffled = this.shuffle(rawEntries);
        room.shuffledSubmissions = shuffled.map((entry, idx) => ({
          id: `sub_${idx}`,
          cardText: entry.cardText,
          socketId: entry.socketId,
          nickname: entry.nickname
        }));
      }

      return {
        action: 'SUBMIT_CARD',
        success: true,
        player,
        submittedCount: room.roundSubmissions.size,
        totalRequired: nonJudgePlayers.length,
        allSubmitted,
        room
      };

    } else if (room.status === 'CAH_JUDGE') {
      if (socketId !== room.currentJudgeSocketId) {
        return { error: 'Only the designated Judge can pick the winner!' };
      }

      const submissionId = payload.submissionId;
      const winningSub = room.shuffledSubmissions.find(s => s.id === submissionId);
      if (!winningSub) {
        return { error: 'Invalid submission selected.' };
      }

      const winnerPlayer = room.players.find(p => p.socketId === winningSub.socketId);
      if (winnerPlayer) {
        winnerPlayer.score += 1;
      }

      room.status = 'CAH_REVEAL';
      room.lastWinner = winnerPlayer;
      room.winningSubmission = winningSub;
      room.popularWinnerPlayer = null;

      const isGameOver = room.players.some(p => p.score >= 5);

      return {
        action: 'PICK_WINNER',
        success: true,
        winningSubmission: winningSub,
        winnerPlayer,
        isGameOver,
        prompt: room.currentPrompt.text,
        shuffledSubmissions: room.shuffledSubmissions,
        room
      };
    }

    return { error: 'Invalid game phase.' };
  }

  handleDiscardRedraw(room, socketId, cardIndices = [0, 1, 2]) {
    const player = room.players.find(p => p.socketId === socketId);
    if (!player) return { error: 'Player not found.' };

    if (player.usedRedraw) {
      return { error: 'You have already used your 1 Discard & Redraw swap for this game!' };
    }

    if (room.status !== 'CAH_SUBMIT' && room.status !== 'LOBBY') {
      return { error: 'Redraw can only be used during submission phase.' };
    }

    // Discard up to 3 cards
    const indicesToDiscard = (cardIndices || [0, 1, 2]).filter(i => i >= 0 && i < player.hand.length);
    if (indicesToDiscard.length === 0) return { error: 'No valid cards selected to discard.' };

    // Sort descending to splice without shifting indices
    indicesToDiscard.sort((a, b) => b - a);
    indicesToDiscard.forEach(idx => {
      player.hand.splice(idx, 1);
    });

    // Draw replacements
    while (player.hand.length < 7 && room.whiteDeck.length > 0) {
      player.hand.push(room.whiteDeck.pop());
    }

    player.usedRedraw = true;

    return {
      action: 'DISCARD_REDRAW',
      success: true,
      player,
      hand: player.hand
    };
  }

  handlePopularVote(room, socketId, submissionId) {
    if (room.status !== 'CAH_JUDGE') {
      return { error: 'Popular voting is only active during the judging phase.' };
    }

    if (socketId === room.currentJudgeSocketId) {
      return { error: 'The Judge makes the official pick, not the popular vote.' };
    }

    const sub = room.shuffledSubmissions.find(s => s.id === submissionId);
    if (!sub) return { error: 'Invalid submission selected.' };

    room.popularVotes.set(socketId, submissionId);

    return {
      action: 'POPULAR_VOTE',
      success: true,
      submissionId,
      totalVotesCast: room.popularVotes.size
    };
  }

  advanceNext(room) {
    room.currentRound++;
    room.judgeIndex = (room.judgeIndex + 1) % room.players.length;

    if (room.currentRound >= room.totalRounds) {
      room.status = 'GAME_OVER';
      return { isGameOver: true, room };
    }

    return { isGameOver: false, room };
  }

  isGameOver(room) {
    return room.status === 'GAME_OVER' || room.currentRound >= room.totalRounds;
  }
}

module.exports = CahGame;
