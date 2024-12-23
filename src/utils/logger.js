import winston from "winston";
import TelegramBot from "node-telegram-bot-api";
import { TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, SERVER_NAME } from "../config/config.js";
import fs from 'fs';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Initialize Telegram only if configured
let bot = null;
const isTelegramConfigured = Boolean(TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID);

if (isTelegramConfigured) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
}

const logFormat = printf(
	({ level, message, timestamp, stack, ...metadata }) => {
		let msg = `${timestamp} [${SERVER_NAME}] [${level}] : ${message}`;
		if (stack) {
			msg += `\n${stack}`;
		}
		if (Object.keys(metadata).length > 0) {
			msg += ` ${JSON.stringify(metadata, null, 2)}`;
		}
		return msg;
	}
);

const logger = winston.createLogger({
	level: "info",
	format: combine(timestamp(), errors({ stack: true }), logFormat),
	transports: [
		new winston.transports.Console({
			format: combine(colorize(), logFormat),
		}),
		new winston.transports.File({ filename: "error.log", level: "error" }),
		new winston.transports.File({ filename: "combined.log" }),
	],
});

// Helper functions remain unchanged...
function getEmojiForLogLevel(level) {
	switch (level) {
		case "error":
			return "🚫";
		case "warn":
			return "⚠️";
		case "info":
			return "✅";
		case "http":
			return "🌐";
		case "verbose":
			return "📝";
		case "debug":
			return "🔍";
		case "silly":
			return "🃏";
		default:
			return "🪵";
	}
}

function truncate(str, maxLength = 100) {
	if (str.length <= maxLength) return str;
	return str.slice(0, maxLength - 3) + "...";
}

function safeStringify(obj, spaces = 2) {
	return JSON.stringify(
		obj,
		(key, value) => (typeof value === "bigint" ? value.toString() : value),
		spaces
	);
}

function escapeHtml(unsafe) {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function splitLongMessage(message, maxLength = 4000) {
  // First, we'll create the complete HTML message
  const parts = [];
  let currentPart = '';
  const words = message.split(/(\s+)/);
  
  for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const potentialPart = currentPart + word;
      
      // Check if adding this word would exceed maxLength
      if (potentialPart.length > maxLength) {
          // If current part is empty, we need to split the word itself
          if (!currentPart) {
              // Handle the case where a single word is too long
              const firstChunk = word.substring(0, maxLength);
              parts.push(firstChunk);
              currentPart = word.substring(maxLength);
          } else {
              // Push current part and start new one
              parts.push(currentPart);
              currentPart = word;
          }
      } else {
          currentPart = potentialPart;
      }
  }
  
  // Don't forget the last part
  if (currentPart) {
      parts.push(currentPart);
  }
  
  // Now wrap each part in proper HTML tags
  return parts.map(part => `<pre>${escapeHtml(part)}</pre>`);
}

// Debounce time in milliseconds (1000 ms) TG max 1 per second
const DEBOUNCE_TIME = 1000;

// Object to store accumulated messages for each log level
const accumulatedMessages = {};

// Timeout IDs for each log level
const timeouts = {};

async function sendAccumulatedMessages(level) {
  if (
      !isTelegramConfigured ||
      !accumulatedMessages[level] ||
      accumulatedMessages[level].length === 0
  ) {
      return;
  }

  const emoji = getEmojiForLogLevel(level);
  const messages = accumulatedMessages[level]
    .filter(msg => msg.trim().length > 0)
    .join('\n\n');
    
  const messageParts = splitLongMessage(
    `${emoji} ${messages}`
  );

  for (const part of messageParts) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, part, { parse_mode: "HTML" });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error("Error sending message to admin:", error);
      console.error("Problematic message part:", part);
    }
  }

  accumulatedMessages[level] = [];
}

