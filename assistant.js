// Ask Pedal: a chat assistant for fares, balance, spending and CO2.
//
// The server hands the model the rider's real numbers; the model only explains
// them and may *propose* an action (top up, start a ride). The app shows the
// proposal as a button and nothing happens until the rider taps it.
//
// The model comes from llm.js (Gemini free tier today). Without a key, or if the
// model fails, a small built-in responder answers instead.

const llm = require('./llm');

const SYSTEM = `You are Ask Pedal, the assistant inside Pedal, a student bike-share app at Georgia Tech.
Answer the rider's question using only the JSON context you are given: their balance, rides, spending,
CO2 savings, the pricing rules, and the live price of each bike with the reasons it is that price.

Rules:
- Never invent or recalculate numbers. Quote the context. Money is in cents in the context; say dollars ($1.20) or cents per minute (12¢/min).
- Pricing is dynamic: no unlock fee, a base rate adjusted for bikes nearby, time of day and weather, always between the min and max rate, billed by the second, with a minimum fare. The rate is locked when the ride starts.
- To add money, propose action "topup" with amountCents between 100 and 10000. To start a ride, propose "start_ride" with the bike's code. Otherwise use "none".
- If the rider describes a problem with a bike (flat tire, brakes, chain, lock, damage), be kind, give one short safety tip if it matters, and propose "report_issue" with the bike's code (their current ride, else lastRiddenBikeCode) and a one-sentence summary for the owner. Set unsafe true for brakes, steering or anything that makes riding dangerous.
- A proposed action has NOT happened yet. Say "tap the button to confirm", never "done".
- Keep replies short: two or three sentences, plain text, no markdown.
- If the question isn't about Pedal, rides, payments or the rider's impact, say briefly what you can help with.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What to say to the rider.' },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['none', 'topup', 'start_ride', 'report_issue'] },
        amountCents: { type: 'integer', description: 'For topup: 100 to 10000.' },
        bikeCode: { type: 'string', description: 'For start_ride or report_issue: the bike code, e.g. NM69B2.' },
        summary: { type: 'string', description: 'For report_issue: one sentence for the owner.' },
        unsafe: { type: 'boolean', description: 'For report_issue: riding it is dangerous.' }
      },
      required: ['type']
    }
  },
  required: ['reply', 'action']
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const co2 = (grams) => grams >= 1000 ? `${(grams / 1000).toFixed(1)} kg` : `${grams} g`;

/** Only actions the server can actually carry out reach the app. */
function cleanAction(action, context) {
  if (!action || action.type === 'none') return null;
  if (action.type === 'topup') {
    const amountCents = Math.round(Number(action.amountCents));
    if (!(amountCents >= 100 && amountCents <= 10000)) return null;
    return { type: 'topup', amountCents, label: `Add ${money(amountCents)} from BuzzCard funds` };
  }
  if (action.type === 'start_ride') {
    const code = String(action.bikeCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const bike = context.bikes.find(b => b.code === code && b.status === 'available');
    if (!bike || context.activeRide) return null;
    return { type: 'start_ride', bikeCode: code, label: `Start ride on ${bike.name} (${bike.centsPerMinute}¢/min)` };
  }
  if (action.type === 'report_issue') {
    const code = String(action.bikeCode || context.activeRide?.bikeCode || context.lastRiddenBikeCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const bike = context.bikes.find(b => b.code === code);
    const summary = String(action.summary || '').trim().slice(0, 300);
    if (!bike || !summary) return null;
    return { type: 'report_issue', bikeCode: code, summary, unsafe: !!action.unsafe, label: `Send to ${bike.name}'s owner` };
  }
  return null;
}

async function askModel(history, context) {
  // The context rides along with the latest question so it's always current.
  const messages = history.map((m, i) => i === history.length - 1
    ? { ...m, text: `Context (JSON):\n${JSON.stringify(context)}\n\nRider's question: ${m.text}` }
    : m);
  const result = await llm.generateJSON({ system: SYSTEM, messages, schema: RESPONSE_SCHEMA, prefer: 'gemini' });
  const parsed = result.value || {};
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw new Error('empty reply');
  return { reply: parsed.reply.trim(), action: cleanAction(parsed.action, context), poweredBy: result.provider };
}

