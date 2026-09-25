const https = require('https');

class AiRoaster {
  constructor() {
    // Smart topic-based fallback quips (no money tropes)
    this.fallbackRoasts = [
      "That question was pure academic chaos from start to finish.",
      "A fascinating piece of trivia that completely baffled everyone.",
      "History will remember that answer choice with great confusion.",
      "Science takes another hit on national television.",
      "I have seen search engines struggle less with basic facts.",
      "That answer choice belongs in a museum of bizarre decisions.",
      "An unexpected choice that defied both logic and common sense.",
      "That topic clearly caught the entire room off guard.",
      "A bold response that will surely puzzle future historians.",
      "That answer was so out there, even the satellite lost track.",
      "An absolute masterclass in creative guessing.",
      "That question proved surprisingly treacherous for everyone.",
      "A fascinating moment in the history of unexpected answers.",
      "I suspect the laws of physics were slightly ignored on that choice.",
      "A truly heroic effort at guessing against all odds."
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
    const apiKey = process.env.GEMINI_API_KEY;
    const provider = (process.env.AI_PROVIDER || (apiKey ? 'gemini' : (process.env.OLLAMA_URL ? 'ollama' : 'fallback'))).toLowerCase();

    // System prompt demanding smart, topic-focused trivia commentary with occasional score variety
    const systemPrompt = `You are 'The Co-Host', an exceptionally intelligent, witty, sarcastic, and sharp game show personality in the style of BBC comedy panel shows and 'You Don't Know Jack'.

Generate a 1-sentence smart, clever, or funny observation about this round.

Round Details:
- Category: "${category || 'General Knowledge'}"
- Question: "${question}"
- Correct Answer: "${correctAnswerText}"

GUIDELINES & VARIETY:
1. PRIMARY (80% of the time): Make a smart, witty, clever observation about the QUESTION TOPIC, subject matter, or the specific answer "${correctAnswerText}".
2. OCCASIONAL (20% of the time): You may make a witty comment about score shifts or penalties, but keep it clever and rare.
3. Keep it conversational, sharp, intelligent, and natural when read aloud.
4. Strictly under 16 words.
5. Return ONLY raw plain text. No quotes, no markdown, no emojis.`;

    try {
      let roast = '';
      if (provider === 'gemini' && apiKey) {
        roast = await this.generateGeminiRoast(systemPrompt);
      } else if (provider === 'ollama') {
        roast = await this.generateOllamaRoast(systemPrompt);
      }

      if (roast && this.isValidTopicRoast(roast)) {
        return roast;
      }
    } catch (err) {
      console.warn('[AiRoaster] LLM generation fallback:', err.message);
    }

    // Always return a smart topic-focused fallback quip so the co-host ALWAYS speaks!
    return this.getRandomFallbackRoast();
  }

  /**
   * Validates quality of generated roasts.
   */
  isValidTopicRoast(text) {
    if (!text || text.length < 5) return false;
    return true;
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
