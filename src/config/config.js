import { constants } from "@zetamarkets/sdk";
import dotenv from "dotenv";
dotenv.config();

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

export const ASSETS = Object.values(constants.Asset).filter(
	(asset) => asset !== "UNDEFINED"
);

export const SYMBOLS = ASSETS.map((asset) => constants.Asset[asset]);

export const ACTIVE_SYMBOLS = ["SOL", "ETH", "BTC"];

export const SERVER_NAME="PONY";