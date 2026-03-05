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

const SEARCH_QUERIES = [
  'ask hn who wants',
  'ask hn is there a tool',
  'ask hn why is there no',
  'ask hn looking for',
  'frustrated no solution',
  'why doesnt exist',
  'built this because',
  'nobody has solved'
];

async function searchHackerNews(query) {
  try {
    const r = await axios.get(
      'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) +
      '&tags=story&hitsPerPage=30'
    );
    const hits = r.data.hits;
    const example = hits[0]?.title || '';
    const snippet = hits[0]?.story_text?.slice(0, 200) || '';
    return { count: hits.length, example, snippet };
  } catch(e) {
    return { count: 0, example: '', snippet: '' };
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
async function analyzeWithGemini(keyword, mentions, example, snippet) {
  if (!GROQ_API_KEY) return null;
  try {
    const prompt = 'Eres un analista de oportunidades de mercado. Personas en comunidades técnicas están buscando: "' + keyword + '". ' +
      'Hay ' + mentions + ' discusiones sobre esto. ' +
      (example ? 'Titulo ejemplo: "' + example + '". ' : '') +
      (snippet ? 'Contexto: "' + snippet + '". ' : '') +
      'En español, responde en este formato exacto:\n' +
      'PROBLEMA REAL: (1 linea describiendo el dolor especifico que tienen)\n' +
      'QUIEN LO SUFRE: (tipo de persona o empresa afectada)\n' +
      'OPORTUNIDADES:\n- (idea 1)\n- (idea 2)\n' +
      'PREGUNTA: (una pregunta para la comunidad)';

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

  for (const kw of SEARCH_QUERIES) {
    const hn = await searchHackerNews(kw);
    const devto = await searchDevTo(kw);
    const total = hn.count + devto.count;
    if (total >= 3) {
      patternCount[kw] = total;
      topStories[kw] = { title: hn.example || devto.example, snippet: hn.snippet };
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
    const story = topStories[kw] || {};
    const gemini = await analyzeWithGemini(kw, count, story.title, story.snippet);

    let msg = '🔍 Tendencia: ' + kw + '\n';
    msg += '📊 Discusiones: ' + count + '\n';
    if (story.title) msg += '💬 Ejemplo: "' + story.title + '"\n';
    msg += '\n';
    msg += gemini || 'Alta demanda detectada. Oportunidad sin solución dominante.';
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