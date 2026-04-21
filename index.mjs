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
    const r = await axios.get(
      'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) +
      '&tags=story&hitsPerPage=30'
    );
    const hits = r.data.hits;
    const top = hits[0];
    const example = top?.title || '';
    const snippet = top?.story_text?.slice(0, 200) || '';
    const storyId = top?.objectID || '';
    return { count: hits.length, example, snippet, storyId };
  } catch(e) {
    return { count: 0, example: '', snippet: '', storyId: '' };
  }
}

async function searchDevTo(query) {
  try {
    const r = await axios.get(
      'https://dev.to/api/articles?tag=' + encodeURIComponent(query) + '&per_page=30&top=1'
    );
    const hits = r.data;
    const example = hits[0]?.title || '';
    return { count: hits.length, example };
  } catch(e) {
    return { count: 0, example: '' };
  }
}

async function getPostComments(storyId) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/items/' + storyId);
    const comments = r.data.children || [];
    return comments
      .slice(0, 5)
      .map(c => c.text?.replace(/<[^>]*>/g, '').slice(0, 150) || '')
      .filter(c => c.length > 20)
      .join(' | ');
  } catch(e) {
    return '';
  }
}

async function analyzeWithGroq(keyword, mentions, example, snippet, comments) {
  if (!GROQ_API_KEY) return null;
  try {
    const prompt = 'Eres un analista de oportunidades de mercado. Personas en comunidades tecnicas buscan: "' + keyword + '". ' +
      'Hay ' + mentions + ' discusiones. ' +
      (example ? 'Post ejemplo: "' + example + '". ' : '') +
      (comments ? 'Comentarios reales de la comunidad: "' + comments + '". ' : '') +
      'En español, sin markdown, sin listas con asteriscos, sin inventar nada.\n' +
      'Usa EXACTAMENTE este formato:\n\n' +
      '💬 Lo que dice la gente: [2 lineas resumiendo sus palabras reales]\n' +
      '😤 El dolor: [1 frase, la queja mas repetida]\n' +
      '💡 Alguien propuso: [si existe, la solucion que alguien mencionó. Si no existe, omite esta linea]\n' +
      '❓ [1 pregunta corta para la comunidad]';

    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 350
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
      topStories[kw] = {
        title: hn.example || devto.example,
        snippet: hn.snippet,
        storyId: hn.storyId
      };
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

async function joinGroup(groupId) {
  try {
    const r = await axios.post(
      'https://api.superdapp.ai/v1/agent-bots/groups/' + groupId + '/join',
      {},
      { headers: { 'Authorization': 'Bearer ' + API_TOKEN } }
    );
    console.log('Joined group:', r.data);
  } catch(e) {
    console.error('Join group error:', e.response?.data || e.message);
  }
}

agent.addCommand('/start', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId,
    'Soy IdeaScout. Detecto oportunidades reales de mercado analizando comunidades tecnicas.\n\n' +
    '/reporte - ver tendencias detectadas\n' +
    '/nicho - analisis inteligente de oportunidades\n' +
    '/industria [sector] - nichos de tu industria especifica\n' +
    '/profundizar - analisis profundo de un nicho\n' +
    '/hola - ver esta presentacion'
  );
});

agent.addCommand('/hola', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId,
    'Hola! Soy IdeaScout.\n\n' +
    'Detecto oportunidades reales de mercado analizando lo que la gente dice en comunidades tecnicas.\n\n' +
    'Comandos disponibles:\n' +
    '/reporte - ver tendencias detectadas ahora mismo\n' +
    '/nicho - analisis inteligente con comentarios reales\n' +
    '/industria [sector] - nichos personalizados de tu industria\n' +
    '/profundizar - elegir un nicho para analisis profundo\n'
  );
});

agent.addCommand('/help', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId,
    'Comandos disponibles:\n\n' +
    '/reporte - tendencias detectadas\n' +
    '/nicho - analisis con comentarios reales\n' +
    '/industria [sector] - nichos de tu industria\n' +
    '/profundizar - analisis profundo de un nicho\n' +
    '/hola - presentacion del agente'
  );
});

