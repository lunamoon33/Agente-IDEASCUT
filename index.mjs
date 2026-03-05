import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SuperDappAgent } = require('@superdapp/agents');
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || '';
const GROQ_API_KEY = process.env.Groq_IA || '';
const agent = new SuperDappAgent({ apiToken: API_TOKEN, baseUrl: 'https://api.superdapp.ai' });

const KEYWORDS = [
  // Problemas de negocio
  'we built', 'we launched', 'show hn', 'ask hn',
  // Frustraciones técnicas  
  'frustrated with', 'tired of', 'why is there no',
  'nobody solves', 'still no good solution',
  // Sectores emergentes
  'ai agent', 'automation', 'no code', 'web3',
  'remote work', 'creator economy', 'fintech',
  // Problemas clásicos sin resolver
  'document verification', 'fraud', 'compliance',
  'identity', 'privacy', 'data breach'
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
async function searchDevTo(keyword) {
  try {
    const r = await axios.get(
      'https://dev.to/api/articles?tag=' + encodeURIComponent(keyword) + '&per_page=30&top=1'
    );
    const hits = r.data;
    const example = hits[0]?.title || '';
    return { count: hits.length, example };
  } catch(e) {
    return { count: 0, example: '' };
  }
}
async function analyzeWithGemini(keyword, mentions, example) {
  if (!GROQ_API_KEY) return null;
  try {
    const prompt = 'Eres un analista de mercado. El tema "' + keyword + '" tiene ' + mentions + ' discusiones en Hacker News. ' +
      (example ? 'Ejemplo de discusion: "' + example + '". ' : '') +
      'En español, responde exactamente en este formato:\n' +
      'ANALISIS: (2 lineas explicando por que es una oportunidad real)\n' +
      'OPORTUNIDADES: (2 ideas de producto concretas, una por linea con guion)\n' +
      'PREGUNTA: (una pregunta corta para la comunidad)';

    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': 'Bearer ' + GROQ_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    return r.data.choices[0].message.content;
  } catch(e) {
    console.error('Groq error:', e.response?.data || e.message);
    return null;
  }
}

async function analyzePatterns() {
  console.log('Analizando patrones...');
  patternCount = {};
  topStories = {};

  for (const kw of KEYWORDS) {
    const hn = await searchHackerNews(kw);
    const devto = await searchDevTo(kw);
    const total = hn.count + devto.count;
    if (total >= 5) {
      patternCount[kw] = total;
      topStories[kw] = hn.example || devto.example;
    }
  }

  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  let report = 'IdeaScout Report ' + new Date().toLocaleString() + '\n\n';
  sorted.forEach(([kw,c],i) => {
    report += (i+1) + '. "' + kw + '" -> ' + c + ' discusiones\n';
  });
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