function formatMetadata(metadata) {
  if (!metadata || Object.keys(metadata).length === 0) return '';
  
  // Handle special cases
  if (metadata.direction) {
    return ` ${metadata.direction === 'long' ? '📈' : '📉'}`;
  }
  
  // For market sentiment
  if (metadata.marketSentiment) {
    const sentimentEmoji = metadata.sentimentIndex > 75 ? '🤑' :
                          metadata.sentimentIndex > 60 ? '😊' :
                          metadata.sentimentIndex > 40 ? '😐' :
                          metadata.sentimentIndex > 25 ? '😟' : '😰';
    return `\nMarket Mood: ${sentimentEmoji} ${metadata.marketSentiment} (${metadata.sentimentIndex})`;
  }

  // For position details
  if (metadata.size) {
    const direction = metadata.size > 0 ? '📈 Long' : '📉 Short';
    return `\nSize: ${Math.abs(metadata.size)} ${direction}`;
  }

  // For spread checks
  if (metadata.spread) {
    return `\nSpread: ${metadata.spread} (Max: ${metadata.maxSpread})`;
  }

  // For other cases, format nicely
  return '\n' + Object.entries(metadata)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

function log(level, message, metadata = {}) {
  if (metadata instanceof Error) {
    metadata = { error: metadata.message, stack: metadata.stack };
  }

  logger.log(level, message, metadata);

  // Only send to Telegram if configured and not error/debug/silly level
  if (isTelegramConfigured && !['error', 'debug', 'silly'].includes(level)) {
    let telegramMessage = message;
    
    // Clean up common message prefixes
    telegramMessage = telegramMessage
      .replace(/\[INIT\]\s+/g, '')
      .replace(/\[WS\]\s+/g, '')
      .replace(/\[QUEUE\]\s+/g, '')
      .replace(/\[HEALTH\]\s+/g, '')
      .replace(/\[PONY\]\s+/g, '');

    // Format special messages
    if (message.includes('Stop loss hit')) {
      const symbol = message.match(/\[(\w+)\]/)?.[1];
      const direction = metadata.size > 0 ? 'LONG' : 'SHORT';
      const pnl = ((metadata.currentPrice - metadata.entryPrice) / metadata.entryPrice * 100 * (direction === 'LONG' ? 1 : -1)).toFixed(2);
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      
      telegramMessage = `⚠️ **Stop Loss Triggered**: ${symbol}
- **Position**: ${direction}
- **Entry Price**: $${metadata.entryPrice?.toFixed(2)}
- **Current Price**: $${metadata.currentPrice?.toFixed(2)}
- **Stop Loss**: $${metadata.stopLossPrice?.toFixed(2)}
- **PnL**: ${pnlEmoji} ${pnl}%
Attempting to Close Position...`;
    }
    else if (message.includes('Closing position:')) {
      const symbol = metadata.symbol;
      const direction = metadata.size > 0 ? 'LONG' : 'SHORT';
      const pnl = ((metadata.currentPrice - metadata.entryPrice) / metadata.entryPrice * 100 * (direction === 'LONG' ? 1 : -1)).toFixed(2);
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      
      telegramMessage = `🔄 **Closing Position**: ${symbol}
- **Type**: ${direction}
- **Entry**: $${metadata.entryPrice?.toFixed(2)}
- **Exit**: $${metadata.currentPrice?.toFixed(2)}
- **Size**: ${Math.abs(metadata.size)?.toFixed(3)}
- **Est. PnL**: ${pnlEmoji} ${pnl}%`;
    }
    else if (message.includes('Position closure verified')) {
      const symbol = metadata.symbol;
      const direction = metadata.size > 0 ? 'LONG' : 'SHORT';
      const pnl = ((metadata.exitPrice - metadata.entryPrice) / metadata.entryPrice * 100 * (direction === 'LONG' ? 1 : -1)).toFixed(2);
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      const duration = metadata.duration ? formatDuration(metadata.duration) : 'N/A';
      
      telegramMessage = `✅ **Position Closed**: ${symbol}
- **Type**: ${direction}
- **Entry**: $${metadata.entryPrice?.toFixed(2)}
- **Exit**: $${metadata.exitPrice?.toFixed(2)}
- **Final PnL**: ${pnlEmoji} ${pnl}%
- **Duration**: ${duration}`;
    }
    // Skip redundant messages
    else if (message.includes('Exchange loaded successfully') || 
             message.includes('Wallet initialized') ||
             message.includes('Lots Debug:') ||
             message.includes('Checking spread:') ||
             message.includes('Close price calculation:') ||
             message.includes('Waiting') ||
             message.includes('Stopped monitoring')) {
      return;
    }

    if (!accumulatedMessages[level]) {
      accumulatedMessages[level] = [];
    }
    accumulatedMessages[level].push(telegramMessage);

    if (timeouts[level]) {
      clearTimeout(timeouts[level]);
    }
    timeouts[level] = setTimeout(
      () => sendAccumulatedMessages(level),
      DEBOUNCE_TIME
    );
  }
}

// Add helper function for duration formatting
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// All utility functions remain unchanged...
function logPerformance(action, duration) {
	log("info", `Performance: ${action} completed in ${duration.toFixed(2)}ms`);
	console.log(`Detailed timing - ${action}: ${duration.toFixed(2)}ms`);
}

function logError(message, error) {
	log("error", `Error: ${message}`, error);
}

function logInitialization(milestone) {
	log("info", `Initialization: ${milestone}`);
}

function logTransaction(summary, details) {
	log("info", `Transaction: ${summary}`, details);
}

function logPositionUpdate(summary, details) {
	log("info", `Position Update: ${summary}`, details);
}

function logStrategySignal(signal, details) {
	log("info", `Strategy Signal: ${signal}`, details);
}

function logConfiguration(summary, details) {
	log("info", `Configuration: ${truncate(summary)}`, details);
}

function logStateCheck(summary, details) {
	if (summary) {
		log("info", `State Check: ${summary}`, details);
	} else {
		console.log("State check details:", safeStringify(details));
	}
}

function logNetworkEvent(event, details = {}) {
	log("info", `Network Event: ${event}`, details);
}

function logPositionManagement(event, details) {
	log("info", `Position Management: ${event}`, details);
}

function logMarketData(summary, details) {
	console.log(`Market Data: ${summary}`, details ? safeStringify(details) : "");
}

function logDebug(message, data = null) {
	log("debug", message, data);
}

function logCritical(message) {
	log("error", `CRITICAL: ${message}`);
}

function logWarning(message, details = null) {
	log("warn", message, details);
}

// Add new emoji mapping for position status
function getPositionEmoji(type) {
	switch (type) {
		case 'long':
			return '📈';
		case 'short':
			return '📉';
		case 'profit':
			return '💰';
		case 'loss':
			return '🔻';
		case 'neutral':
			return '➖';
		case 'threshold':
			return '🎯';
		case 'warning':
			return '⚠️';
		case 'closed':
			return '✅';
		default:
			return '📊';
	}
}

// Add closed positions tracking with file persistence
const CLOSED_POSITIONS_FILE = 'data/closed_positions.json';

// Initialize closed positions from file or default
let closedPositions = loadClosedPositions();

function loadClosedPositions() {
  try {
    // Ensure data directory exists
    const dir = 'data';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }

    // If closed_positions.json doesn't exist but template does, copy it
    if (!fs.existsSync(CLOSED_POSITIONS_FILE) && fs.existsSync(CLOSED_POSITIONS_FILE + '.template')) {
      fs.copyFileSync(CLOSED_POSITIONS_FILE + '.template', CLOSED_POSITIONS_FILE);
      console.log('Created closed_positions.json from template');
    }

    if (fs.existsSync(CLOSED_POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLOSED_POSITIONS_FILE, 'utf8'));
      // Convert stored date strings back to Date objects
      data.positions = data.positions.map(p => ({
        ...p,
        closedAt: new Date(p.closedAt)
      }));
      return data;
    }
  } catch (error) {
    console.error('Error loading closed positions:', error);
  }
  return { positions: [], totalPnL: 0 };
}

