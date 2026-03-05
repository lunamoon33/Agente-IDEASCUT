import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SuperDappAgent } = require('@superdapp/agents');
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const agent = new SuperDappAgent({ apiToken: API_TOKEN, baseUrl: 'https://api.superdapp.ai' });

const KEYWORDS = [
  'document verification', 'fake document', 'fraud', 'audit', 'compliance',
  'certificate', 'authentication', 'digital trust', 'document fraud',
  'credential', 'verification failed'
];

let patternCount = {};
let topStories = {};

async function searchHackerNews(keyword) {
  try {
    const r = await axios.get(
      'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(keyword) + '&tags=story&hitsPerPage=100'
    );
    const hits = r.data.hits;
    const example = hits[0]?.title || '';
    return { count: hits.length, example };
  } catch(e) {
    return { count: 0, example: '' };
  }
}

async function analyzeWithGemini(keyword, mentions, example) {
  if (!GEMINI_API_KEY) return null;
  try {
    const prompt = 'Eres un analista de mercado. El tema "' + keyword + '" tiene ' + mentions + ' discusiones en Hacker News. ' +
      (example ? 'Ejemplo de discusion: "' + example + '". ' : '') +
      'En español, responde exactamente en este formato:\n' +
      'ANALISIS: (2 lineas explicando por que es una oportunidad real)\n' +
      'OPORTUNIDADES: (2 ideas de producto concretas, una por linea con guion)\n' +
      'PREGUNTA: (una pregunta corta para la comunidad)';

    const r = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    return r.data.candidates[0].content.parts[0].text;
  } catch(e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}

async function analyzePatterns() {
  console.log('Analizando patrones...');
  patternCount = {};
  topStories = {};
  for (const kw of KEYWORDS) {
    const { count, example } = await searchHackerNews(kw);
    if (count >= 5) {
      patternCount[kw] = count;
      topStories[kw] = example;
    }
  }
  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  let report = 'IdeaScout Report ' + new Date().toLocaleString() + '\n\n';
  sorted.forEach(([kw,c],i) => { report += (i+1) + '. "' + kw + '" -> ' + c + ' discusiones\n'; });
  report += '\nUsa /nicho para analisis inteligente de cada oportunidad.';
  console.log(report);
  return report;
}

agent.addCommand('/start', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 
    'Soy IdeaScout. Detecto oportunidades reales de mercado analizando Hacker News.\n\n' +
    '/reporte - ver nichos detectados\n' +
    '/nicho - analisis inteligente de oportunidades'
  );
});

agent.addCommand('/reporte', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Analizando patrones en Hacker News...');
  const report = await analyzePatterns();
  await agent.sendConnectionMessage(roomId, report);
});

agent.addCommand('/nicho', async ({ roomId }) => {
  if (Object.keys(patternCount).length === 0) await analyzePatterns();
  const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,3);
  if (top.length === 0) return await agent.sendConnectionMessage(roomId, 'No hay patrones aun. Usa /reporte primero.');

  await agent.sendConnectionMessage(roomId, 'Generando analisis inteligente...');

  for (const [kw, count] of top) {
    const example = topStories[kw] || '';
    const gemini = await analyzeWithGemini(kw, count, example);

    let msg = '🔍 Nicho: ' + kw + '\n';
    msg += '📊 Discusiones: ' + count + '\n';
    if (example) msg += '💬 Ejemplo: "' + example + '"\n';
    msg += '\n';

    if (gemini) {
      msg += gemini;
    } else {
      msg += 'Alta demanda detectada en comunidades tecnicas. Oportunidad sin solucion dominante.';
    }

    msg += '\n\n---';
    await agent.sendConnectionMessage(roomId, msg);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    let body = req.body;
    if (body && body.challenge) return res.status(200).send(body.challenge);

    if (body && body.body && typeof body.body === 'string') {
      try {
        const parsed = JSON.parse(body.body);
        if (parsed.m && typeof parsed.m === 'string') {
          const inner = JSON.parse(decodeURIComponent(parsed.m));
          body = { ...body, body: { m: inner } };
        }
      } catch(e) {}
    }

    console.log('Mensaje:', body?.body?.m?.body);
    await agent.webhookAgent.processRequest(body);
    res.status(200).send('OK');
  } catch (e) {
    console.error('Error webhook:', e.message);
    res.status(200).send('OK');
  }
});

app.get('/', (req, res) => res.json({ status: 'IdeaScout corriendo', patterns: patternCount }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

cron.schedule('0 */6 * * *', analyzePatterns);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('IdeaScout en puerto ' + PORT);
  analyzePatterns();
});