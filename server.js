const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { data, save, id, bikeCode, balanceOf } = require('./db');

// ---- Pricing: dynamic, in pricing.js (no unlock fee, 8-20¢/min, billed by the second).
const { PRICING, smartRate, fareCents, rideImpact, currentWeather } = require('./pricing');
const events = require('./events');
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
const CARD_LINK_WINDOW_MS = 60 * 1000;

// ---- Ride links. PLACEHOLDER: set SITE_URL to the published site, e.g.
//   SITE_URL=https://pedal.yourdomain.com node server.js
// A ride link is <SITE_URL>/ride/<BIKE_CODE>. With the app installed, iOS opens
// it straight in the app (Universal Link), which starts the ride.
const SITE_URL = (process.env.SITE_URL || 'https://PLACEHOLDER-SITE.example').replace(/\/$/, '');
const IOS_APP_ID = '4U2M65374F.com.sahilquazi.pedal';   // Team ID + bundle ID

// ---- Demo accounts, created on startup if missing (idempotent).
// PLACEHOLDER card: the one card the lock accepts. Must match ALLOWED_CARD_UID
// in arduino/pedal_lock_test. It's the old BuzzCard until the real card is known.
const DEMO_CARD_UID = process.env.DEMO_CARD_UID || '04842E726B1C90';
// Bike colors the app's photo check can recognize.
const BIKE_COLORS = ['black', 'white', 'silver', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
const bikeColor = (value) => {
  const c = String(value || '').trim().toLowerCase();
  return BIKE_COLORS.includes(c) ? c : null;
};
// Demo bikes' colors, set on startup if a bike has none. PLACEHOLDER for Test Bike.
const DEMO_BIKE_COLORS = { NM69B2: 'black', Z7G5BL: 'blue', '478X2E': 'red', CPTVGE: 'silver' };
const DEMO_BIKE_CODE = 'NM69B2';            // Test Bike, the Arduino lock
const DEMO_BIKE_OWNER = 'card@pedal.app';
const DEMO_ACCOUNTS = [
  // The card is linked to the phone account, so a card unlock shows in the app.
  { role: 'phone', name: 'Sahil',            email: 'test@pedal.app', password: 'pedal123', gtid: '904074140', balanceCents: 2000, cardUid: DEMO_CARD_UID },
  { role: 'spare', name: 'Demo Card Rider',  email: 'card@pedal.app', password: 'pedal123', gtid: '903000001', balanceCents: 1500, cardUid: null }
];

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // the Arduino posts form data

// One line per request, for watching the app and the lock live. Lock polls that
// return NONE are skipped, otherwise they'd flood the log once a second.
app.use((req, res, next) => {
  const started = Date.now();
  let reply = '';
  const send = res.send.bind(res);
  res.send = body => {
    if (typeof body === 'string' && body.length < 60) reply = body;
    return send(body);
  };
  res.on('finish', () => {
    if (req.path === '/api/device/poll' && reply === 'NONE') return;
    if (!req.path.startsWith('/api/') && req.path !== '/b') return;
    const who = req.bike ? `lock ${req.bike.code}` : req.user ? req.user.email : req.ip.replace('::ffff:', '');
    const time = new Date().toLocaleTimeString();
    console.log(`${time}  ${res.statusCode}  ${req.method} ${req.path}  (${who})${reply ? '  -> ' + reply : ''}  ${Date.now() - started}ms`);
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, gtid: u.gtid || null, cardUid: u.cardUid || null });
const findBikeByCode = (code) => data.bikes.find(b => b.code === String(code || '').trim().toUpperCase());
const activeRideFor = (userId) => data.rides.find(r => r.riderId === userId && r.status === 'active');
const activeRideOnBike = (bikeId) => data.rides.find(r => r.bikeId === bikeId && r.status === 'active');
const num = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));

function queueCommand(bike, action) {
  data.commands = data.commands.filter(c => c.bikeId !== bike.id); // newest wins
  data.commands.push({ bikeId: bike.id, action, createdAt: Date.now() });
}

// Rides started under dynamic pricing carry their locked rate; older rides keep
// the old unlock-fee + per-minute formula so their history still adds up.
function rideCost(ride, bike, endAt) {
  const seconds = Math.max(1, Math.round((endAt - ride.startAt) / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (ride.rateCentsPerMinute != null) return { minutes, seconds, cost: fareCents(ride.rateCentsPerMinute, seconds) };
  return { minutes, seconds, cost: (bike.unlockFeeCents || 0) + minutes * (bike.perMinuteCents || 10) };
}

const priceFor = (bike) => smartRate(bike, data.bikes);

// A rider's totals from finished rides (older rides without a stored estimate count 0).
function impactFor(userId) {
  const rides = data.rides.filter(r => r.riderId === userId && r.status === 'done');
  return {
    rides: rides.length,
    distanceKm: Math.round(rides.reduce((s, r) => s + (r.distanceKm || 0), 0) * 100) / 100,
    co2SavedGrams: rides.reduce((s, r) => s + (r.co2SavedGrams || 0), 0)
  };
}

function startRide(user, bike, lat, lng, via) {
  if (activeRideFor(user.id)) return { error: 'You already have a ride in progress. End it first.' };
  if (bike.status === 'in_use') return { error: 'This bike is in use right now.' };
  if (bike.status !== 'available') return { error: 'This bike is unavailable right now.' };
  if (bike.ownerId === user.id) {
    // Owners can unlock their own bike for free
  } else if (balanceOf(user.id) < PRICING.minBalanceToStartCents) {
    return { error: `Add funds first. You need at least $${(PRICING.minBalanceToStartCents / 100).toFixed(2)} to start a ride.` };
  }
  const quote = priceFor(bike);   // locked for the whole ride
  const ride = {
    id: id('ride'), bikeId: bike.id, riderId: user.id, status: 'active', via,
    rateCentsPerMinute: quote.centsPerMinute, priceFactors: quote.factors,
    startAt: Date.now(), endAt: null,
    startLat: lat ?? bike.lastLat, startLng: lng ?? bike.lastLng,
    endLat: null, endLng: null, costCents: 0, ownerCents: 0, minutes: 0
  };
  data.rides.push(ride);
  bike.status = 'in_use';
  queueCommand(bike, 'UNLOCK');
  save();
  return { ride };
}

function endRide(ride, lat, lng) {
  const bike = data.bikes.find(b => b.id === ride.bikeId);
  const endAt = Date.now();
  const isOwner = bike.ownerId === ride.riderId;
  let { minutes, seconds, cost } = rideCost(ride, bike, endAt);
  // Rode to the event it was started for: flat fare (if that's cheaper).
  const flat = events.eventFare(ride, endAt, lat, lng);
  if (ride.event) ride.eventFareApplied = flat != null && flat < cost;
  if (ride.eventFareApplied) cost = flat;
  ride.status = 'done';
  ride.endAt = endAt;
  ride.minutes = minutes;
  ride.seconds = seconds;
  Object.assign(ride, rideImpact(seconds, bike.kind));   // distanceKm, co2SavedGrams
  ride.endLat = lat ?? ride.startLat;
  ride.endLng = lng ?? ride.startLng;
  ride.costCents = isOwner ? 0 : cost;
  ride.ownerCents = isOwner ? 0 : Math.round(cost * PRICING.ownerShare);

  if (!isOwner) {
    data.txns.push({ id: id('txn'), userId: ride.riderId, amountCents: -ride.costCents, type: 'ride', rideId: ride.id, note: `Ride on ${bike.name}`, createdAt: endAt });
    data.txns.push({ id: id('txn'), userId: bike.ownerId, amountCents: ride.ownerCents, type: 'earning', rideId: ride.id, note: `Someone rode ${bike.name}`, createdAt: endAt });
  }
  if (ride.endLat != null) { bike.lastLat = ride.endLat; bike.lastLng = ride.endLng; bike.lastLocationAt = endAt; }
  bike.status = 'available';
  queueCommand(bike, 'LOCK');
  save();
  return ride;
}

function rideView(ride) {
  if (!ride) return null;
  const bike = data.bikes.find(b => b.id === ride.bikeId);
  const live = ride.status === 'active' ? rideCost(ride, bike, Date.now()) : null;
  return {
    ...ride,
    bikeName: bike?.name, bikeCode: bike?.code, bikeColor: bike?.color || null,
    unlockFeeCents: ride.rateCentsPerMinute != null ? 0 : bike?.unlockFeeCents,
    perMinuteCents: ride.rateCentsPerMinute ?? bike?.perMinuteCents,
    minFareCents: ride.rateCentsPerMinute != null ? PRICING.minFareCents : 0,
    liveCostCents: live ? (bike.ownerId === ride.riderId ? 0 : live.cost) : null,
    isOwnBike: bike?.ownerId === ride.riderId
  };
}

// ---------- auth middleware ----------
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = data.sessions.find(s => s.token === token);
  const user = session && data.users.find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: 'Log in to continue.' });
  req.user = user;
  next();
}

