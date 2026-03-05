import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WebhookAgent } = require('@superdapp/agents');
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || '';
const agent = new WebhookAgent({ token: API_TOKEN });

const KEYWORDS = [
  'document verification', 'fake document', 'fraud', 'audit', 'compliance',
  'certificate', 'authentication', 'digital trust', 'document fraud',
  'credential', 'verification failed'
];

let patternCount = {};
let lastReport = '';

async function searchHackerNews(keyword) {
  try {
    const r = await axios.get(
      'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(keyword) + '&tags=comment&hitsPerPage=50'
    );
    return r.data.hits.length;
  } catch (e) {
    return 0;
  }
}

async function analyzePatterns() {
  console.log('Analizando patrones...');
  patternCount = {};
  for (const kw of KEYWORDS) {
    const count = await searchHackerNews(kw);
    if (count >= 5) patternCount[kw] = count;
  }
  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  lastReport = 'IdeaScout Report ' + new Date().toLocaleString() + '\n\n';
  sorted.forEach(([kw,c],i) => { lastReport += (i+1) + '. ' + kw + ' -> ' + c + ' menciones\n'; });
  lastReport += '\nOportunidades reales de mercado.';
  console.log(lastReport);
  return lastReport;
}

agent.addCommand('/start', async ({ replyMessage }) => {
  await replyMessage('Soy IdeaScout. Detecto oportunidades en Hacker News.\n/reporte - ver analisis\n/nicho - explorar nichos');
});

agent.addCommand('/reporte', async ({ replyMessage }) => {
  await replyMessage('Analizando...');
  const report = await analyzePatterns();
  await replyMessage(report);
});

agent.addCommand('/nicho', async ({ replyMessage }) => {
  if (Object.keys(patternCount).length === 0) await analyzePatterns();
  const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  if (top.length === 0) return replyMessage('No hay patrones aun.');
  const text = top.map(([kw,c], i) => (i+1) + '. ' + kw + ' (' + c + ' menciones)').join('\n');
  await replyMessage('Nichos detectados:\n\n' + text);
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Recibido:', JSON.stringify(body, null, 2));

    if (body && body.challenge) return res.status(200).send(body.challenge);

    // Parsear el mensaje de SuperDapp
    let messageText = '';
    try {
      const bodyField = body.body;
      if (bodyField) {
        const parsed = JSON.parse(bodyField);
        const inner = parsed.m ? JSON.parse(decodeURIComponent(parsed.m)) : null;
        messageText = inner ? inner.body : '';
      }
    } catch(e) {
      console.log('Error parseando mensaje:', e.message);
    }

    console.log('Mensaje:', messageText);
    const roomId = body.roomId;

    if (messageText === '/start') {
      await agent.sendMessage(roomId, 'Soy IdeaScout. Detecto oportunidades en Hacker News.\n/reporte - ver analisis\n/nicho - explorar nichos');
    } else if (messageText === '/reporte') {
      await agent.sendMessage(roomId, 'Analizando...');
      const report = await analyzePatterns();
      await agent.sendMessage(roomId, report);
    } else if (messageText === '/nicho') {
      if (Object.keys(patternCount).length === 0) await analyzePatterns();
      const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
      if (top.length === 0) return await agent.sendMessage(roomId, 'No hay patrones aun.');
      const text = top.map(([kw,c], i) => (i+1) + '. ' + kw + ' (' + c + ' menciones)').join('\n');
      await agent.sendMessage(roomId, 'Nichos detectados:\n\n' + text);
    }

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