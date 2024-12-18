import 'dotenv/config';
import axios from 'axios';

const calculateIndex = (percentChanges) => {
  const gainers = percentChanges.filter(x => x > 0).length;
  const total = percentChanges.length;
  const gainersPercentage = (gainers / total) * 100;
  
  const positiveChanges = percentChanges.filter(x => x > 0);
  const negativeChanges = percentChanges.filter(x => x < 0);
  
  const positiveAvg = positiveChanges.length > 0 
      ? positiveChanges.reduce((acc, val) => acc + val, 0) / positiveChanges.length 
      : 0;
  const negativeAvg = negativeChanges.length > 0
      ? Math.abs(negativeChanges.reduce((acc, val) => acc + val, 0) / negativeChanges.length)
      : 0;

  const breadthWeight = 0.7;
  const magnitudeWeight = 0.3;

  const breadthScore = gainersPercentage;

  let magnitudeScore;
  if (positiveAvg === 0 && negativeAvg === 0) {
      magnitudeScore = 50;
  } else {
      magnitudeScore = (positiveAvg / (positiveAvg + negativeAvg)) * 100;
  }

  const finalIndex = Math.round(
      (breadthScore * breadthWeight) + 
      (magnitudeScore * magnitudeWeight)
  );

  return Math.min(100, Math.max(0, finalIndex));
};

const getSentiment = (value) => {
  if (value >= 80) return 'Extreme Greed';
  if (value >= 65) return 'Greed';
  if (value >= 45) return 'Neutral';
  if (value >= 35) return 'Fear';
  return 'Extreme Fear';
};

const getMarketSentiment = async () => {
  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY
      },
      params: {
        limit: 100,
        convert: 'USD'
      }
    });

    const percentChanges = response.data.data.map(coin => coin.quote.USD.percent_change_1h);
    const index = calculateIndex(percentChanges);
    const sentiment = getSentiment(index);

    return {
      index,
      sentiment,
      canOpenLong: sentiment.includes('Greed'),
      canOpenShort: sentiment.includes('Fear'),
      timestamp: new Date()
    };
  } catch (error) {
    throw new Error(`Failed to fetch market sentiment: ${error.message}`);
  }
};

export { getMarketSentiment };