function deviceAuth(req, res, next) {
  const lockId = req.query.lock || req.body.lock;
  const key = req.headers['x-device-key'] || req.body.key || req.query.key;
  const bike = data.bikes.find(b => b.id === lockId);
  if (!bike || bike.deviceKey !== key) return res.status(401).type('text').send('DENY:bad_device');
  bike.lastSeenAt = Date.now();
  req.bike = bike;
  next();
}

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Admin key required.' });
  next();
}

// ---------- health (the iOS app's "Test connection" button) ----------
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'pedal', time: Date.now() }));

// ---------- auth ----------
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Use a password with at least 6 characters.' });
  const normEmail = email.trim().toLowerCase();
  if (data.users.some(u => u.email === normEmail)) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });
  const { hash, salt } = hashPassword(password);
  const user = { id: id('usr'), name: name.trim(), email: normEmail, passHash: hash, salt, cardUid: null, createdAt: Date.now() };
  data.users.push(user);
  const token = crypto.randomBytes(24).toString('hex');
  data.sessions.push({ token, userId: user.id, createdAt: Date.now() });
  save();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = data.users.find(u => u.email === String(email || '').trim().toLowerCase());
  if (!user || hashPassword(password || '', user.salt).hash !== user.passHash) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  data.sessions.push({ token, userId: user.id, createdAt: Date.now() });
  save();
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user), balanceCents: balanceOf(req.user.id), activeRide: rideView(activeRideFor(req.user.id)), pricing: PRICING, impact: impactFor(req.user.id), eventPass: passView(activePass(req.user.id)) });
});