function saveClosedPositions() {
  try {
    // Ensure directory exists
    const dir = 'data';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(CLOSED_POSITIONS_FILE, JSON.stringify(closedPositions, null, 2));
  } catch (error) {
    console.error('Error saving closed positions:', error);
  }
}

function addClosedPosition(position) {
  closedPositions.positions.push({
    ...position,
    closedAt: new Date()
  });
  closedPositions.totalPnL += position.realizedPnl || 0;
  saveClosedPositions(); // Save after each new position
}

function clearOldClosedPositions() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  closedPositions.positions = closedPositions.positions.filter(p => p.closedAt > oneDayAgo);
  closedPositions.totalPnL = closedPositions.positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  saveClosedPositions(); // Save after clearing old positions
}

// Format position details with emojis and colors
function formatPositionDetails(position) {
  const direction = position.size > 0 ? 'long' : 'short';
  const directionEmoji = getPositionEmoji(direction);
  const profitLoss = position.unrealizedPnl || 0;
  const plEmoji = profitLoss > 0 ? '🟢' : profitLoss < 0 ? '🔴' : '⚪';
  const progressColor = position.progress >= 0.3 ? '🟢' : '⚪';
  
  return `${directionEmoji} ${position.symbol}
Entry: $${position.entryPrice.toFixed(2)}
Current: $${position.currentPrice.toFixed(2)}
PnL: ${plEmoji} ${profitLoss > 0 ? '+' : ''}${(profitLoss * 100).toFixed(2)}%
Progress: ${progressColor} ${(position.progress * 100).toFixed(1)}%
Stop Loss: $${position.stopLoss?.toFixed(2) || 'N/A'}
Take Profit: $${position.takeProfit?.toFixed(2) || 'N/A'}
Status: ${position.hasReachedThreshold ? '🔒 Locked' : '🔓 Monitoring'}`;
}

