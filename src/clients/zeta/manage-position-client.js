import { Wallet, CrossClient, Exchange, Network, Market, utils, types, assets, constants } from "@zetamarkets/sdk";
import { PublicKey, Connection, Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import logger from "../../utils/logger.js";
import { CONFIG } from "../../config/config.js";

dotenv.config();

export class ZetaManagePositionClientWrapper {
	constructor() {
		this.client = null;
		this.connection = null;
		this.wallet = null;
		this.activeMarket = constants.Asset.SOL;
	}

	roundToTickSize(price) {
		const tickSize = 0.0001;
		return Math.round(price / tickSize) * tickSize;
	}

	async initializeExchange(markets) {
		// Initialize connection and exchange
		this.connection = new Connection(process.env.RPC_TRADINGBOT, {
			commitment: "finalized",
		});

		// Create set of markets to load
		const marketsToLoad = new Set([constants.Asset.SOL, ...markets]);
		const marketsArray = Array.from(marketsToLoad);

		const loadExchangeConfig = types.defaultLoadExchangeConfig(
			Network.MAINNET,
			this.connection,
			{
				skipPreflight: true,
				preflightCommitment: "finalized",
				commitment: "finalized",
			},
			25
			// false
			// this.connection,
			// marketsArray,
			// undefined,
			// marketsArray
		);

		// Store original console methods
		const originalLog = console.log;
		const originalError = console.error;
		const originalInfo = console.info;
		const originalWarn = console.warn;
		const originalDebug = console.debug;

		// Disable all console output
		console.log = () => {};
		console.error = () => {};
		console.info = () => {};
		console.warn = () => {};
		console.debug = () => {};

		await Exchange.load(loadExchangeConfig);

		// Restore console methods
		console.log = originalLog;
		console.error = originalError;
		console.info = originalInfo;
		console.warn = originalWarn;
		console.debug = originalDebug;

		logger.info("Exchange loaded successfully");

	}

	async initialize(keypairPath = null) {
		try {
			const keyPath = keypairPath || process.env.KEYPAIR_FILE_PATH;

			// Load wallet
			const secretKeyString = fs.readFileSync(keyPath, "utf8");
			const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
			const keypair = Keypair.fromSecretKey(secretKey);
			this.wallet = new Wallet(keypair);

			logger.info("Wallet initialized", { usingPath: keyPath });

			// Create client
			this.client = await CrossClient.load(
				this.connection, // connection: Connection,
				this.wallet, // wallet: types.Wallet,
				{ skipPreflight: true, preflightCommitment: "finalized", commitment: "finalized" }, // opts: ConfirmOptions = utils.defaultCommitment(),
				undefined, // callback
				false, // throttle: boolean = false
				undefined, // delegator : PublicKey = undefined,
				true // useVersionedTxs: boolean = false,
			);

			logger.info("ZetaManagePositionClientWrapper initialized successfully");
		} catch (error) {
			logger.error("Initialization error:", error);
			throw error;
		}
	}

	async updatePriorityFees() {
		const helius_url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

		const response = await fetch(helius_url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "getPriorityFeeEstimate",
				params: [
					{
						accountKeys: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
						options: {
							includeAllPriorityFeeLevels: true,
						},
					},
				],
			}),
		});

		const data = await response.json();

		/*
    ============================================
     data.result.priorityFeeLevels.___
    ============================================
    Valid Options: min, low, medium, ** high **, 
                   veryHigh, unsafeMax
    */

		Exchange.setUseAutoPriorityFee(false);
		Exchange.updatePriorityFee(Math.floor(data.result.priorityFeeLevels.high * 1));

		logger.info("Fees: ", data.result.priorityFeeLevels);
		logger.info("Fee Level (high): ", data.result.priorityFeeLevels.high);
		logger.info("Exchange set to fee * 1:", Exchange._priorityFee);
	}

	isExchangeInitialized() {
		return typeof Exchange !== "undefined" && Exchange && Exchange.initialized;
	}

	async getPosition(marketIndex) {
		try {
			await Exchange.updateState();
			await this.client.updateState(true, true);
			const positions = await this.client.getPositions(marketIndex);
			// logger.info("Position check:", {
			// 	marketIndex,
			// 	hasPosition: !!positions[0],
			// 	size: positions[0]?.size || 0,
			// });
			return positions[0] || null;
		} catch (error) {
			logger.error("Error getting position:", error);
			throw error;
		}
	}

	getCalculatedMarkPrice(asset = this.activeMarket) {
		const { markPrice } = this.getMarkPriceAndSpread(asset);
		return markPrice;
	}

	async openPosition(direction, marketIndex = this.activeMarket, makerOrTaker = "taker") {
		logger.info(`Opening ${direction} position for ${assets.assetToName(marketIndex)}`);

		const settings = this.fetchSettings();
		logger.info(`Using settings:`, settings);

		await this.client.updateState(true, true);
		const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;
		logger.info(`BALANCE:`, balance);

		// Calculate size first to check if it's valid
		const side = direction === "long" ? types.Side.BID : types.Side.ASK;

		// Early size calculation
		const estimatedPrice = this.getCalculatedMarkPrice(marketIndex);
		const positionSize = (balance * settings.leverageMultiplier) / estimatedPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(positionSize / decimalMinLotSize);

		let transaction = new Transaction().add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 350_000,
			})
		);

		const {
			currentPrice,
			adjustedPrice,
			positionSize: finalPositionSize,
			nativeLotSize,
		} = await this.calculatePricesAndSize(side, marketIndex, balance, settings, "taker");

		// Check for zero size before proceeding
		if (nativeLotSize <= 0) {
			logger.error("Order size too small:", {
				market: assets.assetToName(marketIndex),
				balance,
				leverage: settings.leverageMultiplier,
				estimatedPrice,
				calculatedSize: positionSize,
				minLotSize: decimalMinLotSize,
				nativeLotSize: nativeLotSize,
			});
			throw new Error("Order size too small, check leverage * balance compared to current price");
		}

		await this.updatePriorityFees();
		await Exchange.updateState();
		await this.client.updateState(true, true);

		const mainOrderIx = this.createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, "taker");
		transaction.add(mainOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);
			return txid;
		} catch (error) {
			const errorContext = {
				direction,
				asset: assets.assetToName(marketIndex),
				type: error.name,
				details: error.message,
				code: error.code,
				timestamp: new Date().toISOString(),
			};

			logger.error(`Failed to open ${direction} position for ${assets.assetToName(marketIndex)}`, errorContext);
			throw error;
		}
	}

	async closePosition(direction, marketIndex) {
		await this.client.updateState(true, true);

		let positions = await this.client.getPositions(marketIndex);

		// Check for empty array or undefined first position
		if (!positions || !positions.length || !positions[0]) {
			logger.info(`No position to close for ${assets.assetToName(marketIndex)}`);
			return { status: "NO_POSITION" }; // Return specific object instead of undefined
		}

		const position = positions[0];
		logger.info(`Closing position for ${assets.assetToName(marketIndex)}`, position);

		// Calculate position size
		const rawPositionSize = Math.abs(position.size);
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.round(rawPositionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		logger.info(`Lots Debug:`, {
			rawPositionSize,
			decimalMinLotSize,
			lotSize,
			nativeLotSize,
			actualPositionSize,
		});

		await this.updatePriorityFees();

		await Exchange.updateState();

		await this.client.updateState(true, true);

		const side = direction == "long" ? types.Side.ASK : types.Side.BID;

		const closePrice = await this.getClosePrice(marketIndex, side);

		let transaction = new Transaction();

		const mainOrderIx = this.createCloseOrderInstruction(marketIndex, closePrice, nativeLotSize, side, "taker");

		transaction.add(mainOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);

			return txid;
		} catch (error) {
			logger.error(`Close Position TX Error:`, error);
		}
	}

	async fetchSettings() {
		const settings = {
			leverageMultiplier: CONFIG.leverageMultiplier,
			takeProfitPercentage: this.roundNumber(CONFIG.simpleTakeProfit, 2),
			stopLossPercentage: this.roundNumber(CONFIG.simpleStopLoss, 2),
    };
		return settings;
	}

  createMainOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "taker") {
		return this.client.createPlacePerpOrderInstruction(
			marketIndex,
			utils.convertDecimalToNativeInteger(adjustedPrice),
			nativeLotSize,
			side,
			{
				orderType: types.OrderType.FILLORKILL,
				tifOptions: {
					expiryOffset: undefined,
				},
			}
		);
	}

	createCloseOrderInstruction(marketIndex, adjustedPrice, nativeLotSize, side, makerOrTaker = "taker") {
		return this.client.createPlacePerpOrderInstruction(
			marketIndex,
			utils.convertDecimalToNativeInteger(adjustedPrice),
			nativeLotSize,
			side,
			{
				orderType: types.OrderType.FILLORKILL,
				tifOptions: {
					expiryOffset: undefined,
				},
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
			}
		);
	}

	async getClosePrice(marketIndex, side) {
		try {
			const position = await this.getPosition(marketIndex);
			if (!position) {
				throw new Error("No position found to close");
			}

			const positionSize = Math.abs(position.size);
			const { bestAsk, bestBid, spread } = await this.waitForAcceptableSpread(marketIndex, positionSize, side);

			const slippage = 0.0001; // 1 tick

			const closePrice =
				side === types.Side.ASK
					? bestBid - slippage // Selling: price below BID
					: bestAsk + slippage; // Buying: price above ASK

			logger.info("Close price calculation:", {
				market: assets.assetToName(marketIndex),
				side: side === types.Side.BID ? "BUY" : "SELL",
				spread: spread.toFixed(4) + "%",
				bestAsk: bestAsk.toFixed(4),
				bestBid: bestBid.toFixed(4),
				closePrice: closePrice.toFixed(4),
				positionSize,
			});

			return closePrice;
		} catch (error) {
			logger.error("Error calculating close price:", error);
			throw error;
		}
	}

	async waitForAcceptableSpread(marketIndex, orderSize, side, maxWaitTime = 30000, pollInterval = 1000) {
		const startTime = Date.now();
		const MAX_SPREAD = 0.5;
		let attempts = 0;

		while (Date.now() - startTime < maxWaitTime) {
			try {
				Exchange.updateState();
				Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
				const orderbook = Exchange.getOrderbook(marketIndex);
				attempts++;

				// Get the relevant side of the book
				const bookSide = side === types.Side.BID ? orderbook.asks : orderbook.bids;
				const otherSide = side === types.Side.BID ? orderbook.bids : orderbook.asks;

				if (!bookSide || bookSide.length === 0 || !otherSide || otherSide.length === 0) {
					throw new Error("Invalid orderbook data");
				}

				// Convert our required size to native lots
				const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
				const nativeMinLotSize = utils.getNativeMinLotSize(marketIndex);
				const requiredLots = Math.round(orderSize / decimalMinLotSize);
				const requiredNativeLots = requiredLots * nativeMinLotSize;

				// Log full orderbook state for debugging
				logger.info("Full Orderbook State:", {
					market: assets.assetToName(marketIndex),
					ourSize: {
						raw: orderSize,
						requiredLots,
						requiredNativeLots,
					},
					asks: orderbook.asks.slice(0, 3).map((level) => ({
						price: level.price.toFixed(4),
						rawSize: level.size,
						lots: Math.round(level.size / decimalMinLotSize),
						nativeLots: Math.round(level.size / decimalMinLotSize) * nativeMinLotSize,
					})),
					bids: orderbook.bids.slice(0, 3).map((level) => ({
						price: level.price.toFixed(4),
						rawSize: level.size,
						lots: Math.round(level.size / decimalMinLotSize),
						nativeLots: Math.round(level.size / decimalMinLotSize) * nativeMinLotSize,
					})),
				});

				// Find level with enough size
				for (let i = 0; i < bookSide.length; i++) {
					const level = bookSide[i];
					const levelLots = Math.round(level.size / decimalMinLotSize);
					const levelNativeLots = levelLots * nativeMinLotSize;

					logger.info("Checking Level:", {
						level: i,
						price: level.price.toFixed(4),
						rawSize: level.size,
						lots: levelLots,
						nativeLots: levelNativeLots,
						requiredNativeLots,
						sufficient: levelNativeLots >= requiredNativeLots,
					});

					if (levelNativeLots >= requiredNativeLots) {
						const otherSidePrice = otherSide[0].price;
						const spread = (Math.abs(level.price - otherSidePrice) / ((level.price + otherSidePrice) / 2)) * 100;

						logger.info("Found Level:", {
							levelIndex: i,
							price: level.price.toFixed(4),
							rawSize: level.size,
							lots: levelLots,
							nativeLots: levelNativeLots,
							spread: spread.toFixed(4) + "%",
						});

						if (spread <= MAX_SPREAD) {
							return {
								markPrice: (level.price + otherSidePrice) / 2,
								bestAsk: side === types.Side.BID ? level.price : otherSidePrice,
								bestBid: side === types.Side.BID ? otherSidePrice : level.price,
								spread,
							};
						}
					}
				}

				await new Promise((resolve) => setTimeout(resolve, pollInterval));
			} catch (error) {
				logger.error("Error checking spread and liquidity:", error);
				throw error;
			}
		}

		throw new Error(`Unable to find acceptable spread and liquidity after ${maxWaitTime / 1000}s`);
	}

	async calculatePricesAndSize(side, marketIndex, balance, settings, makerOrTaker = "taker") {
		if (side === undefined || side === null || !marketIndex || !balance || !settings) {
			throw new Error("Invalid inputs for price and size calculation");
		}

		// Calculate initial position size
		const estimatedPrice = this.getCalculatedMarkPrice(marketIndex);
		const positionSize = (balance * settings.leverageMultiplier) / estimatedPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(positionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		// Get market data considering the order size
		const { markPrice, bestAsk, bestBid, spread } = await this.waitForAcceptableSpread(marketIndex, actualPositionSize, side);

		const slippage = 0.0001; // 1 ticks

		// Use the price from the appropriate order book level
		const adjustedPrice = side === types.Side.BID ? bestAsk + slippage : bestBid - slippage;

		logger.info(`Order Sizing:`, {
			currentPrice: markPrice,
			bestAsk: bestAsk.toFixed(4),
			bestBid: bestBid.toFixed(4),
			adjustedPrice: adjustedPrice.toFixed(4),
			side: side === types.Side.BID ? "BUY" : "SELL",
			spread: spread.toFixed(4) + "%",
			positionSize: actualPositionSize,
			lotSize,
			nativeLotSize,
		});

		return {
			currentPrice: markPrice,
			adjustedPrice,
			positionSize: actualPositionSize,
			nativeLotSize,
			spread,
		};
	}

	// Original getMarkPriceAndSpread - unchanged
	getMarkPriceAndSpread(asset = this.activeMarket) {
		try {
			Exchange.updateState();
			Exchange.getPerpMarket(asset).forceFetchOrderbook();
			const orderbook = Exchange.getOrderbook(asset);

			if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
				throw new Error("Invalid orderbook data");
			}

			const bestAsk = orderbook.asks[0].price;
			const bestBid = orderbook.bids[0].price;
			const markPrice = (bestAsk + bestBid) / 2;
			const spread = ((bestAsk - bestBid) / markPrice) * 100;

			return {
				markPrice,
				bestAsk,
				bestBid,
				spread,
			};
		} catch (error) {
			logger.error("Error getting mark price and spread:", error);
			throw error;
		}
	}
}
