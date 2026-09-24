const https = require('https');

class AiRoaster {
  constructor() {
    this.fallbackRoasts = [
      "Ouch! That cash penalty hurt more than stepping on a Lego at 2 AM!",
      "Someone check the ledger, because these bank accounts are looking tragic!",
      "That answer choice was so wrong, even the server felt embarrassed!",
      "And just like that, financial stability has collapsed across the board!",
      "Pro tip: guessing randomly is great until your bank balance goes negative!",
      "That penalty hit harder than a surprise software update in the middle of a game!",
      "A moment of silence for everyone who just lost a small fortune!",
      "Bankruptcies are being filed in real time right now!",
      "Somebody call an accountant because we have a financial disaster on stage!",
      "Big risk, zero reward! That is the Bad Data guarantee!",
      "Did anyone actually read the question, or did you all just press random buttons?",
      "That question was middle school trivia, yet here we are in academic ruin!",
      "I have seen houseplants make better choices than this group!",
      "Imagine losing real money on a question your grandmother could answer!",
      "That answer was so obvious, even a malfunctioning calculator would get it right!"
    ];
  }

  /**
   * Generates a witty game show host roast/commentary for the current round result.
   */
  async generateRoast(roundData) {
    if (process.env.ENABLE_AI_ROASTS === 'false') {
      return '';
    }

    const { question, correctAnswerText, leaderboard, players } = roundData;
    const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : (process.env.OLLAMA_URL ? 'ollama' : 'fallback'))).toLowerCase();

    // Summarize top leader and biggest loss for AI context
    const topPlayer = leaderboard && leaderboard[0] ? leaderboard[0] : null;
    const worstGainPlayer = players ? [...players].sort((a, b) => a.lastRoundGain - b.lastRoundGain)[0] : null;

    let playerSummary = '';
    if (topPlayer) {
      playerSummary += `Leader: ${topPlayer.nickname} ($${topPlayer.score}). `;
    }
    if (worstGainPlayer && worstGainPlayer.lastRoundGain < 0) {
      playerSummary += `Biggest Loss: ${worstGainPlayer.nickname} lost $${Math.abs(worstGainPlayer.lastRoundGain)}.`;
    }

    const systemPrompt = `You are 'The Roaster', a ruthless, sarcastic, witty, and mean Jackbox-style game show co-host. Generate a 1-sentence funny, biting roast or sarcastic commentary about this round.

Round Context:
- Question: "${question}"
- Correct Answer: "${correctAnswerText}"
- ${playerSummary}

Guidelines & Variety (Pick ONE angle that makes for the funnier, meaner roast):
1. Mock the money losers or the greedy score leader.
2. Make a sarcastic or mean comment about the trivia question itself or how obvious/absurd the correct answer is.
3. Insult the intelligence or performance of the players in general for failing or guessing.
4. Deliver a witty, sharp, snarky observation about the question topic or answer.

Rules:
- Strictly under 20 words.
- High sarcasm, witty, mean, and dramatic.
- Return ONLY raw text sentence. No quotes, no markdown, no emojis.`;

    try {
      if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        return await this.generateGeminiRoast(systemPrompt);
      } else if (provider === 'ollama') {
        return await this.generateOllamaRoast(systemPrompt);
      }
    } catch (err) {
      console.warn('[AiRoaster] LLM generation failed, using fallback host quip:', err.message);
    }

    // Return random fallback snarky quip
    return this.getRandomFallbackRoast();
  }

  async generateGeminiRoast(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    const modelsToTry = [primaryModel, 'gemini-2.0-flash', 'gemini-1.5-flash'];

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 60,
              temperature: 0.9,
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
    throw new Error('Gemini API requests failed across all attempted models.');
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
    throw new Error(`Ollama API returned status ${res.status}`);
  }

  getRandomFallbackRoast() {
    const idx = Math.floor(Math.random() * this.fallbackRoasts.length);
    return this.fallbackRoasts[idx];
  }

  cleanText(text) {
    return text
      .replace(/^["']|["']$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }
}

module.exports = new AiRoaster();