// ---------- wallet (fake payments) ----------
app.post('/api/wallet/topup', auth, (req, res) => {
  // Proof of concept: no real money moves. Apple Pay tokens are accepted but not processed.
  const amountCents = Math.round(Number(req.body.amountCents));
  const method = ['apple_pay', 'buzzcard'].includes(req.body.method) ? req.body.method : 'card';
  if (!(amountCents >= 100 && amountCents <= 10000)) {
    return res.status(400).json({ error: 'Choose an amount between $1 and $100.' });
  }
  let note;
  if (method === 'apple_pay') {
    note = 'Added funds with Apple Pay';
  } else if (method === 'buzzcard') {
    note = 'Added from BuzzCard funds (demo, nothing charged)';
  } else {
    const cardNumber = String(req.body.cardNumber || '').replace(/\s/g, '');
    if (!/^\d{12,19}$/.test(cardNumber)) return res.status(400).json({ error: 'Enter a card number. For testing, use 4242 4242 4242 4242.' });
    note = `Added funds (card ending ${cardNumber.slice(-4)})`;
  }
  data.txns.push({ id: id('txn'), userId: req.user.id, amountCents, type: 'topup', method, note, createdAt: Date.now() });
  save();
  res.json({ balanceCents: balanceOf(req.user.id) });
});

