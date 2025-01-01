import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from "./logger.js";

class PositionCache {
  constructor() {
    this.cacheFile = path.join(process.cwd(), 'position-cache.json');
    this.positions = new Map();
    this.loadCache();
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        this.positions = new Map(Object.entries(data));
        logger.info('[CACHE] Successfully loaded position cache', {
          positionCount: this.positions.size
        });
      }
    } catch (error) {
      logger.error('[CACHE] Error loading position cache:', error);
      this.positions = new Map();
    }
  }

  saveCache() {
    try {
      const data = Object.fromEntries(this.positions);
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('[CACHE] Error saving position cache:', error);
    }
  }

  generatePositionId(symbol, position) {
    const positionString = [
      symbol,
      position.size.toString(),
      position.costOfTrades.toString(),
      Math.abs(position.costOfTrades / position.size).toFixed(4)
    ].join('-');

    return crypto
      .createHash('sha256')
      .update(positionString)
      .digest('hex')
      .slice(0, 12);
  }

  async findOrCreatePosition(symbol, position, accountState) {
    const positionId = this.generatePositionId(symbol, position);
    let cachedPosition = this.positions.get(positionId);
    
    if (!cachedPosition) {
      const direction = position.size > 0 ? 'long' : 'short';
      const entryPrice = Math.abs(position.costOfTrades / position.size);
      
      cachedPosition = {
        id: positionId,
        symbol,
        direction,
        openedAt: Date.now(),
        initialData: {
          size: position.size,
          costOfTrades: position.costOfTrades,
          accountBalance: accountState.balance,
          openPrice: entryPrice
        },
        state: {
          hasReachedThreshold: false,
          highestProgress: 0,
          lowestProgress: 0,
          thresholdHits: 0,
          takeProfitHits: 0,
          stopLossHits: 0,
          trailingStopHits: 0,
          highestPrice: 0,
          lowestPrice: Infinity,
          trailingStopPrice: null,
          entryPrice: entryPrice,
          initialBalance: accountState.balance,
          lastCheckedPrice: null,
          currentDirection: direction,
          isClosing: false,
          trailingStatusMessage: "Waiting for threshold..."
        }
      };
      
      this.positions.set(positionId, cachedPosition);
      this.saveCache();
      
      logger.info(`[CACHE] Created new position entry`, {
        positionId,
        symbol,
        direction,
        size: position.size,
        entryPrice: entryPrice.toFixed(4)
      });
    }
    
    return cachedPosition;
  }

  getPosition(positionId) {
    return this.positions.get(positionId);
  }

  updatePositionState(positionId, newState) {
    const position = this.positions.get(positionId);
    if (position) {
      position.state = { ...position.state, ...newState };
      this.positions.set(positionId, position);
      this.saveCache();
      return true;
    }
    return false;
  }

  removePosition(positionId) {
    const position = this.positions.get(positionId);
    if (position) {
      logger.info(`[CACHE] Removing position from cache`, {
        positionId,
        symbol: position.symbol,
        direction: position.direction
      });
      
      this.positions.delete(positionId);
      this.saveCache();
      return true;
    }
    return false;
  }

  async validatePosition(symbol, position, cachedPosition) {
    if (!position || !cachedPosition) return false;
    
    const currentId = this.generatePositionId(symbol, position);
    const isValid = currentId === cachedPosition.id;
    
    if (!isValid) {
      logger.warn(`[CACHE] Position validation failed`, {
        symbol,
        currentId,
        cachedId: cachedPosition.id
      });
    }
    
    return isValid;
  }

  cleanOldPositions(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [id, position] of this.positions.entries()) {
      if (now - position.openedAt > maxAgeMs) {
        this.positions.delete(id);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`[CACHE] Cleaned old positions`, {
        removedCount: cleanedCount,
        remainingCount: this.positions.size
      });
      this.saveCache();
    }
  }
}

export const positionCache = new PositionCache();