// One place for LLM calls, so each feature can say which model it prefers and the
// badge in the app shows what actually answered.
//
// Gemini (free tier): GEMINI_API_KEY in server/.env (aistudio.google.com/apikey),
//   optional GEMINI_MODEL.
// Meta Muse (hackathon credits, see #sponsor-meta): MUSE_API_KEY, MUSE_BASE_URL and
//   MUSE_MODEL in server/.env. Called as an OpenAI-style /chat/completions endpoint;
//   if Meta's Muse API turns out to be shaped differently, only askMuse changes.
//
// Events prefer Muse, Ask Pedal prefers Gemini; each falls back to the other.

const { GoogleGenAI } = require('@google/genai');

// Tried in order: a busy (503), rate-limited (429) or missing (404) model falls
// through to the next, so a free-tier demand spike doesn't take the feature down.
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash']
  .filter((m, i, all) => m && all.indexOf(m) === i);
const RETRYABLE = new Set([404, 429, 500, 503]);
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const muse = process.env.MUSE_API_KEY && process.env.MUSE_BASE_URL && process.env.MUSE_MODEL
  ? { key: process.env.MUSE_API_KEY, base: process.env.MUSE_BASE_URL.replace(/\/$/, ''), model: process.env.MUSE_MODEL }
  : null;

async function askGemini({ system, turns, schema, temperature }) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      const response = await gemini.models.generateContent({
        model,
        contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: schema, temperature }
      });
      return { value: JSON.parse(response.text || 'null'), provider: 'Gemini', model };
    } catch (err) {
      lastError = err;
      if (!RETRYABLE.has(err.status)) throw err;
    }
  }
  throw lastError;
}

async function askMuse({ system, turns, schema, temperature }) {
  const res = await fetch(`${muse.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${muse.key}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: muse.model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
        ...turns.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }))
      ]
    })
  });
  if (!res.ok) throw Object.assign(new Error(`Muse HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  return { value: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')), provider: 'Muse', model: muse.model };
}

const available = { gemini: () => !!gemini, muse: () => !!muse };
const call = { gemini: askGemini, muse: askMuse };

/** Is any model configured? */
const configured = () => !!(gemini || muse);

/**
 * JSON matching `schema` (a JSON Schema object) from the preferred model, else the other.
 * `messages`: [{ role: 'user' | 'assistant', text }], or `prompt` for a single turn.
 * Returns { value, provider: 'Gemini' | 'Muse', model }. Throws if none works.
 */
async function generateJSON({ system, messages, prompt, schema, temperature = 0.2, prefer = 'gemini' }) {
  const turns = messages || [{ role: 'user', text: prompt }];
  const order = [prefer, prefer === 'gemini' ? 'muse' : 'gemini'].filter(p => available[p]());
  if (!order.length) throw new Error('no LLM configured');
  let lastError;
  for (const name of order) {
    try {
      return await call[name]({ system, turns, schema, temperature });
    } catch (err) {
      lastError = err;
      console.warn(`LLM: ${name} failed (${err.status || ''} ${err.message.slice(0, 160)})`);
    }
  }
  throw lastError;
}

module.exports = { generateJSON, configured };
