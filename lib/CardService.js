const fs = require('fs');
const path = require('path');

class CardService {
  constructor() {
    this.cardsDir = path.join(__dirname, '../data/cards');
  }

  /**
   * Scans data/cards/*.json for available card packs.
   */
  getAvailablePacks() {
    if (!fs.existsSync(this.cardsDir)) {
      try { fs.mkdirSync(this.cardsDir, { recursive: true }); } catch(e) {}
    }

    const packs = [];
    try {
      const files = fs.readdirSync(this.cardsDir);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.cardsDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const packId = file.replace('.json', '');
            packs.push({
              id: packId,
              file,
              name: data.name || packId,
              version: data.version || '1.0',
              blackCount: Array.isArray(data.black) ? data.black.length : 0,
              whiteCount: Array.isArray(data.white) ? data.white.length : 0
            });
          } catch(e) {
            console.error(`[CardService] Error parsing ${file}:`, e.message);
          }
        }
      });
    } catch(err) {
      console.error('[CardService] Error reading cards directory:', err.message);
    }
    return packs;
  }

  /**
   * Loads combined black & white cards from specified pack IDs.
   * If packIds is empty, loads default_deck or all packs.
   */
  loadCombinedDeck(selectedPackIds = []) {
    const available = this.getAvailablePacks();
    let targetPacks = available;

    if (Array.isArray(selectedPackIds) && selectedPackIds.length > 0) {
      targetPacks = available.filter(p => selectedPackIds.includes(p.id));
    }

    if (targetPacks.length === 0) {
      targetPacks = available;
    }

    let combinedBlack = [];
    let combinedWhite = [];

    targetPacks.forEach(p => {
      const filePath = path.join(this.cardsDir, p.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data.black)) {
          combinedBlack.push(...data.black);
        }
        if (Array.isArray(data.white)) {
          combinedWhite.push(...data.white);
        }
      } catch(e) {}
    });

    return {
      black: combinedBlack,
      white: combinedWhite
    };
  }
}

module.exports = new CardService();
