const https = require('https');

class AiRoaster {
  constructor() {
    // Smart topic-based fallback quips (no money tropes)
    this.fallbackRoasts = [
      "That question was pure academic chaos from start to finish.",
      "A fascinating piece of trivia that completely baffled everyone.",
      "History will remember that answer choice with great confusion.",
      "Science takes another hit on national television.",
      "I have seen search engines struggle less with basic facts."
    ];
  }

  /**
   * Generates a witty, smart game show host commentary focused strictly on the question topic.
   */
  async generateRoast(roundData) {
    if (process.env.ENABLE_AI_ROASTS === 'false') {
      return '';
    }

    const { question, correctAnswerText, category } = roundData;
    const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : (process.env.OLLAMA_URL ? 'ollama' : 'none'))).toLowerCase();

    // System prompt demanding smart, topic-focused trivia commentary (NO MONEY TROPES)
    const systemPrompt = `You are 'The Co-Host', an exceptionally intelligent, witty, sarcastic, and sharp game show personality in the style of BBC comedy panel shows and 'You Don't Know Jack'.

Generate a 1-sentence smart, clever, or funny observation about the trivia topic, question, or correct answer.

Round Details:
- Category: "${category || 'General Knowledge'}"
- Question: "${question}"
- Correct Answer: "${correctAnswerText}"

STRICT RULES:
1. Do NOT talk about money, cash, bank accounts, scores, penalties, wallets, or financial ruin.
2. Focus strictly on the QUESTION TOPIC, subject matter, or the specific answer "${correctAnswerText}".
3. Make a smart, clever, witty observation or joke about the facts or subject.
4. Keep it conversational, sharp, and natural when read aloud.
5. Strictly under 16 words.
6. Return ONLY raw plain text. No quotes, no markdown, no emojis.`;

    try {
      let roast = '';
      if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        roast = await this.generateGeminiRoast(systemPrompt);
      } else if (provider === 'ollama') {
        roast = await this.generateOllamaRoast(systemPrompt);
      }

      if (roast && this.isValidTopicRoast(roast)) {
        return roast;
      }
    } catch (err) {
      console.warn('[AiRoaster] LLM generation skipped:', err.message);
    }

    // If no high-quality topic roast was generated, skip roasting (return empty string)
    return '';
  }

  /**
   * Filters out generic money-focused or low-quality roasts.
   */
  isValidTopicRoast(text) {
    if (!text || text.length < 5) return false;
    const bannedWords = ['money', 'cash', 'bank', 'penalty', 'wallet', 'ruin', 'accountant', 'ledger', 'dollars', 'bankrupt', 'financial'];
    const lower = text.toLowerCase();
    return !bannedWords.some(w => lower.includes(w));
  }

  async generateGeminiRoast(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    const modelsToTry = [primaryModel, 'gemini-2.0-flash', 'gemini-1.5-flash'];

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 60,
              temperature: 0.85,
              thinkingConfig: { thinkingBudget: 0 }
            }
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (text) return this.cleanText(text);
        } else {
          const errText = await res.text().catch(() => '');
          console.warn(`[AiRoaster] Gemini model ${model} status ${res.status}: ${errText.substring(0, 150)}`);
        }
      } catch (err) {
        console.warn(`[AiRoaster] Gemini model ${model} attempt failed:`, err.message);
      }
    }
    return '';
  }

  async generateOllamaRoast(prompt) {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return this.cleanText(data.response || '');
    }
    return '';
  }

  cleanText(text) {
    return text
      .replace(/^["']|["']$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }
}

module.exports = new AiRoaster();