// New function to format closed positions summary
function formatClosedPositionsSummary() {
  if (closedPositions.positions.length === 0) return '';

  const summary = closedPositions.positions.map(p => {
    const plColor = p.realizedPnl > 0 ? '🟢' : '🔴';
    const direction = p.size > 0 ? '📈 LONG' : '📉 SHORT';
    return `${direction} ${p.symbol}
Entry: $${p.entryPrice?.toFixed(2)}
Exit: $${p.exitPrice?.toFixed(2)}
Stop Loss: $${p.stopLoss?.toFixed(2) || 'N/A'}
Take Profit: $${p.takeProfit?.toFixed(2) || 'N/A'}
PnL: ${plColor} ${p.realizedPnl > 0 ? '+' : ''}${(p.realizedPnl * 100).toFixed(2)}%
Duration: ${formatDuration(p.duration)}
Reason: ${p.reason || 'Manual close'}
──────────────`;
  }).join('\n\n');

  const totalColor = closedPositions.totalPnL > 0 ? '🟢' : '🔴';
  return `📋 Recently Closed Positions (24h)
Total PnL: ${totalColor} ${closedPositions.totalPnL > 0 ? '+' : ''}${(closedPositions.totalPnL * 100).toFixed(2)}%
${'═'.repeat(30)}
${summary}`;
}

// Update the hourly update function to be more concise
async function sendHourlyUpdate(positions, isStartup = false) {
  if (!isTelegramConfigured || !positions) {
    return;
  }

  clearOldClosedPositions();
  const timestamp = new Date().toLocaleString();
  let message = isStartup ? 
    `🚀 Bot Status Update (${timestamp})\n\n` :
    `📊 Position Update (${timestamp})\n\n`;

  if (!positions.length) {
    message += '📭 No active positions';
    if (closedPositions.positions.length > 0) {
      message += formatClosedPositionsSummary();
    }
  } else {
    // Split positions into longs and shorts
    const longs = positions.filter(p => p.size > 0);
    const shorts = positions.filter(p => p.size < 0);

    // Calculate total PnL
    const activePnL = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    const totalPnL = activePnL + closedPositions.totalPnL;
    const totalPnLColor = totalPnL > 0 ? '🟢' : totalPnL < 0 ? '🔴' : '⚪';

    message += `Active Positions: ${positions.length}
Overall PnL: ${totalPnLColor} ${totalPnL > 0 ? '+' : ''}${(totalPnL * 100).toFixed(2)}%\n\n`;

    // Format longs
    if (longs.length) {
      message += `📈 Long Positions (${longs.length})\n${'─'.repeat(20)}\n`;
      message += longs.map(position => formatPositionDetails(position)).join('\n\n');
    }

    // Add separator between longs and shorts
    if (longs.length && shorts.length) {
      message += '\n\n' + '━'.repeat(20) + '\n\n';
    }

    // Format shorts
    if (shorts.length) {
      message += `📉 Short Positions (${shorts.length})\n${'─'.repeat(20)}\n`;
      message += shorts.map(position => formatPositionDetails(position)).join('\n\n');
    }

    // Add closed positions summary if any
    if (closedPositions.positions.length > 0) {
      message += '\n\n' + formatClosedPositionsSummary();
    }
  }

  const messageParts = splitLongMessage(message);
  for (const part of messageParts) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, part, { parse_mode: "HTML" });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error("Error sending hourly update:", error);
    }
  }
}

// Add daily summary interval
let dailySummaryInterval = null;

// New function to send daily summary
async function sendDailySummary() {
  if (!isTelegramConfigured) return;

  const timestamp = new Date().toLocaleString();
  let message = `📈 Daily Performance Summary (${timestamp})\n\n`;

  // Add closed positions from last 24h
  if (closedPositions.positions.length > 0) {
    message += formatClosedPositionsSummary();
  } else {
    message += '📭 No positions closed in the last 24 hours\n';
  }

  const messageParts = splitLongMessage(message);
  for (const part of messageParts) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, part, { parse_mode: "HTML" });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error("Error sending daily summary:", error);
    }
  }
}

// Start daily summary interval
function startDailySummary() {
  if (dailySummaryInterval) {
    clearInterval(dailySummaryInterval);
  }
  // Run daily summary every 24 hours
  dailySummaryInterval = setInterval(sendDailySummary, 86400000);
  // Send first summary immediately
  sendDailySummary();
}

export default {
	error: (message, metadata) => log("error", message, metadata),
	warn: (message, metadata) => log("warn", message, metadata),
	info: (message, metadata) => log("info", message, metadata),
	http: (message, metadata) => log("http", message, metadata),
	verbose: (message, metadata) => log("verbose", message, metadata),
	debug: (message, metadata) => log("debug", message, metadata),
	silly: (message, metadata) => log("silly", message, metadata),
	performance: logPerformance,
	logError,
	logInitialization,
	logTransaction,
	logPositionUpdate,
	logStrategySignal,
	logConfiguration,
	logStateCheck,
	logNetworkEvent,
	logPositionManagement,
	logMarketData,
	logDebug,
	logCritical,
	logWarning,
	sendHourlyUpdate,
	addClosedPosition,
	startDailySummary,
};