app.get('/api/wallet/txns', auth, (req, res) => {
  const txns = data.txns.filter(t => t.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  res.json({ balanceCents: balanceOf(req.user.id), txns });
});

// ---------- bikes (rider side) ----------
app.get('/api/bikes', auth, (req, res) => {
  res.json({
    // A bike set to "offline" is hidden from riders, but its owner still sees it.
    bikes: data.bikes.filter(b => b.status !== 'offline' || b.ownerId === req.user.id).map(b => ({
      id: b.id, code: b.code, name: b.name, kind: b.kind, status: b.status, color: b.color || null,
      lastLat: b.lastLat, lastLng: b.lastLng, lastLocationAt: b.lastLocationAt,
      unlockFeeCents: 0, perMinuteCents: priceFor(b).centsPerMinute, price: priceFor(b),
      openIssues: openIssues(b).length,
      online: !!b.lastSeenAt && Date.now() - b.lastSeenAt < 15000,
      mine: b.ownerId === req.user.id
    }))
  });
});

app.get('/api/bikes/code/:code', auth, (req, res) => {
  const b = findBikeByCode(req.params.code);
  if (!b) return res.status(404).json({ error: 'No bike with that code. Check the code on the lock.' });
  const owner = data.users.find(u => u.id === b.ownerId);
  res.json({
    bike: {
      id: b.id, code: b.code, name: b.name, kind: b.kind, status: b.status, color: b.color || null, ownerName: owner?.name,
      unlockFeeCents: 0, perMinuteCents: priceFor(b).centsPerMinute, price: priceFor(b),
      openIssues: openIssues(b).length,
      lastLat: b.lastLat, lastLng: b.lastLng,
      online: !!b.lastSeenAt && Date.now() - b.lastSeenAt < 15000,
      mine: b.ownerId === req.user.id
    }
  });
});

// ---------- rides ----------
app.post('/api/rides/start', auth, (req, res) => {
  const bike = findBikeByCode(req.body.bikeCode);
  if (!bike) return res.status(404).json({ error: 'No bike with that code. Check the code on the lock.' });
  const result = startRide(req.user, bike, num(req.body.lat), num(req.body.lng), 'app');
  if (result.error) return res.status(400).json({ error: result.error });
  // Started from an event invite: remember where it's going for the flat fare.
  const event = req.body.eventId ? events.find(req.body.eventId) : null;
  if (event) {
    result.ride.event = eventSnapshot(event);
    eventPasses.delete(req.user.id);
    save();
  }
  res.json({ ride: rideView(result.ride), balanceCents: balanceOf(req.user.id) });
});

app.post('/api/rides/end', auth, (req, res) => {
  const ride = activeRideFor(req.user.id);
  if (!ride) return res.status(400).json({ error: 'You don\u2019t have a ride in progress.' });
  // Result of the app's end-of-ride photo check (on-device, optional for now).
  const pc = req.body.photoCheck;
  if (pc && typeof pc === 'object') {
    ride.photoCheck = {
      bikeDetected: !!pc.bikeDetected,
      confidence: Math.max(0, Math.min(1, Number(pc.confidence) || 0)),
      detectedColor: bikeColor(pc.detectedColor),
      colorMatches: pc.colorMatches == null ? null : !!pc.colorMatches,
      condition: String(pc.condition || '').slice(0, 40),
      checkedAt: Date.now()
    };
  }
  endRide(ride, num(req.body.lat), num(req.body.lng));
  res.json({ ride: rideView(ride), balanceCents: balanceOf(req.user.id) });
});

app.get('/api/rides/history', auth, (req, res) => {
  const rides = data.rides.filter(r => r.riderId === req.user.id).sort((a, b) => b.startAt - a.startAt).slice(0, 30).map(rideView);
  res.json({ rides });
});

// ---------- card linking (tap a keycard on any lock within 60s) ----------
app.post('/api/cards/link-start', auth, (req, res) => {
  data.cardLinks = data.cardLinks.filter(l => l.userId !== req.user.id && l.expiresAt > Date.now());
  data.cardLinks.push({ userId: req.user.id, expiresAt: Date.now() + CARD_LINK_WINDOW_MS });
  save();
  res.json({ expiresAt: Date.now() + CARD_LINK_WINDOW_MS });
});

app.post('/api/cards/unlink', auth, (req, res) => {
  req.user.cardUid = null;
  save();
  res.json({ user: publicUser(req.user) });
});

// ---------- owner side ----------
app.post('/api/owner/bikes', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give your bike or scooter a name.' });
  const perMinuteCents = PRICING.baseCentsPerMinute;   // pricing is automatic; owners don't set it
  const bike = {
    id: id('lock'), code: bikeCode(), name, ownerId: req.user.id,
    kind: req.body.kind === 'scooter' ? 'scooter' : 'bike',
    color: bikeColor(req.body.color),
    deviceKey: crypto.randomBytes(12).toString('hex'),
    status: 'available',
    unlockFeeCents: PRICING.unlockFeeCents, perMinuteCents,
    lastLat: num(req.body.lat), lastLng: num(req.body.lng),
    lastLocationAt: num(req.body.lat) != null ? Date.now() : null,
    lastSeenAt: null, locked: true, createdAt: Date.now()
  };
  data.bikes.push(bike);
  save();
  res.json({ bike });
});