/** Keyword answers from the same context, for when there's no key or Gemini is down. */
function builtIn(question, context) {
  const q = question.toLowerCase();
  const amount = q.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);

  if (/top ?up|add (money|funds|\$)|reload/.test(q)) {
    const cents = amount ? Math.round(Number(amount[1]) * 100) : 500;
    const action = cleanAction({ type: 'topup', amountCents: cents }, context);
    return action
      ? { reply: `I can add ${money(cents)} to your wallet. Tap the button to confirm.`, action }
      : { reply: 'Top-ups can be between $1 and $100.', action: null };
  }
  if (/flat|brake|broken|chain|damag|wobbl|squeak|won'?t (lock|unlock)|problem|issue|seat/.test(q)) {
    const code = context.activeRide?.bikeCode || context.lastRiddenBikeCode;
    const unsafe = /brake|steer/.test(q);
    const action = cleanAction({ type: 'report_issue', bikeCode: code, summary: question.slice(0, 300), unsafe }, context);
    return action
      ? { reply: `Sorry about that. I can pass this to the owner so it gets fixed before the next ride.${unsafe ? " Please don't ride it if the brakes feel off." : ''} Tap the button to send it.`, action }
      : { reply: "Sorry about that. Which bike was it? Tell me the code on the lock and I'll let the owner know.", action: null };
  }
  if (/co2|carbon|emission|impact|environment|planet/.test(q)) {
    const i = context.impact;
    return { reply: i.rides
      ? `Across ${i.rides} ride${i.rides === 1 ? '' : 's'} (about ${i.distanceKm} km) you've saved roughly ${co2(i.co2SavedGrams)} of CO2 compared with driving.`
      : 'Finish a ride and I\'ll show how much CO2 you saved compared with driving.', action: null };
  }
  if (/spen|week|month|history|cost me/.test(q)) {
    return { reply: `You've spent ${money(context.spending.last7DaysCents)} in the last 7 days over ${context.spending.last7DaysRides} ride${context.spending.last7DaysRides === 1 ? '' : 's'}. Your balance is ${money(context.balanceCents)}.`, action: null };
  }
  if (/balance|how much (do i|money)|wallet/.test(q)) {
    return { reply: `Your balance is ${money(context.balanceCents)}.`, action: null };
  }
  if (/price|rate|cost|expensive|cheap|why|how much/.test(q)) {
    const bike = context.bikes.find(b => q.includes(b.code.toLowerCase())) || context.bikes.find(b => b.status === 'available') || context.bikes[0];
    if (!bike) return { reply: 'There are no bikes listed right now.', action: null };
    const why = bike.factors.map(f => `${f.label} (×${f.multiplier})`).join(', ');
    return { reply: `${bike.name} is ${bike.centsPerMinute}¢/min right now: base ${context.pricing.baseCentsPerMinute}¢ adjusted for ${why}. There's no unlock fee, you're billed by the second, and the minimum fare is ${money(context.pricing.minFareCents)}.`, action: null };
  }
  const start = context.bikes.find(b => q.includes(b.code.toLowerCase()));
  if (start && /start|ride|unlock/.test(q)) {
    const action = cleanAction({ type: 'start_ride', bikeCode: start.code }, context);
    if (action) return { reply: `${start.name} is ${start.centsPerMinute}¢/min. Tap the button to start the ride.`, action };
  }
  return { reply: 'I can explain bike prices, check your balance and spending, show your CO2 savings, add money, or start a ride. What do you need?', action: null };
}

async function answer(history, context) {
  const question = history[history.length - 1].text;
  if (llm.configured()) {
    try {
      const result = await askModel(history, context);
      return { ...result, source: result.poweredBy.toLowerCase() };
    } catch (err) {
      console.warn(`Ask Pedal: no model answered (${err.message.slice(0, 120)}), using built-in answers`);
    }
  }
  return { ...builtIn(question, context), source: 'built-in', poweredBy: null };
}

module.exports = { answer };
