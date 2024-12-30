import { Wallet, CrossClient, Exchange, Market, utils, constants } from "@zetamarkets/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import logger from "../../utils/logger.js";

dotenv.config();

export class ZetaLiveTradingClientWrapper {
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

  async getBalance() {
    await Exchange.updateState();
    await this.client.updateState(true,true);
		const balance = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account).balance;
    return balance;
  }

  async crossMarginAccountState(debug = false) {
    await Exchange.updateState();
    await this.client.updateState(true,true);
    const crossMarginAccountState = Exchange.riskCalculator.getCrossMarginAccountState(this.client.account);
    if (debug) {
      logger.info(`crossMarginAccountState: `, crossMarginAccountState);
    }
    return crossMarginAccountState;
  }

  async initialize(markets = [constants.Asset.SOL], keypairPath = null) {
    try {
      const keyPath = keypairPath || process.env.KEYPAIR_FILE_PATH;
      this.connection = new Connection(process.env.RPC_TRADINGBOT);

      // Load wallet
      const secretKeyString = fs.readFileSync(keyPath, "utf8");
      const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
      const keypair = Keypair.fromSecretKey(secretKey);
      this.wallet = new Wallet(keypair);

      logger.info("Wallet initialized", { usingPath: keyPath });

      // Create client
      this.client = await CrossClient.load(this.connection, this.wallet, undefined, undefined, undefined, undefined, true, undefined);

      logger.info("ZetaLiveTradingClientWrapper initialized successfully");
    } catch (error) {
      logger.error("Initialization error:", error);
      throw error;
    }
  }

  async getPosition(marketIndex) {
    try {
      await this.client.updateState();
      const positions = this.client.getPositions(marketIndex);
      return positions[0] || null;
    } catch (error) {
      logger.error("Error getting position:", error);
      throw error;
    }
  }

  getCalculatedMarkPrice(asset = this.activeMarket) {
    try {
      Exchange.getPerpMarket(asset).forceFetchOrderbook();
      const orderBook = Exchange.getOrderbook(asset);

      if (!orderBook?.asks?.[0]?.price || !orderBook?.bids?.[0]?.price) {
        throw new Error("Invalid orderbook data");
      }

      return Number((orderBook.asks[0].price + orderBook.bids[0].price) / 2);
    } catch (error) {
      logger.error("Error getting calculated mark price:", error);
      throw error;
    }
  }

  async fetchSettings() {
    try {
      const settings = {
        leverageMultiplier: 4.8,
        takeProfitPercentage: 0.04,
        stopLossPercentage: 0.02,
        trailingStopLoss: {
          progressThreshold: 0.6, // Updated default
          stopLossDistance:  0.4,
        },
      };

      // logger.info("Parsed settings:", settings); // Debug log
      return settings;
    } catch (error) {
      logger.error("Error fetching settings:", error);
      throw error;
    }
  }

  calculateTPSLPrices(direction, price, settings) {
    if (!direction || !price || !settings) {
      throw new Error("Invalid inputs for TP/SL calculation");
    }

    const { takeProfitPercentage, stopLossPercentage } = settings;

    const isLong = direction === "long";

    const takeProfitPrice = this.roundToTickSize(isLong ? price + price * takeProfitPercentage : price - price * takeProfitPercentage);

    const takeProfitTrigger = this.roundToTickSize(isLong ? price + (takeProfitPrice - price) * 0.95 : price - (price - takeProfitPrice) * 0.95);

    const stopLossPrice = this.roundToTickSize(isLong ? price - price * stopLossPercentage : price + price * stopLossPercentage);

    const stopLossTrigger = this.roundToTickSize(isLong ? price - (price - stopLossPrice) * 0.95 : price + (stopLossPrice - price) * 0.95);

    return {
      takeProfitPrice,
      takeProfitTrigger,
      stopLossPrice,
      stopLossTrigger,
    };
  }

}