app.get('/api/owner/bikes', auth, (req, res) => {
  const bikes = data.bikes.filter(b => b.ownerId === req.user.id).map(b => {
    const rides = data.rides.filter(r => r.bikeId === b.id && r.status === 'done');
    const active = activeRideOnBike(b.id);
    const rider = active && data.users.find(u => u.id === active.riderId);
    return {
      ...b,
      unlockFeeCents: 0, perMinuteCents: priceFor(b).centsPerMinute, price: priceFor(b),
      openIssues: openIssues(b).length,
      online: !!b.lastSeenAt && Date.now() - b.lastSeenAt < 15000,
      rideCount: rides.length,
      earnedCents: rides.reduce((s, r) => s + r.ownerCents, 0),
      currentRider: rider ? rider.name : null
    };
  });
  res.json({ bikes });
});

// Riders report a problem with a bike (from Ask Pedal or the app). The owner sees
// it on the bike; riders see the bike has an open report.
function openIssues(bike) { return (bike.issues || []).filter(i => i.status === 'open'); }

app.post('/api/bikes/:code/issues', auth, (req, res) => {
  const bike = findBikeByCode(req.params.code);
  if (!bike) return res.status(404).json({ error: 'No bike with that code.' });
  const summary = String(req.body.summary || '').trim().slice(0, 300);
  if (!summary) return res.status(400).json({ error: 'Say what\u2019s wrong with the bike.' });
  const issue = { id: id('iss'), reporterId: req.user.id, reporterName: req.user.name, summary,
                  unsafe: !!req.body.unsafe, status: 'open', createdAt: Date.now() };
  bike.issues = [...(bike.issues || []), issue];
  save();
  res.json({ issue, openIssues: openIssues(bike).length });
});

app.post('/api/owner/bikes/:id/issues/:issueId/resolve', auth, (req, res) => {
  const bike = data.bikes.find(b => b.id === req.params.id && b.ownerId === req.user.id);
  const issue = bike && (bike.issues || []).find(i => i.id === req.params.issueId);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  issue.status = 'resolved';
  issue.resolvedAt = Date.now();
  save();
  res.json({ issue });
});

