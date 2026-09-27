// "Bike to events": real upcoming Georgia Tech events (GT Engage, public JSON),
// picked and pitched by an LLM, with a flat fare for riding there.
//
// Flat fare rule: a ride started from an event invite costs at most EVENT_FLAT_FARE_CENTS
// if it ends within EVENT_RADIUS_M of the venue, between 60 min before the event and
// its end. Otherwise it's a normal ride. The model never touches the money.

const llm = require('./llm');

const EVENT_FLAT_FARE_CENTS = 25;   // always under the regular 50¢ minimum fare
const EVENT_RADIUS_M = 300;
const WINDOW_BEFORE_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
const REFRESH_MS = 15 * 60 * 1000;
const MAX_PICKS = 6;
const CAMPUS = { lat: 33.7756, lng: -84.3963 };

let cache = { events: [], source: 'not loaded', fetchedAt: 0 };
let loading = null;

function metersBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const stripHtml = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();

// Upcoming events that have a map location (needed to check the flat fare).
async function fetchEngage() {
  const now = new Date();
  const url = 'https://gatech.campuslabs.com/engage/api/discovery/event/search' +
    `?status=Approved&take=100&orderByField=startsOn&orderByDirection=ascending&endsAfter=${encodeURIComponent(now.toISOString())}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Engage HTTP ${res.status}`);
  const body = await res.json();
  return (body.value || [])
    .map(e => ({
      id: String(e.id),
      name: e.name,
      startsOn: e.startsOn,
      endsOn: e.endsOn,
      location: e.location,
      lat: e.latitude != null ? Number(e.latitude) : null,
      lng: e.longitude != null ? Number(e.longitude) : null,
      organizationName: e.organizationName,
      freeFood: (e.benefitNames || []).includes('Free Food'),
      rsvpTotal: e.rsvpTotal || 0,
      categories: e.categoryNames || [],
      imageUrl: e.imagePath ? `https://se-images.campuslabs.com/clink/images/${e.imagePath}?preset=med-w` : null,
      summary: stripHtml(e.description).slice(0, 280),
      url: `https://gatech.campuslabs.com/engage/event/${e.id}`
    }))
    .filter(e => e.lat != null && e.lng != null && Number.isFinite(e.lat) &&
      Date.parse(e.startsOn) - now.getTime() < LOOKAHEAD_MS &&
      metersBetween(CAMPUS, { lat: e.lat, lng: e.lng }) < 5000);
}

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          invite: { type: 'string', description: 'One friendly line, under 90 characters, inviting a student to bike there.' }
        },
        required: ['id', 'invite']
      }
    }
  },
  required: ['picks']
};

async function pickWithModel(events) {
  const list = events.map(e => ({
    id: e.id, name: e.name, startsOn: e.startsOn, location: e.location, organization: e.organizationName,
    freeFood: e.freeFood, rsvps: e.rsvpTotal, categories: e.categories, summary: e.summary.slice(0, 160),
    kmFromCampusCenter: Math.round(metersBetween(CAMPUS, { lat: e.lat, lng: e.lng }) / 100) / 10
  }));
  const { value: result, provider } = await llm.generateJSON({
    system: 'You pick Georgia Tech campus events that students would enjoy biking to, and write one short, ' +
      'friendly invite line for each (no hashtags, no emojis, mention free food when there is some). ' +
      'Prefer events open to everyone, with more RSVPs or free food, spread over different times. ' +
      `Return at most ${MAX_PICKS} picks, using the given ids exactly.`,
    prompt: `Upcoming events (JSON):\n${JSON.stringify(list)}`,
    schema: PICK_SCHEMA,
    temperature: 0.4,
    prefer: 'muse'
  });
  const byId = new Map(events.map(e => [e.id, e]));
  const picks = (result?.picks || []).filter(p => byId.has(String(p.id))).slice(0, MAX_PICKS);
  if (!picks.length) throw new Error('model picked nothing');
  return { provider, picks: picks.map(p => ({ ...byId.get(String(p.id)), invite: String(p.invite).slice(0, 120) })) };
}

// No model: most RSVPs and free food first, with a template invite.
function pickByScore(events) {
  return [...events]
    .sort((a, b) => (b.rsvpTotal + (b.freeFood ? 25 : 0)) - (a.rsvpTotal + (a.freeFood ? 25 : 0)))
    .slice(0, MAX_PICKS)
    .map(e => ({ ...e, invite: `${e.freeFood ? 'Free food at ' : ''}${e.name} at ${e.location}. Bike there for $${(EVENT_FLAT_FARE_CENTS / 100).toFixed(2)}.` }));
}

async function refresh() {
  const events = await fetchEngage();
  let picked, source, poweredBy = null;
  if (llm.configured()) {
    try { ({ picks: picked, provider: poweredBy } = await pickWithModel(events)); source = poweredBy; }
    catch (err) { console.warn(`Events: no model answered (${err.message.slice(0, 120)}), ranking by RSVPs`); }
  }
  if (!picked) { picked = pickByScore(events); source = 'ranked by RSVPs (no AI key)'; }
  picked.sort((a, b) => Date.parse(a.startsOn) - Date.parse(b.startsOn));
  cache = { events: picked, source, poweredBy, fetchedAt: Date.now() };
}

/** Picked events, refreshed every 15 minutes. Serves the last good list if Engage is down. */
async function list() {
  if (Date.now() - cache.fetchedAt > REFRESH_MS) {
    loading = loading || refresh().catch(err => {
      console.warn(`Events: ${err.message}`);
      if (!cache.fetchedAt) cache.source = `unavailable (${err.message})`;
    }).finally(() => { loading = null; });
    if (!cache.fetchedAt) await loading;   // first load: wait; later: refresh in the background
  }
  return cache;
}

const find = (eventId) => cache.events.find(e => e.id === String(eventId)) || null;

/** Flat fare if the ride really went to the event, else null (normal fare applies). */
function eventFare(ride, endAt, lat, lng) {
  const event = ride.event;
  if (!event) return null;
  const inWindow = endAt >= Date.parse(event.startsOn) - WINDOW_BEFORE_MS && endAt <= Date.parse(event.endsOn);
  const nearVenue = lat != null && lng != null && metersBetween({ lat, lng }, { lat: event.lat, lng: event.lng }) <= EVENT_RADIUS_M;
  return inWindow && nearVenue ? EVENT_FLAT_FARE_CENTS : null;
}

module.exports = { list, find, eventFare, metersBetween, EVENT_FLAT_FARE_CENTS, EVENT_RADIUS_M };
