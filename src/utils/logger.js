import winston from "winston";
import TelegramBot from "node-telegram-bot-api";
import { TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, SERVER_NAME } from "../config/config.js";

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
  const messages = accumulatedMessages[level].join("\n");
  const messageParts = splitLongMessage(
      `${emoji} [${SERVER_NAME}] ${level.toUpperCase()}:\n${messages}`
  );

  for (const part of messageParts) {
      try {
          await bot.sendMessage(ADMIN_CHAT_ID, part, { parse_mode: "HTML" });
          // Add delay between messages to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
          console.error("Error sending message to admin:", error);
          // Log the problematic message part for debugging
          console.error("Problematic message part:", part);
      }
  }

  accumulatedMessages[level] = [];
}

function formatMetadata(metadata) {
	if (Object.keys(metadata).length > 0) {
		return "\n" + safeStringify(metadata);
	}
	return "";
}

function log(level, message, metadata = {}) {
	if (metadata instanceof Error) {
		metadata = { error: metadata.message, stack: metadata.stack };
	}

	logger.log(level, message, metadata);

	// Only accumulate messages for Telegram if it's configured and not error/debug/silly level
	if (isTelegramConfigured && !['error', 'debug', 'silly'].includes(level)) {
		const formattedMetadata = formatMetadata(metadata);
		const telegramMessage = `${message}${formattedMetadata}`;

		if (!accumulatedMessages[level]) {
			accumulatedMessages[level] = [];
		}
		accumulatedMessages[level].push(telegramMessage);

		// Clear existing timeout (if any) and set a new one
		if (timeouts[level]) {
			clearTimeout(timeouts[level]);
		}
		timeouts[level] = setTimeout(
			() => sendAccumulatedMessages(level),
			DEBOUNCE_TIME
		);
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

// Add closed positions tracking
let closedPositions = {
  positions: [],
  totalPnL: 0
};

function addClosedPosition(position) {
  closedPositions.positions.push({
    ...position,
    closedAt: new Date()
  });
  closedPositions.totalPnL += position.realizedPnl || 0;
}

function clearOldClosedPositions() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  closedPositions.positions = closedPositions.positions.filter(p => p.closedAt > oneDayAgo);
  closedPositions.totalPnL = closedPositions.positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
}

// Format position details with emojis and colors
function formatPositionDetails(position) {
  const direction = position.size > 0 ? 'long' : 'short';
  const directionEmoji = getPositionEmoji(direction);
  const profitLoss = position.unrealizedPnl || 0;
  const plEmoji = profitLoss > 0 ? getPositionEmoji('profit') : 
          profitLoss < 0 ? getPositionEmoji('loss') : 
          getPositionEmoji('neutral');

  // Color formatting for values
  const plColor = profitLoss > 0 ? '🟢' : profitLoss < 0 ? '🔴' : '⚪';
  const progressColor = position.progress >= 0.3 ? '🟢' : '⚪';
  
  return `${directionEmoji} ${position.symbol}:
💲 Entry: $${position.entryPrice.toFixed(4)}
📍 Current: $${position.currentPrice.toFixed(4)}
${plColor} PnL: ${profitLoss > 0 ? '+' : ''}${(profitLoss * 100).toFixed(2)}%
${progressColor} Progress: ${(position.progress * 100).toFixed(2)}%
⛔️ SL: $${position.stopLoss?.toFixed(4) || 'N/A'}
🎯 TP: $${position.takeProfit?.toFixed(4) || 'N/A'}
${position.hasReachedThreshold ? '🔒' : '🔓'}`;
}

// New function to format closed positions summary
function formatClosedPositionsSummary() {
  if (closedPositions.positions.length === 0) return '';

  const summary = closedPositions.positions.map(p => {
    const plColor = p.realizedPnl > 0 ? '🟢' : '🔴';
    return `${p.symbol}: ${plColor}${(p.realizedPnl * 100).toFixed(2)}%`;
  }).join(', ');

  const totalColor = closedPositions.totalPnL > 0 ? '🟢' : '🔴';
  return `\n\n📊 24h Closed Positions:\n${totalColor} Total: ${(closedPositions.totalPnL * 100).toFixed(2)}%\n${summary}`;
}

// Update the hourly update function
async function sendHourlyUpdate(positions, isStartup = false) {
  if (!isTelegramConfigured || !positions) {
    return;
  }

  clearOldClosedPositions();
  const timestamp = new Date().toLocaleString();
  let message = isStartup ? 
    `🚀 Startup Status (${timestamp})\n\n` :
    `🕐 Hourly Update (${timestamp})\n\n`;

  if (!positions.length) {
    message += '📭 No active positions';
    if (closedPositions.positions.length > 0) {
      message += formatClosedPositionsSummary();
    }
  } else {
    // Split positions into longs and shorts
    const longs = positions.filter(p => p.size > 0);
    const shorts = positions.filter(p => p.size < 0);

    // Calculate total PnL including closed positions
    const activePnL = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    const totalPnL = activePnL + closedPositions.totalPnL;
    const totalPnLColor = totalPnL > 0 ? '🟢' : totalPnL < 0 ? '🔴' : '⚪';

    message += `📊 Active: ${positions.length} | ${totalPnLColor} Total PnL: ${totalPnL > 0 ? '+' : ''}${(totalPnL * 100).toFixed(2)}%\n\n`;

    // Format longs
    if (longs.length) {
      message += `📈 LONGS (${longs.length})\n`;
      message += longs.map(position => formatPositionDetails(position)).join('\n\n');
    }

    // Add separator between longs and shorts
    if (longs.length && shorts.length) {
      message += '\n\n' + '━'.repeat(20) + '\n\n';
    }

    // Format shorts
    if (shorts.length) {
      message += `📉 SHORTS (${shorts.length})\n`;
      message += shorts.map(position => formatPositionDetails(position)).join('\n\n');
    }

    // Add closed positions summary
    if (closedPositions.positions.length > 0) {
      message += formatClosedPositionsSummary();
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
};