app.patch('/api/owner/bikes/:id', auth, (req, res) => {
  const bike = data.bikes.find(b => b.id === req.params.id && b.ownerId === req.user.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found.' });
  if (req.body.name) bike.name = String(req.body.name).trim();
  if (req.body.color !== undefined) bike.color = bikeColor(req.body.color);
  if (req.body.perMinuteCents) bike.perMinuteCents = Math.min(50, Math.max(5, Math.round(Number(req.body.perMinuteCents))));
  if (req.body.status === 'offline' && bike.status === 'available') bike.status = 'offline';
  if (req.body.status === 'available' && bike.status === 'offline') bike.status = 'available';
  save();
  res.json({ bike });
});

// ---------- Bike to events ----------
// Picked GT events with the nearest free bike to each rider's pick-up point.
app.get('/api/events', auth, async (req, res) => {
  const { events: picked, source, poweredBy } = await events.list();
  const free = data.bikes.filter(b => b.status === 'available' && b.lastLat != null);
  res.json({
    source,
    poweredBy,   // "Muse" | "Gemini" | null (ranked without AI)
    flatFareCents: events.EVENT_FLAT_FARE_CENTS,
    radiusMeters: events.EVENT_RADIUS_M,
    events: picked.map(e => {
      const nearest = free
        .map(b => ({ code: b.code, name: b.name, meters: Math.round(events.metersBetween({ lat: b.lastLat, lng: b.lastLng }, e)) }))
        .sort((a, b) => a.meters - b.meters)[0] || null;
      // What this trip would normally cost: nearest bike's live rate for the ride there at ~12 km/h.
      let usualFareCents = null;
      if (nearest) {
        const bike = data.bikes.find(b => b.code === nearest.code);
        const km = (nearest.meters / 1000) * 1.3;   // streets aren't straight lines
        usualFareCents = fareCents(priceFor(bike).centsPerMinute, Math.max(60, km / 12 * 3600));
      }
      return { ...e, flatFareCents: events.EVENT_FLAT_FARE_CENTS, usualFareCents, nearestBike: nearest };
    })
  });
});

// "Ride to this event": arms a one-time pass. The rider's next card tap on ANY lock
// starts the ride with the event's flat fare. Expires after EVENT_PASS_MS.
const EVENT_PASS_MS = 10 * 60 * 1000;
const eventPasses = new Map();   // userId -> { event, expiresAt }

function eventSnapshot(event) {
  return { id: event.id, name: event.name, location: event.location, lat: event.lat, lng: event.lng,
           startsOn: event.startsOn, endsOn: event.endsOn, flatFareCents: events.EVENT_FLAT_FARE_CENTS };
}
function activePass(userId) {
  const pass = eventPasses.get(userId);
  if (pass && pass.expiresAt > Date.now()) return pass;
  eventPasses.delete(userId);
  return null;
}
const passView = (pass) => pass && { eventId: pass.event.id, eventName: pass.event.name, location: pass.event.location,
                                     flatFareCents: pass.event.flatFareCents, expiresAt: pass.expiresAt };

app.post('/api/events/:id/pass', auth, async (req, res) => {
  await events.list();
  const event = events.find(req.params.id);
  if (!event) return res.status(404).json({ error: 'That event is no longer listed. Pull to refresh.' });
  if (activeRideFor(req.user.id)) return res.status(400).json({ error: 'You already have a ride in progress. End it first.' });
  if (!req.user.cardUid) return res.status(400).json({ error: 'Link your card first (Wallet, Link a card), then tap it on any lock.' });
  const pass = { event: eventSnapshot(event), expiresAt: Date.now() + EVENT_PASS_MS };
  eventPasses.set(req.user.id, pass);
  res.json({ pass: passView(pass) });
});

app.delete('/api/events/pass', auth, (req, res) => {
  eventPasses.delete(req.user.id);
  res.json({ pass: null });
});

// ---------- Ask Pedal assistant ----------
const assistant = require('./assistant');

// Everything the assistant may talk about, as plain numbers. Built fresh per question.
function assistantContext(user) {
  const now = Date.now();
  const rides = data.rides.filter(r => r.riderId === user.id && r.status === 'done').sort((a, b) => b.endAt - a.endAt);
  const week = rides.filter(r => now - r.endAt < 7 * 24 * 3600 * 1000);
  const active = rideView(activeRideFor(user.id));
  const bikeName = (bikeId) => data.bikes.find(b => b.id === bikeId)?.name;
  return {
    rider: { name: user.name, gtid: user.gtid || null },
    balanceCents: balanceOf(user.id),
    activeRide: active && {
      bike: active.bikeName, bikeCode: active.bikeCode, lockedCentsPerMinute: active.perMinuteCents,
      minutesSoFar: Math.round((now - active.startAt) / 60000), costSoFarCents: active.liveCostCents,
      priceFactors: active.priceFactors || null
    },
    pricing: PRICING,
    weather: currentWeather(),
    bikes: data.bikes.filter(b => b.status !== 'offline').map(b => {
      const price = priceFor(b);
      return { code: b.code, name: b.name, kind: b.kind, color: b.color || null, status: b.status,
               centsPerMinute: price.centsPerMinute, factors: price.factors,
               openIssues: openIssues(b).map(i => i.summary) };
    }),
    spending: {
      last7DaysCents: week.reduce((s, r) => s + r.costCents, 0),
      last7DaysRides: week.length,
      allTimeCents: rides.reduce((s, r) => s + r.costCents, 0)
    },
    impact: { ...impactFor(user.id), note: 'Estimated: ride time x average speed, vs a car at about 250 g CO2/km (US EPA ~400 g/mile).' },
    lastRiddenBikeCode: rides[0] ? data.bikes.find(b => b.id === rides[0].bikeId)?.code : null,
    recentRides: rides.slice(0, 8).map(r => ({
      bike: bikeName(r.bikeId), endedAt: new Date(r.endAt).toISOString(), minutes: r.minutes,
      costCents: r.costCents, centsPerMinute: r.rateCentsPerMinute ?? null, co2SavedGrams: r.co2SavedGrams ?? null
    }))
  };
}

// Body: { messages: [{ role: "user" | "assistant", text }] }, last one from the user.
// Reply: { reply, action: null | { type: "topup", amountCents, label } | { type: "start_ride", bikeCode, label }, source }
app.post('/api/assistant', auth, async (req, res) => {
  const messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-12)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.trim().slice(0, 1000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Ask a question first.' });
  }
  res.json(await assistant.answer(messages, assistantContext(req.user)));
});

