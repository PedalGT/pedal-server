// Dynamic pricing and CO2 estimates. All money math lives here, in integer cents.
// The Ask Pedal assistant only explains these numbers; it never computes them.

const PRICING = {
  unlockFeeCents: 0,          // no unlock fee
  baseCentsPerMinute: 12,     // before demand / time / weather
  minRateCents: 8,            // the rate never goes below this...
  maxRateCents: 20,           // ...or above this (Lime is roughly $0.39+/min)
  minFareCents: 50,           // a ride costs at least $0.50
  ownerShare: 0.8,            // owner keeps 80%
  minBalanceToStartCents: 100
};

// ---- Weather (Open-Meteo: free, no API key). Cached, refreshed in the background.
const CAMPUS = { lat: 33.7756, lng: -84.3963 };
let weather = { temperatureC: null, rainMm: null, source: 'not loaded yet', fetchedAt: 0 };

async function refreshWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CAMPUS.lat}&longitude=${CAMPUS.lng}` +
      '&current=temperature_2m,precipitation&timezone=America%2FNew_York';
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const t = Number(body.current?.temperature_2m), r = Number(body.current?.precipitation);
    if (!Number.isFinite(t) || !Number.isFinite(r)) throw new Error('bad data');
    weather = { temperatureC: t, rainMm: r, source: 'Open-Meteo', fetchedAt: Date.now() };
  } catch (err) {
    // Keep the last good reading; with none, weather just doesn't move the price.
    if (!weather.fetchedAt) weather = { ...weather, source: `unavailable (${err.message})` };
  }
}
refreshWeather();
setInterval(refreshWeather, 10 * 60 * 1000).unref();

// ---- Helpers
function atlantaHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
}

function metersBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Current per-minute rate for a bike, with the reasons. Locked onto the ride at unlock.
 * factors: [{ key, label, multiplier }] — label is rider-facing text.
 */
function smartRate(bike, allBikes, now = new Date()) {
  const factors = [];

  // Demand: how many other bikes are free within ~500 m. Scarce = a little more.
  let nearby = 0;
  if (bike.lastLat != null) {
    const here = { lat: bike.lastLat, lng: bike.lastLng };
    nearby = allBikes.filter(b => b.id !== bike.id && b.status === 'available' && b.lastLat != null &&
      metersBetween(here, { lat: b.lastLat, lng: b.lastLng }) <= 500).length;
  }
  if (nearby === 0) factors.push({ key: 'demand', label: 'Only bike nearby', multiplier: 1.15 });
  else if (nearby <= 2) factors.push({ key: 'demand', label: `${nearby} other bike${nearby === 1 ? '' : 's'} nearby`, multiplier: 1.05 });
  else factors.push({ key: 'demand', label: `${nearby} other bikes nearby`, multiplier: 0.95 });

  // Time of day in Atlanta: class-change rush vs. late night.
  const hour = atlantaHour(now);
  if ((hour >= 8 && hour <= 10) || (hour >= 16 && hour <= 18)) factors.push({ key: 'time', label: 'Rush hour', multiplier: 1.1 });
  else if (hour >= 22 || hour <= 5) factors.push({ key: 'time', label: 'Late night', multiplier: 0.9 });
  else factors.push({ key: 'time', label: 'Regular hours', multiplier: 1 });

  // Weather: rain is a discount (fewer riders), a nice day nudges it up.
  if (weather.rainMm > 0) factors.push({ key: 'weather', label: 'Raining', multiplier: 0.85 });
  else if (weather.temperatureC >= 18 && weather.temperatureC <= 29) factors.push({ key: 'weather', label: `Nice out (${Math.round(weather.temperatureC)}°C)`, multiplier: 1.05 });
  else if (weather.temperatureC != null) factors.push({ key: 'weather', label: `${Math.round(weather.temperatureC)}°C`, multiplier: 1 });
  else factors.push({ key: 'weather', label: 'No weather data', multiplier: 1 });

  const raw = PRICING.baseCentsPerMinute * factors.reduce((m, f) => m * f.multiplier, 1);
  const centsPerMinute = Math.max(PRICING.minRateCents, Math.min(PRICING.maxRateCents, Math.round(raw)));
  return {
    centsPerMinute,
    baseCentsPerMinute: PRICING.baseCentsPerMinute,
    minRateCents: PRICING.minRateCents,
    maxRateCents: PRICING.maxRateCents,
    minFareCents: PRICING.minFareCents,
    unlockFeeCents: PRICING.unlockFeeCents,
    factors,
    weatherSource: weather.source
  };
}

/** Billed by the second at the locked rate, with a minimum fare. */
function fareCents(centsPerMinute, seconds) {
  return Math.max(PRICING.minFareCents, Math.round(centsPerMinute * seconds / 60));
}

// ---- CO2: estimated distance from ride time, compared with driving the same distance.
// Average passenger car ≈ 400 g CO2 per mile (US EPA) ≈ 250 g/km.
const CAR_GRAMS_PER_KM = 250;
const SPEED_KMH = { bike: 12, scooter: 15 };

function rideImpact(seconds, kind) {
  const km = (seconds / 3600) * (SPEED_KMH[kind] || SPEED_KMH.bike);
  return { distanceKm: Math.round(km * 100) / 100, co2SavedGrams: Math.round(km * CAR_GRAMS_PER_KM) };
}

module.exports = { PRICING, smartRate, fareCents, rideImpact, CAR_GRAMS_PER_KM, currentWeather: () => weather };
