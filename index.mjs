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
const GROUP_ID = 'ddcfc5f0-9436-4549-aa9b-937f1845d223';
const agent = new SuperDappAgent({ apiToken: API_TOKEN, baseUrl: 'https://api.superdapp.ai' });

const SEARCH_QUERIES = [
  'accountants frustrated software',
  'lawyers need tool automate',
  'doctors tired paperwork',
  'small business owner problem',
  'freelancer invoice pain',
  'startup compliance nightmare',
  'ecommerce fraud detection gap',
  'hr manager automate hiring'
];

let patternCount = {};
let topStories = {};

async function searchHackerNews(query) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) + '&tags=story&hitsPerPage=30');
    const hits = r.data.hits;
    const top = hits[0];
    return { count: hits.length, example: top?.title || '', snippet: top?.story_text?.slice(0, 200) || '', storyId: top?.objectID || '' };
  } catch(e) { return { count: 0, example: '', snippet: '', storyId: '' }; }
}

async function searchDevTo(query) {
  try {
    const r = await axios.get('https://dev.to/api/articles?tag=' + encodeURIComponent(query) + '&per_page=30&top=1');
    return { count: r.data.length, example: r.data[0]?.title || '' };
  } catch(e) { return { count: 0, example: '' }; }
}

async function getPostComments(storyId) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/items/' + storyId);
    return (r.data.children || []).slice(0, 5).map(c => c.text?.replace(/<[^>]*>/g, '').slice(0, 150) || '').filter(c => c.length > 20).join(' | ');
  } catch(e) { return ''; }
}

async function analyzeWithGroq(keyword, mentions, example, snippet, comments) {
  if (!GROQ_API_KEY) return null;
  try {
    const prompt = 'Eres un analista de oportunidades de mercado. Personas en comunidades tecnicas buscan: "' + keyword + '". Hay ' + mentions + ' discusiones. ' +
      (example ? 'Post ejemplo: "' + example + '". ' : '') +
      (comments ? 'Comentarios reales: "' + comments + '". ' : '') +
      'En español, sin markdown, sin inventar nada.\nUsa EXACTAMENTE este formato:\n\n' +
      '💬 Lo que dice la gente: [2 lineas resumiendo sus palabras reales]\n' +
      '😤 El dolor: [1 frase, la queja mas repetida]\n' +
      '💡 Alguien propuso: [si existe, omite si no]\n' +
      '❓ [1 pregunta corta para la comunidad]';
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 350 },
      { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
    );
    return r.data.choices[0].message.content;
  } catch(e) { console.error('Groq error:', e.response?.data || e.message); return null; }
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
      topStories[kw] = { title: hn.example || devto.example, snippet: hn.snippet, storyId: hn.storyId };
    }
  }
  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  let report = 'IdeaScout Report ' + new Date().toLocaleString() + '\n\n';
  sorted.forEach(([kw,c],i) => { report += (i+1) + '. "' + kw + '" -> ' + c + ' discusiones\n'; });
  report += '\nUsa /nicho para analisis inteligente de cada oportunidad.';
  console.log(report);
  return report;
}

async function joinGroup(groupId) {
  const endpoints = [
    'https://api.superdapp.ai/v1/agent-bots/social-groups/' + groupId + '/join',
    'https://api.superdapp.ai/v1/social-groups/' + groupId + '/join',
    'https://api.superdapp.ai/v1/groups/' + groupId + '/join',
    'https://api.superdapp.ai/v1/agent-bots/channels/' + groupId + '/join',
  ];
  for (const url of endpoints) {
    try {
      const r = await axios.post(url, {}, { headers: { 'Authorization': 'Bearer ' + API_TOKEN } });
      console.log('Joined! URL:', url);
      return;
    } catch(e) { console.log('Failed:', url, e.response?.status); }
  }
}

// Comandos privados
agent.addCommand('/start', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Soy IdeaScout. Detecto oportunidades reales de mercado.\n\n/reporte - tendencias\n/nicho - analisis inteligente\n/industria [sector] - nichos de tu industria\n/profundizar - analisis profundo\n/hola - presentacion');
});