// ---------- device endpoints (Arduino R4) ----------
// All responses are plain text so the Arduino doesn't need a JSON library.

// Poll: GET /api/device/poll?lock=ID   header X-Device-Key
// Queued commands go out once. After that the lock is kept in step with the rides:
// it should be unlocked during a ride and locked otherwise, and until it reports that
// state (POST /api/device/event) every poll repeats the command. So a reply lost on a
// flaky connection, or a lock that restarts mid-ride, still ends up in the right state.
app.get('/api/device/poll', deviceAuth, (req, res) => {
  const idx = data.commands.findIndex(c => c.bikeId === req.bike.id);
  if (idx !== -1) {
    const [cmd] = data.commands.splice(idx, 1);
    save();
    return res.type('text').send(cmd.action);
  }
  const shouldBeLocked = !activeRideOnBike(req.bike.id);
  if (typeof req.bike.locked === 'boolean' && req.bike.locked !== shouldBeLocked) {
    return res.type('text').send(shouldBeLocked ? 'LOCK' : 'UNLOCK');
  }
  res.type('text').send('NONE');
});

// Card tap: POST /api/device/tap  body: lock=ID&uid=HEX
app.post('/api/device/tap', deviceAuth, (req, res) => {
  const bike = req.bike;
  const uid = String(req.body.uid || '').toUpperCase();
  if (!uid) return res.type('text').send('DENY:no_uid');

  // 1) Someone is linking a card right now
  const link = data.cardLinks.filter(l => l.expiresAt > Date.now()).sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (link) {
    data.users.forEach(u => { if (u.cardUid === uid) u.cardUid = null; });
    const user = data.users.find(u => u.id === link.userId);
    user.cardUid = uid;
    data.cardLinks = data.cardLinks.filter(l => l !== link);
    save();
    return res.type('text').send('LINKED');
  }

  // 2) Normal tap
  const user = data.users.find(u => u.cardUid === uid);
  if (!user) return res.type('text').send('DENY:unknown_card');

  const active = activeRideOnBike(bike.id);
  if (active) {
    if (active.riderId !== user.id) return res.type('text').send('DENY:in_use');
    // Rides end only in the app (after the bike photo check), never by a card tap.
    return res.type('text').send('DENY:end_in_app');
  }

  const result = startRide(user, bike, null, null, 'card');
  if (result.error) {
    const reason = result.error.startsWith('Add funds') ? 'low_balance'
      : result.error.includes('already') ? 'ride_active'
      : result.error.includes('in use') ? 'in_use' : 'unavailable';
    return res.type('text').send('DENY:' + reason);
  }
  const pass = activePass(user.id);
  if (pass) {   // armed from the Events tab: this ride gets the flat event fare
    result.ride.event = pass.event;
    eventPasses.delete(user.id);
  }
  data.commands = data.commands.filter(c => c.bikeId !== bike.id); // answered inline
  save();
  res.type('text').send('UNLOCK');
});

// Lock reports its physical state: POST /api/device/event  body: lock=ID&event=unlocked|locked
app.post('/api/device/event', deviceAuth, (req, res) => {
  const ev = String(req.body.event || '');
  if (ev === 'unlocked') req.bike.locked = false;
  if (ev === 'locked') req.bike.locked = true;
  save();
  res.type('text').send('OK');
});

// ---------- admin dashboard data ----------
app.get('/api/admin/overview', adminAuth, (req, res) => {
  const bikes = data.bikes.map(b => {
    const owner = data.users.find(u => u.id === b.ownerId);
    const active = activeRideOnBike(b.id);
    const rider = active && data.users.find(u => u.id === active.riderId);
    return {
      id: b.id, code: b.code, name: b.name, kind: b.kind, status: b.status, locked: b.locked,
      ownerName: owner?.name, riderName: rider?.name || null, rideStartedAt: active?.startAt || null,
      lastLat: b.lastLat, lastLng: b.lastLng, lastLocationAt: b.lastLocationAt,
      online: !!b.lastSeenAt && Date.now() - b.lastSeenAt < 15000, lastSeenAt: b.lastSeenAt,
      perMinuteCents: priceFor(b).centsPerMinute
    };
  });
  const done = data.rides.filter(r => r.status === 'done');
  res.json({
    stats: {
      users: data.users.length,
      bikes: data.bikes.length,
      activeRides: data.rides.filter(r => r.status === 'active').length,
      totalRides: done.length,
      grossCents: done.reduce((s, r) => s + r.costCents, 0),
      ownerPayoutCents: done.reduce((s, r) => s + r.ownerCents, 0),
      co2SavedGrams: done.reduce((s, r) => s + (r.co2SavedGrams || 0), 0)
    },
    bikes,
    rides: data.rides.slice().sort((a, b) => b.startAt - a.startAt).slice(0, 25).map(r => {
      const rider = data.users.find(u => u.id === r.riderId);
      return { ...rideView(r), riderName: rider?.name };
    })
  });
});

