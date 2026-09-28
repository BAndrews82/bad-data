class BaseGame {
  constructor(gameId, name, description) {
    this.gameId = gameId;
    this.name = name;
    this.description = description;
  }

  /**
   * Initializes state for a new game room instance.
   */
  setup(room, options = {}) {
    throw new Error('BaseGame.setup() must be implemented by subclass');
  }

  /**
   * Starts or advances a round.
   */
  startRound(io, roomCode) {
    throw new Error('BaseGame.startRound() must be implemented by subclass');
  }

  /**
   * Handles player inputs (e.g. trivia answer selection, card submission, judge pick).
   */
  handlePlayerInput(io, roomCode, socketId, payload) {
    throw new Error('BaseGame.handlePlayerInput() must be implemented by subclass');
  }

  /**
   * Evaluates end of round or phase results.
   */
  evaluateRound(io, roomCode) {
    throw new Error('BaseGame.evaluateRound() must be implemented by subclass');
  }

  /**
   * Checks if victory/game-over conditions are met.
   */
  isGameOver(room) {
    throw new Error('BaseGame.isGameOver() must be implemented by subclass');
  }
}

module.exports = BaseGame;
