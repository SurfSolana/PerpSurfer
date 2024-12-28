# PerpSurfer Trading Bot

## TLDR & Critical Points ⚠️
- Use a **fresh wallet** only! Never your main wallet
- Required API Keys:
  - Discord bot API key (join Discord for access)
  - Any Solana RPC endpoint
  - Helius API key (free tier, for priority fees only - **don't paste the RPC URL**)
  - CoinMarketCap API key (free tier)
- Copy both `dotenv.example.txt` to `.env` AND `config.sample.js` to `config.js`
- Bot filters trades based on market sentiment:
  - Won't open longs during Extreme Fear
  - Won't open shorts during Extreme Greed
  - Will close longs if Extreme Fear, when signal is received
  - Will close shorts if Extreme Greed, when signal is received
- Requires minimum total of 0.24-ish SOL:
  - 0.02-ish SOL for Zeta account creation (refundable)
  - 0.06-ish SOL for token accounts (refundable)
  - 0.1--ish SOL for transaction fees
- USDC deposit required on Zeta for trading collateral

## Features

The PerpSurfer bot provides a complete perpetual futures trading solution with:

- Real-time AI Powered trading signals through secure WebSocket connection
- AI derived market sentiment analysis for trade filtering
- Intelligent position entry and management
- Dynamic trailing stop loss with automatic adjustment at profit targets
- Smart priority fee management using Helius API
- Optional Telegram notifications for trade monitoring
- Multi-market support for major assets (SOL, ETH, BTC)

## How It Works

The PerpSurfer trading system operates as an integrated solution that:
- Receives real-time trading signals through our secure WebSocket connection
- Analyzes market sentiment using data from top 100 cryptocurrencies
- Validates trade signals against current market conditions
- Manages position entry using optimized priority fees
- Places coordinated take-profit and stop-loss orders
- Continuously monitors position progress
- Adjusts stop-loss levels automatically when reaching profit targets

Our risk management system includes:
- Market sentiment-based position filtering
- Automatic stop-loss placement with each trade
- Dynamic trailing stop-loss adjustment based on profit targets
- Priority fee optimization for reliable execution
- Intelligent position size management based on account balance

## Setup Instructions

### 1. Get Required API Keys

The bot requires several API keys for full functionality:

1. Trading Signals API:
   - Join our Discord server: https://discord.gg/dpzudaBwSa
   - Complete the server verification process
   - Navigate to the #PerpSurfer channel
   - Request an API key from the moderators

2. RPC Endpoint:
   - Get an RPC endpoint from any provider (Helius, QuickNode, etc.)
   - Save your RPC URL

3. Helius API Key (for priority fees only):
   - Visit https://helius.dev
   - Create an account
   - Create a new API key (free tier is sufficient)
   - **Important**: Save only the API key, not the RPC URL
   - This is used specifically for optimizing transaction priority fees

4. CoinMarketCap API Key (for market sentiment):
   - Visit https://coinmarketcap.com/api
   - Sign up for a free API key
   - Save your API key

### 2. Wallet Setup & Funding

The bot requires a dedicated trading wallet with specific SOL requirements:

Initial Setup Costs:
- 0.02-ish SOL to open your Zeta Markets account (refundable)
- 0.02-ish SOL per trading token account (refundable):
  - SOL account: 0.02 SOL
  - ETH account: 0.02 SOL
  - BTC account: 0.02 SOL
  - Total for token accounts: 0.06 SOL
- At least 0.1-ish SOL left in wallet for ongoing transaction fees

Total SOL needed: ~0.24-ish SOL minimum (0.02-ish + 0.06 + 0.1-ish)

Additionally:
- USDC deposit on Zeta for trading collateral (this is what you'll trade with)

Setup Steps:
1. Create a new wallet
   - Always use a fresh wallet, never your main one
   - You'll need to verify you used the affiliate signup to get the API key from the SurfSolana #PerpSurfer discord channel
2. Visit Zeta Markets using our affiliate link: https://dex.zeta.markets/?r=surf
3. Fund your wallet with:
   - At least 0.24 SOL for fees and accounts
   - USDC for trading collateral
4. Deposit USDC to Zeta Markets through their UI
5. Export your private key:
   - Using SolFlare (because the export format is like so [1,2,3,...]), click on your wallet address
   - Select "Export Private Key"
   - Save the exported array format [1,2,3,...]

6. Create your wallet file:
   ```bash
   # Create a secure directory for wallet
   mkdir -p ~/.perpsurfer/wallet
   
   # Create and secure wallet file
   nano ~/.perpsurfer/wallet/trading-wallet.json
   ```

### 3. Prime Token Accounts

Before the bot can trade, you need to "prime" the token accounts on Zeta Markets. This requires approximately 0.02 SOL per token and is refundable when you close the accounts.

To prime an account for each token:

1. Visit Zeta Markets UI: https://dex.zeta.markets
2. Connect your trading wallet
3. For each token (SOL, ETH, BTC):
   - Navigate to the trading page for that token
   - Place a SELL (short) order with:
     - Minimum quantity (SOL: 0.1, ETH: 0.01, BTC: 0.001)
     - Price significantly above market price
     - Order type: POST-ONLY
   - Go to the "Orders" tab
   - Cancel the order

The account will now be primed for that token and ready for automated trading. If you skip this step, you'll receive errors when the bot tries to trade.

### 4. Project Installation

Install pnpm if you haven't already:
```bash
npm install -g pnpm
```

Install the project:
```bash
# Clone the repository
git clone https://github.com/SurfSolana/PerpSurfer
cd PerpSurfer

# Install dependencies
pnpm install
```

### 5. Configuration

1. Create your environment file:
   ```bash
   cp dotenv.example.txt .env
   cp config.sample.js config.js
   ```

2. Edit the `.env` file with your details:
   ```env
   # Trading Signals API
   WS_API_KEY=your_api_key_from_discord
   WS_HOST=api.nosol.lol
   WS_PORT=8080

   # RPC & Priority Fee Configuration
   RPC_TRADINGBOT=your_rpc_endpoint_from_any_provider
   HELIUS_API_KEY=your_helius_api_key_for_priority_fees_only

   # Market Sentiment Analysis
   CMC_API_KEY=your_coinmarketcap_api_key

   # Wallet Path - Update with your actual path
   KEYPAIR_FILE_PATH=/home/yourusername/.perpsurfer/wallet/trading-wallet.json
   ```

### 6. Optional Telegram Setup

For trade notifications:

1. Create a Telegram bot:
   - Message @BotFather on Telegram
   - Send /newbot
   - Follow the prompts
   - Save the provided API token

2. Get your Chat ID:
   - Message @userinfobot on Telegram
   - Save the ID number it provides

3. Add to your `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ADMIN_CHAT_ID=your_chat_id
   ```

### 7. Running the Bot

Start the bot:
```bash
node src/live-trading.js
```

For production deployment, use PM2:
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start src/live-trading.js --name perpsurfer

# Make it start on system boot
pm2 startup
pm2 save
```

## Risk Management Configuration

The bot's risk management system is configured through settings in the ZetaClientWrapper class. These settings control position sizing, take profits, stop losses, and trailing stop loss behavior.

### Position Size and Leverage

The bot implements a carefully designed leverage system that accounts for the different maximum leverage limits available on Zeta Markets for different assets.

For SOL, ETH, and BTC positions:
- The bot will use your configured `leverageMultiplier` setting directly
- While Zeta Markets allows up to 20x leverage for these assets, you should never use the maximum leverage
- Example: With `leverageMultiplier: 4`, a $1000 wallet can take positions worth $4000

### Take Profit and Stop Loss

The take profit and stop loss are set as percentages of your entry price:

```javascript
takeProfitPercentage: 0.036,  // 3.6% take profit
stopLossPercentage: 0.018,    // 1.8% stop loss
```

For example, if you enter a long position at $100:
- Take Profit would be set at $103.60 (100 + 3.6%)
- Stop Loss would be set at $98.20 (100 - 1.8%)

### Market Sentiment System

The bot uses a sophisticated market analysis system that:
- Analyzes price movements of top 100 cryptocurrencies
- Calculates market breadth and magnitude scores
- Determines overall market sentiment
- Prevents trades during extreme market conditions:
  - No longs during Extreme Fear
  - No shorts during Extreme Greed

## Monitoring

The bot creates two log files:
- `error.log`: Contains error messages only
- `combined.log`: Contains all log messages

If configured, Telegram notifications will inform you about:
- Trade entries and exits
- Stop loss adjustments
- Error conditions
- System status updates

## Track Your Wallet

You can easily track your wallet on Zeta by going to:

```
https://dex.zeta.markets/portfolio/YOUR_WALLET_PUBLIC_KEY
```

## Best Practices

Security Practices:
1. Use a dedicated trading wallet only
2. Keep your API keys secure
3. Keep your wallet private key secure
4. Monitor your positions regularly
5. Start with small position sizes until comfortable
6. Regularly check market sentiment analysis

## Support

We're here to help:
1. Discord: https://discord.gg/dpzudaBwSa
2. Website: https://surfsolana.com/
3. Trading signals support: #PerpSurfer channel on Discord
4. Technical support: #support channel on Discord

## Disclaimer

Trading cryptocurrency perpetual futures carries significant risk. This bot is provided as-is, with no guarantees of profit or performance. Always start with small position sizes and monitor the bot's performance carefully. Past performance does not indicate future results.