// ---------- pages ----------
// NFC tag URL. If an iPhone opens it in Safari instead of the app, point the rider back to the app.
// Apple fetches this from the published site to trust ride links for the app.
// Must be served over HTTPS at exactly this path, as JSON, with no redirect.
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.json({ applinks: { details: [{ appIDs: [IOS_APP_ID], components: [{ '/': '/ride/*', comment: 'Ride links' }] }] } });
});

// Ride link. With the app installed iOS never shows this page; it opens the app.
// Without it (or before the site is published) this page offers the pedal:// link.
app.get('/ride/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bike = findBikeByCode(code);
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pedal: bike ${code}</title>
<body style="font-family:system-ui;padding:32px;max-width:480px;margin:auto">
<h1>${bike ? bike.name : 'Bike ' + code}</h1>
<p>Code <b>${code}</b>${bike ? '' : ' (not found)'}</p>
<p><a href="pedal://ride/${code}" style="display:inline-block;padding:14px 22px;background:#16a34a;color:#fff;border-radius:12px;text-decoration:none;font-weight:600">Open in Pedal and start ride</a></p>
<p style="color:#666">No app? Open Pedal and enter code ${code}.</p>
</body>`);
});

app.get('/b/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:32px"><h1>Bike ${code}</h1><p>Open the Pedal app and enter code <b>${code}</b> to unlock.</p></body>`);
});
app.get(['/', '/dashboard'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

function seedDemoAccounts() {
  for (const a of DEMO_ACCOUNTS) {
    let user = data.users.find(u => u.email === a.email);
    if (!user) {
      const { hash, salt } = hashPassword(a.password);
      user = { id: id('usr'), name: a.name, email: a.email, passHash: hash, salt, cardUid: null, createdAt: Date.now() };
      data.users.push(user);
    }
    if (user.gtid && user.gtid !== a.gtid) user.gtid = a.gtid;   // GTID changed in config: update, keep balance
    if (!user.gtid) {
      user.gtid = a.gtid;
      // Top up (or down) to the example balance once, when the GTID is first set.
      const diff = a.balanceCents - balanceOf(user.id);
      if (diff) data.txns.push({ id: id('txn'), userId: user.id, amountCents: diff, type: 'topup', method: 'card', note: 'Demo balance', createdAt: Date.now() });
    }
    if (a.cardUid) {
      data.users.forEach(u => { if (u !== user && u.cardUid === a.cardUid) u.cardUid = null; });
      user.cardUid = a.cardUid;
    } else if (user.cardUid === DEMO_CARD_UID) {
      user.cardUid = null;   // the demo card moved to another account
    }
  }
  // The demo lock's bike belongs to the spare account, so rides by the phone
  // account (and its card) are charged like any rider's.
  for (const [code, color] of Object.entries(DEMO_BIKE_COLORS)) {
    const b = findBikeByCode(code);
    if (b && !b.color) b.color = color;
  }
  const bike = findBikeByCode(DEMO_BIKE_CODE);
  const owner = data.users.find(u => u.email === DEMO_BIKE_OWNER);
  if (bike && owner && bike.ownerId !== owner.id && !activeRideOnBike(bike.id)) bike.ownerId = owner.id;
  save();
}
seedDemoAccounts();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pedal API running on http://localhost:${PORT}  (health: /api/health)`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard?key=${ADMIN_KEY}`);
  console.log(`Ride links: ${SITE_URL}/ride/<BIKE_CODE>   (app link: pedal://ride/<BIKE_CODE>)`);
});
