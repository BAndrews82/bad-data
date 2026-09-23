const fs = require('fs');
const path = require('path');
const he = require('he');

class TriviaService {
  /**
   * Reads custom JSON question files from `data/questions.json` and `data/packs/*.json`.
   * @returns {Array} Array of raw question objects
   */
  static loadCustomQuestions() {
    let customQuestions = [];
    const mainPath = path.join(__dirname, '../data/questions.json');
    const packsDir = path.join(__dirname, '../data/packs');

    // 1. Read main data/questions.json
    if (fs.existsSync(mainPath)) {
      try {
        const raw = fs.readFileSync(mainPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          customQuestions = customQuestions.concat(parsed);
        }
      } catch (err) {
        console.error('[TriviaService] Failed to parse data/questions.json:', err.message);
      }
    }

    // 2. Read any additional .json packs in data/packs/
    if (fs.existsSync(packsDir)) {
      try {
        const files = fs.readdirSync(packsDir);
        files.filter(f => f.endsWith('.json')).forEach(file => {
          try {
            const packRaw = fs.readFileSync(path.join(packsDir, file), 'utf8');
            const packParsed = JSON.parse(packRaw);
            if (Array.isArray(packParsed)) {
              customQuestions = customQuestions.concat(packParsed);
            }
          } catch(e) {}
        });
      } catch(e) {}
    }

    return customQuestions;
  }

  /**
   * Fetches formatted questions according to sourceMode ('mix', 'custom', 'api').
   *
   * @param {number} amount Number of questions (default 10)
   * @param {string} sourceMode 'mix' | 'custom' | 'api'
   * @returns {Promise<Array>} Array of formatted question objects
   */
  static async fetchQuestions(amount = 10, sourceMode = 'mix') {
    const customBank = TriviaService.loadCustomQuestions();

    // Mode: Custom JSON Only
    if (sourceMode === 'custom') {
      if (customBank.length >= amount) {
        TriviaService.shuffleArray(customBank);
        return customBank.slice(0, amount).map((q, idx) => TriviaService.formatQuestion(q, idx));
      } else if (customBank.length > 0) {
        // Pad with fallback if custom bank has fewer than requested amount
        const fallback = TriviaService.getFallbackQuestions(amount);
        const combined = [...customBank, ...fallback];
        TriviaService.shuffleArray(combined);
        return combined.slice(0, amount).map((q, idx) => TriviaService.formatQuestion(q, idx));
      }
    }

    // Mode: OpenTDB API Only
    if (sourceMode === 'api') {
      return await TriviaService.fetchFromOpenTDB(amount);
    }

    // Default Mode: 'mix' (Combines Custom JSON + OpenTDB API)
    try {
      const apiAmount = Math.ceil(amount / 2);
      const customAmount = Math.floor(amount / 2);

      const apiQuestions = await TriviaService.fetchFromOpenTDB(apiAmount);

      let selectedCustom = [];
      if (customBank.length > 0) {
        TriviaService.shuffleArray(customBank);
        selectedCustom = customBank.slice(0, customAmount).map((q, idx) => TriviaService.formatQuestion(q, idx));
      }

      const combined = [...apiQuestions, ...selectedCustom];
      TriviaService.shuffleArray(combined);

      if (combined.length >= amount) {
        return combined.slice(0, amount);
      }

      return TriviaService.getFallbackQuestions(amount);
    } catch (err) {
      console.warn('[TriviaService] Mix fetch failed, falling back to local questions:', err.message);
      return TriviaService.getFallbackQuestions(amount);
    }
  }

  /**
   * Fetches questions directly from OpenTDB API
   */
  static async fetchFromOpenTDB(amount) {
    try {
      const response = await fetch(`https://opentdb.com/api.php?amount=${amount}&type=multiple`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.response_code !== 0 || !data.results || data.results.length === 0) {
        return TriviaService.getFallbackQuestions(amount);
      }

      return data.results.map((q, index) => TriviaService.formatQuestion(q, index));
    } catch (err) {
      console.warn('[TriviaService] OpenTDB API fetch error:', err.message);
      return TriviaService.getFallbackQuestions(amount);
    }
  }

  /**
   * Formats a raw question object (from API, JSON, or Fallback Bank).
   */
  static formatQuestion(q, index) {
    const rawQuestion = he.decode(q.question || '');
    const rawCorrect = he.decode(q.correct_answer || '');
    const rawIncorrects = (q.incorrect_answers || []).map(ans => he.decode(ans || ''));

    // Combine correct and incorrect answers and shuffle
    const allAnswers = [rawCorrect, ...rawIncorrects];
    TriviaService.shuffleArray(allAnswers);

    const correctIndex = allAnswers.indexOf(rawCorrect);

    // Set base cash value based on difficulty
    let baseValue = 1000;
    if (q.difficulty === 'medium') baseValue = 1500;
    if (q.difficulty === 'hard') baseValue = 2000;

    return {
      id: index + 1,
      category: he.decode(q.category || 'General Knowledge'),
      difficulty: q.difficulty || 'medium',
      baseValue: baseValue,
      question: rawQuestion,
      choices: allAnswers,
      correctIndex: correctIndex,
      correctAnswerText: rawCorrect
    };
  }

  /**
   * Fisher-Yates array shuffle helper
   */
  static shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  /**
   * Fallback curated question bank in case API is offline or rate limited.
   */
  static getFallbackQuestions(amount = 10) {
    const customBank = TriviaService.loadCustomQuestions();
    const fallbackBank = [
      ...customBank,
      {
        question: "Which planet in our solar system has the highest gravity?",
        correct_answer: "Jupiter",
        incorrect_answers: ["Saturn", "Earth", "Neptune"],
        category: "Science & Nature",
        difficulty: "easy"
      },
      {
        question: "What is the capital city of Australia?",
        correct_answer: "Canberra",
        incorrect_answers: ["Sydney", "Melbourne", "Brisbane"],
        category: "Geography",
        difficulty: "medium"
      },
      {
        question: "In computer science, what does 'HTTP' stand for?",
        correct_answer: "Hypertext Transfer Protocol",
        incorrect_answers: [
          "Hypertext Terminal Process",
          "High Tech Transfer Program",
          "Hyperlink Text Transformation Protocol"
        ],
        category: "Science: Computers",
        difficulty: "easy"
      },
      {
        question: "Who wrote the play 'Romeo and Juliet'?",
        correct_answer: "William Shakespeare",
        incorrect_answers: ["Charles Dickens", "Mark Twain", "Jane Austen"],
        category: "Entertainment: Books",
        difficulty: "easy"
      },
      {
        question: "What chemical element has the symbol 'Au'?",
        correct_answer: "Gold",
        incorrect_answers: ["Silver", "Aluminum", "Copper"],
        category: "Science & Nature",
        difficulty: "medium"
      }
    ];

    TriviaService.shuffleArray(fallbackBank);
    return fallbackBank.slice(0, amount).map((q, idx) => TriviaService.formatQuestion(q, idx));
  }
}

module.exports = TriviaService;
