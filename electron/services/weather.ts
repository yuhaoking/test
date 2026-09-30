import type { WeatherData } from '../../shared/types';
import { logDebug } from '../utils/log';

/**
 * 天气服务（DeskBox 工作台“天气日历卡”）：
 * 使用 wttr.in 免费接口（无需 API Key），结果缓存 30 分钟；任何失败返回 null（界面降级“—”）。
 */

const CACHE_TTL = 30 * 60_000;

let cache: { data: WeatherData; at: number } | null = null;

export async function getWeather(): Promise<WeatherData | null> {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
    // wttr.in JSON：按城市自动探测（IP 定位），中文格式以便展示
    const res = await fetch('https://wttr.in/?format=j1&lang=zh', {
      headers: { 'User-Agent': 'xiaopeng-toolbox/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      nearest_area?: Array<{ areaName?: Array<{ value: string }> }>;
      current_condition?: Array<{
        temp_C?: string;
        FeelsLikeC?: string;
        humidity?: string;
        windspeedKmph?: string;
        weatherDesc?: Array<{ value: string }>;
      }>;
      weather?: Array<{
        date?: string;
        maxtempC?: string;
        mintempC?: string;
        hourly?: Array<{ weatherDesc?: Array<{ value: string }> }>;
      }>;
    };
    const cur = j.current_condition?.[0];
    const forecast = (j.weather ?? []).slice(0, 4).map((w) => ({
      date: w.date ?? '',
      maxC: w.maxtempC ? Math.round(parseFloat(w.maxtempC)) : null,
      minC: w.mintempC ? Math.round(parseFloat(w.mintempC)) : null,
      desc: w.hourly?.[0]?.weatherDesc?.[0]?.value ?? ''
    }));
    const data: WeatherData = {
      city: j.nearest_area?.[0]?.areaName?.[0]?.value ?? '',
      tempC: cur?.temp_C ? Math.round(parseFloat(cur.temp_C)) : null,
      feelsC: cur?.FeelsLikeC ? Math.round(parseFloat(cur.FeelsLikeC)) : null,
      humidity: cur?.humidity ? Math.round(parseFloat(cur.humidity)) : null,
      windKmh: cur?.windspeedKmph ? Math.round(parseFloat(cur.windspeedKmph)) : null,
      desc: cur?.weatherDesc?.[0]?.value ?? '',
      forecast
    };
    cache = { data, at: Date.now() };
    return data;
  } catch (e) {
    logDebug('[weather] 获取天气失败', e);
    return null;
  }
}
