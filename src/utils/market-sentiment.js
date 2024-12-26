import 'dotenv/config';
import axios from 'axios';

const calculateSentimentMetrics = (percentChanges) => {
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

  const index = Math.round(
      (breadthScore * breadthWeight) + 
      (magnitudeScore * magnitudeWeight)
  );

  return Math.min(100, Math.max(0, index));
};

const calculateIndex = (hourData, dayData) => {
  const hourlyIndex = calculateSentimentMetrics(hourData);
  const dailyIndex = calculateSentimentMetrics(dayData);
  
  return Math.round((hourlyIndex + dailyIndex) / 2);
};

const getSentiment = (value) => {
  // Using more evenly distributed ranges for better psychological balance
  if (value >= 70) return 'Extreme Greed';    // Range: 20 points (80-100)
  if (value >= 60) return 'Greed';            // Range: 20 points (60-79)
  if (value >= 40) return 'Neutral';          // Range: 20 points (40-59)
  if (value >= 30) return 'Fear';             // Range: 20 points (20-39)
  return 'Extreme Fear';                      // Range: 20 points (0-19)
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

    const hourlyChanges = response.data.data.map(coin => coin.quote.USD.percent_change_1h);
    const dailyChanges = response.data.data.map(coin => coin.quote.USD.percent_change_24h);
    
    const index = calculateIndex(hourlyChanges, dailyChanges);
    const sentiment = getSentiment(index);

    return {
      index,
      sentiment,
      canOpenLong: !sentiment.includes('Extreme Fear'),
      canOpenShort: !sentiment.includes('Extreme Greed'),
      timestamp: new Date()
    };
  } catch (error) {
    throw new Error(`Failed to fetch market sentiment: ${error.message}`);
  }
};

export { getMarketSentiment };