agent.addCommand('/hola', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Hola! Soy IdeaScout.\n\nDetecto oportunidades reales de mercado analizando comunidades tecnicas.\n\n/reporte - ver tendencias\n/nicho - analisis con comentarios reales\n/industria [sector] - nichos de tu industria\n/profundizar - analisis profundo');
});

agent.addCommand('/help', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, '/reporte - tendencias\n/nicho - analisis\n/industria [sector] - nichos\n/profundizar - profundo\n/hola - presentacion');
});

agent.addCommand('/reporte', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Analizando...');
  const report = await analyzePatterns();
  await agent.sendConnectionMessage(roomId, report);
});

agent.addCommand('/report', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Analizando...');
  const report = await analyzePatterns();
  await agent.sendConnectionMessage(roomId, report);
});

agent.addCommand('/nicho', async ({ roomId }) => {
  if (Object.keys(patternCount).length === 0) await analyzePatterns();
  const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,3);
  if (top.length === 0) return await agent.sendConnectionMessage(roomId, 'No hay patrones. Usa /reporte primero.');
  await agent.sendConnectionMessage(roomId, 'Generando analisis...');
  for (const [kw, count] of top) {
    const story = topStories[kw] || {};
    const comments = story.storyId ? await getPostComments(story.storyId) : '';
    const analisis = await analyzeWithGroq(kw, count, story.title, story.snippet, comments);
    let msg = 'Tendencia: ' + kw + '\nDiscusiones: ' + count + '\n';
    if (story.title) msg += 'Ejemplo: "' + story.title + '"\n';
    msg += '\n' + (analisis || 'Alta demanda detectada.') + '\n\n---';
    await agent.sendConnectionMessage(roomId, msg);
  }
});

agent.addCommand('/industria', async ({ roomId, message }) => {
  const texto = message?.body?.m?.body || '';
  const industria = texto.replace('/industria', '').trim();
  if (!industria) return await agent.sendConnectionMessage(roomId, 'Escribe: /industria [sector]\nEj: /industria contabilidad');
  await agent.sendConnectionMessage(roomId, 'Buscando en ' + industria + '...');
  const hn = await searchHackerNews(industria + ' problem frustrated');
  const devto = await searchDevTo(industria);
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  const total = hn.count + devto.count;
  const analisis = await analyzeWithGroq(industria, total, hn.example || devto.example, hn.snippet, comments);
  let msg = 'Nichos en: ' + industria + ' (' + total + ' discusiones)\n\n';
  msg += analisis || 'Actividad detectada.';
  await agent.sendConnectionMessage(roomId, msg);
});

agent.addCommand('/profundizar', async ({ roomId, message }) => {
  const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  if (!top.length) return await agent.sendConnectionMessage(roomId, 'Usa /nicho primero.');
  const texto = message?.body?.m?.body || '';
  const numero = parseInt(texto.replace('/profundizar', '').trim()) - 1;
  if (isNaN(numero) || numero < 0 || numero >= top.length) {
    let lista = 'Elige nicho:\n\n';
    top.forEach(([kw, c], i) => { lista += (i+1) + '. ' + kw + ' (' + c + ')\n'; });
    lista += '\nEscribe: /profundizar 1';
    return await agent.sendConnectionMessage(roomId, lista);
  }
  const [kw] = top[numero];
  const story = topStories[kw] || {};
  const comments = story.storyId ? await getPostComments(story.storyId) : '';
  await agent.sendConnectionMessage(roomId, 'Analizando: ' + kw + '...');
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'Analiza en español sin markdown: "' + kw + '". Post: "' + (story.title||'') + '". Comentarios: "' + comments + '". Formato: RESUMEN QUEJAS / SOLUCION VOTADA / PERFIL / OPORTUNIDAD / PREGUNTA' }], max_tokens: 400 },
      { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
    );
    await agent.sendConnectionMessage(roomId, kw + '\n\n' + r.data.choices[0].message.content);
  } catch(e) { await agent.sendConnectionMessage(roomId, 'Error. Intenta de nuevo.'); }
});

