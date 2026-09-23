const he = require('he');

class TriviaService {
  /**
   * Fetches multiple choice questions from Open Trivia DB API.
   * Decodes HTML entities and shuffles answer choices.
   * Provides fallback questions if the API request fails or rate limits.
   *
   * @param {number} amount Number of questions to fetch (default 10)
   * @returns {Promise<Array>} Array of formatted question objects
   */
  static async fetchQuestions(amount = 10) {
    try {
      const response = await fetch(`https://opentdb.com/api.php?amount=${amount}&type=multiple`);
      if (!response.ok) {
        throw new Error(`OpenTDB returned HTTP ${response.status}`);
      }
      const data = await response.json();
      
      if (data.response_code !== 0 || !data.results || data.results.length === 0) {
        console.warn('[TriviaService] OpenTDB response code non-zero or empty, using fallback trivia.');
        return TriviaService.getFallbackQuestions(amount);
      }

      return data.results.map((q, index) => TriviaService.formatQuestion(q, index));
    } catch (err) {
      console.error('[TriviaService] Error fetching from OpenTDB:', err.message);
      return TriviaService.getFallbackQuestions(amount);
    }
  }

  /**
   * Formats a raw question object from OpenTDB.
   */
  static formatQuestion(q, index) {
    const rawQuestion = he.decode(q.question);
    const rawCorrect = he.decode(q.correct_answer);
    const rawIncorrects = q.incorrect_answers.map(ans => he.decode(ans));

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
    const fallbackBank = [
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
      },
      {
        question: "Which country hosted the 2016 Summer Olympic Games?",
        correct_answer: "Brazil",
        incorrect_answers: ["China", "United Kingdom", "Russia"],
        category: "Sports",
        difficulty: "easy"
      },
      {
        question: "What year was the original iPhone released?",
        correct_answer: "2007",
        incorrect_answers: ["2005", "2008", "2010"],
        category: "History",
        difficulty: "medium"
      },
      {
        question: "Which programming language was created by Brendan Eich in 1995?",
        correct_answer: "JavaScript",
        incorrect_answers: ["Python", "Java", "C++"],
        category: "Science: Computers",
        difficulty: "hard"
      },
      {
        question: "How many bones are there in an adult human body?",
        correct_answer: "206",
        incorrect_answers: ["210", "195", "250"],
        category: "Science & Nature",
        difficulty: "easy"
      },
      {
        question: "What is the longest river in the world?",
        correct_answer: "Nile",
        incorrect_answers: ["Amazon", "Mississippi", "Yangtze"],
        category: "Geography",
        difficulty: "medium"
      }
    ];

    return fallbackBank.slice(0, amount).map((q, idx) => TriviaService.formatQuestion(q, idx));
  }
}

module.exports = TriviaService;