agent.addCommand('/industria', async ({ roomId, message }) => {
  const texto = message?.body?.m?.body || '';
  const industria = texto.replace('/industria', '').trim();

  if (!industria) {
    return await agent.sendConnectionMessage(roomId,
      'En que industria trabajas?\n\n' +
      'Ejemplos:\n' +
      '/industria contabilidad\n' +
      '/industria legal\n' +
      '/industria salud\n' +
      '/industria ecommerce\n' +
      '/industria tech\n\n' +
      'Te mandare nichos especificos de tu sector.'
    );
  }

  await agent.sendConnectionMessage(roomId, 'Buscando problemas reales en ' + industria + '...');

  const hn = await searchHackerNews(industria + ' problem frustrated');
  const devto = await searchDevTo(industria);
  const example = hn.example || devto.example || '';
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  const total = hn.count + devto.count;

  const analisis = await analyzeWithGroq(industria, total, example, hn.snippet, comments);

  let msg = 'Nichos detectados en: ' + industria + '\n';
  msg += 'Discusiones encontradas: ' + total + '\n';
  if (example) msg += 'Ejemplo: "' + example + '"\n';
  msg += '\n';
  msg += analisis || 'Industria con actividad detectada. Usa /profundizar para analisis completo.';

  await agent.sendConnectionMessage(roomId, msg);
});

agent.addCommand('/reporte', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Analizando comunidades tecnicas...');
  const report = await analyzePatterns();
  await agent.sendConnectionMessage(roomId, report);
});

agent.addCommand('/report', async ({ roomId }) => {
  await agent.sendConnectionMessage(roomId, 'Analizando comunidades tecnicas...');
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
    const comments = story.storyId ? await getPostComments(story.storyId) : '';
    const analisis = await analyzeWithGroq(kw, count, story.title, story.snippet, comments);

    let msg = 'Tendencia: ' + kw + '\n';
    msg += 'Discusiones: ' + count + '\n';
    if (story.title) msg += 'Ejemplo: "' + story.title + '"\n';
    msg += '\n';
    msg += analisis || 'Alta demanda detectada. Oportunidad sin solucion dominante.';
    msg += '\n\n---';
    await agent.sendConnectionMessage(roomId, msg);
  }
});

agent.addCommand('/profundizar', async ({ roomId, message }) => {
  const top = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  if (!top.length) return await agent.sendConnectionMessage(roomId, 'Usa /nicho primero.');

  const texto = message?.body?.m?.body || '';
  const numero = parseInt(texto.replace('/profundizar', '').trim()) - 1;

  if (isNaN(numero) || numero < 0 || numero >= top.length) {
    let lista = 'Elige que nicho profundizar:\n\n';
    top.forEach(([kw, c], i) => {
      lista += (i+1) + '. ' + kw + ' (' + c + ' discusiones)\n';
    });
    lista += '\nResponde: /profundizar 1, /profundizar 2, etc.';
    return await agent.sendConnectionMessage(roomId, lista);
  }

  const [kw] = top[numero];
  const story = topStories[kw] || {};
  const comments = story.storyId ? await getPostComments(story.storyId) : '';

  await agent.sendConnectionMessage(roomId, 'Analizando en profundidad: ' + kw + '...');

  const prompt = 'Eres un analista de mercado. El tema es "' + kw + '". ' +
    (story.title ? 'Post real: "' + story.title + '". ' : '') +
    (comments ? 'Comentarios: "' + comments + '". ' : '') +
    'En español, sin markdown, basandote SOLO en los comentarios reales:\n' +
    'RESUMEN DE QUEJAS: (lo que mas se repite en los comentarios)\n' +
    'SOLUCION MAS VOTADA: (si alguien propuso algo y otros estuvieron de acuerdo)\n' +
    'PERFIL DE QUIEN LO SUFRE: (segun los comentarios, quien es esta persona)\n' +
    'OPORTUNIDAD CONCRETA: (basada en lo que pidieron, no en suposiciones)\n' +
    'PREGUNTA PARA LA COMUNIDAD: (algo que invite a responder)';

  try {
    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400
      },
      {
        headers: {
          'Authorization': 'Bearer ' + GROQ_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    const analisis = r.data.choices[0].message.content;
    await agent.sendConnectionMessage(roomId, kw + '\n\n' + analisis);
  } catch(e) {
    console.error('Groq error:', e.response?.data || e.message);
    await agent.sendConnectionMessage(roomId, 'Error al analizar. Intenta de nuevo.');
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
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log('IdeaScout en puerto ' + PORT);
  await joinGroup(GROUP_ID);
  analyzePatterns();
});
      console.log('Joined! URL:', url, r.data);
      return;
    } catch(e) {
      console.log('Failed:', url, e.response?.status, e.response?.data?.errors?.message || e.message);
    }
  }
}
  analyzePatterns();
});