// Webhook
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
    const msgText = body?.body?.m?.body || '';
    const roomId = body?.roomId || '';
    const isGroupMessage = roomId === GROUP_ID;
    console.log('msg:', msgText, '| isGroup:', isGroupMessage);

    if (isGroupMessage) {
      if (!msgText.startsWith('/')) return res.status(200).send('OK');
      if (msgText === '/hola' || msgText === '/start') {
        await agent.sendChannelMessage(GROUP_ID, 'Hola! Soy IdeaScout.\n\nDetecto oportunidades reales de mercado.\n\n/reporte - tendencias\n/nicho - analisis inteligente\n/industria [sector] - nichos de tu industria\n/profundizar - analisis profundo');
      } else if (msgText === '/reporte' || msgText === '/report') {
        await agent.sendChannelMessage(GROUP_ID, 'Analizando...');
        const report = await analyzePatterns();
        await agent.sendChannelMessage(GROUP_ID, report);
      } else if (msgText === '/nicho') {
        if (Object.keys(patternCount).length === 0) await analyzePatterns();
        const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,3);
        for (const [kw, count] of top) {
          const story = topStories[kw] || {};
          const comments = story.storyId ? await getPostComments(story.storyId) : '';
          const analisis = await analyzeWithGroq(kw, count, story.title, story.snippet, comments);
          let msg = 'Tendencia: ' + kw + '\nDiscusiones: ' + count + '\n';
          if (story.title) msg += 'Ejemplo: "' + story.title + '"\n\n';
          msg += analisis || 'Alta demanda detectada.';
          await agent.sendChannelMessage(GROUP_ID, msg);
        }
      } else if (msgText.startsWith('/industria')) {
        const industria = msgText.replace('/industria', '').trim();
        if (!industria) {
          await agent.sendChannelMessage(GROUP_ID, 'Escribe: /industria [sector]\nEj: /industria contabilidad');
        } else {
          await agent.sendChannelMessage(GROUP_ID, 'Buscando en ' + industria + '...');
          const hn = await searchHackerNews(industria + ' problem frustrated');
          const devto = await searchDevTo(industria);
          const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
          const total = hn.count + devto.count;
          const analisis = await analyzeWithGroq(industria, total, hn.example, hn.snippet, comments);
          await agent.sendChannelMessage(GROUP_ID, 'Nichos en: ' + industria + ' (' + total + ' discusiones)\n\n' + (analisis || 'Actividad detectada.'));
        }
      } else if (msgText.startsWith('/profundizar')) {
        const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
        if (!top.length) return await agent.sendChannelMessage(GROUP_ID, 'Usa /nicho primero.');
        const numero = parseInt(msgText.replace('/profundizar', '').trim()) - 1;
        if (isNaN(numero) || numero < 0) {
          let lista = 'Elige nicho:\n\n';
          top.forEach(([kw, c], i) => { lista += (i+1) + '. ' + kw + '\n'; });
          lista += '\nEscribe: /profundizar 1';
          await agent.sendChannelMessage(GROUP_ID, lista);
        } else {
          const [kw] = top[numero];
          const story = topStories[kw] || {};
          const comments = story.storyId ? await getPostComments(story.storyId) : '';
          await agent.sendChannelMessage(GROUP_ID, 'Analizando: ' + kw + '...');
          try {
            const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
              { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'Analiza en español sin markdown: "' + kw + '". Post: "' + (story.title||'') + '". Comentarios: "' + comments + '". Formato: RESUMEN QUEJAS / SOLUCION VOTADA / PERFIL / OPORTUNIDAD / PREGUNTA' }], max_tokens: 400 },
              { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
            );
            await agent.sendChannelMessage(GROUP_ID, r.data.choices[0].message.content);
          } catch(e) { await agent.sendChannelMessage(GROUP_ID, 'Error. Intenta de nuevo.'); }
        }
      }
    } else {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
await agent.processRequest(bodyStr);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('Error webhook:', e.response?.data || e.message);
  res.status(200).json({ success: true });
  }
});

app.get('/', (req, res) => res.json({ status: 'IdeaScout corriendo', patterns: patternCount }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

cron.schedule('0 */6 * * *', analyzePatterns);

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log('IdeaScout en puerto ' + PORT);
  await joinGroup(GROUP_ID);
  analyzePatterns();
});
