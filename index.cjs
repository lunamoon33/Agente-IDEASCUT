require('dotenv').config();
const { SuperDappAgent } = require('@superdapp/agents');
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const API_TOKEN    = process.env.API_TOKEN    || '';
const GROQ_API_KEY = process.env.Groq_IA      || '';
const GROUP_ID     = process.env.GROUP_ID     || 'ddcfc5f0-9436-4549-aa9b-937f1845d223';

const agent = API_TOKEN
  ? new SuperDappAgent({ apiToken: API_TOKEN, baseUrl: 'https://api.superdapp.ai' })
  : null;

if (agent) {
  Object.getPrototypeOf(agent).getRoomId = function(message) {
    const rm = message.rawMessage;
    if (rm?.senderId && rm?.memberId) return `${rm.memberId}-${rm.senderId}`;
    if (rm?.roomId)    return rm.roomId;
    if (rm?.channelId) return rm.channelId;
    if (rm?.memberId)  return rm.memberId;
    return '';
  };

async function sendMsg(roomId, text, isChannel = false) {
  if (!agent) return;
  if (isChannel) return agent.sendChannelMessage(roomId, text);
  return agent.sendConnectionMessage(roomId, text);
}

// ── Sesiones ──────────────────────────────────────────────────────────────────
const userSessions = new Map();
function getSession(roomId) {
  if (!userSessions.has(roomId)) {
    userSessions.set(roomId, { lang: 'es', industry: null, waitingFor: null });
  }
  return userSessions.get(roomId);
}

// ── Registro silencioso de interés ────────────────────────────────────────────
const nicheInterest = new Map();
function registerInterest(roomId, niche) {
  const key = niche.toLowerCase().trim();
  if (!nicheInterest.has(key)) nicheInterest.set(key, new Set());
  nicheInterest.get(key).add(roomId);
}
function getInterestCount(niche) {
  const key = niche.toLowerCase().trim();
  return nicheInterest.has(key) ? nicheInterest.get(key).size : 0;
}

// ── Datos ─────────────────────────────────────────────────────────────────────
let patternCount = {};
let topStories   = {};

const SEARCH_QUERIES = [
  'accountants frustrated software', 'lawyers need tool automate',
  'doctors tired paperwork', 'small business owner problem',
  'freelancer invoice pain', 'startup compliance nightmare',
  'ecommerce fraud detection gap', 'hr manager automate hiring',
  'teachers overwhelmed admin', 'engineers manual process pain'
];

async function searchHackerNews(query) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) + '&tags=story&hitsPerPage=30');
    const hits = r.data.hits; const top = hits[0];
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

async function analyzeWithGroq(keyword, mentions, example, snippet, comments, lang) {
  if (!GROQ_API_KEY) return null;
  const isEs = lang !== 'en';
  try {
    const prompt = isEs
      ? 'Analista de oportunidades. Personas buscan solución a: "' + keyword + '". ' + mentions + ' discusiones. ' +
        (example ? 'Post: "' + example + '". ' : '') + (comments ? 'Comentarios: "' + comments + '". ' : '') +
        'Responde en español sin markdown:\n💬 Lo que dice la gente: [2 líneas]\n😤 El dolor principal: [1 frase]\n💡 Oportunidad: [1 frase]\n❓ [1 pregunta de validación]'
      : 'Market analyst. People seek solution to: "' + keyword + '". ' + mentions + ' discussions. ' +
        (example ? 'Post: "' + example + '". ' : '') + (comments ? 'Comments: "' + comments + '". ' : '') +
        'Answer in English without markdown:\n💬 What people say: [2 lines]\n😤 Main pain: [1 sentence]\n💡 Opportunity: [1 sentence]\n❓ [1 validation question]';
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 350 },
      { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
    );
    return r.data.choices[0].message.content;
  } catch(e) { return null; }
}

async function validateIdea(idea, lang, industry) {
  if (!GROQ_API_KEY) return null;
  const isEs = lang !== 'en';
  const hn    = await searchHackerNews(idea + ' problem pain');
  const devto = await searchDevTo(idea);
  const total = hn.count + devto.count;
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  try {
    const prompt = isEs
      ? 'Valida si existe demanda para: "' + idea + '"' + (industry ? ' (industria: ' + industry + ')' : '') +
        '. Encontré ' + total + ' discusiones.' + (hn.example ? ' Ejemplo: "' + hn.example + '".' : '') +
        (comments ? ' Comentarios: "' + comments + '".' : '') +
        '\nSin markdown:\n✅ o ❌ Veredicto: [existe o no el problema]\n📊 Evidencia: [qué encontré]\n🎯 Oportunidad: [cómo monetizar si existe]\n⚠️ Riesgo: [qué podría fallar]'
      : 'Validate demand for: "' + idea + '"' + (industry ? ' (industry: ' + industry + ')' : '') +
        '. Found ' + total + ' discussions.' + (hn.example ? ' Example: "' + hn.example + '".' : '') +
        '\nNo markdown:\n✅ or ❌ Verdict: [problem exists or not]\n📊 Evidence: [what I found]\n🎯 Opportunity: [how to monetize]\n⚠️ Risk: [what could fail]';
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 500 },
      { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
    );
    return { analysis: r.data.choices[0].message.content, count: total, niche: idea };
  } catch(e) { return null; }
}

async function analyzePatterns() {
  patternCount = {}; topStories = {};
  for (const kw of SEARCH_QUERIES) {
    const hn = await searchHackerNews(kw); const devto = await searchDevTo(kw);
    const total = hn.count + devto.count;
    if (total >= 3) { patternCount[kw] = total; topStories[kw] = { title: hn.example || devto.example, snippet: hn.snippet, storyId: hn.storyId }; }
  }
}

// ── Textos i18n ───────────────────────────────────────────────────────────────
const T = {
  es: {
    welcome:     '👋 Soy **IdeaScout**\n\nTe ayudo a:\n✅ **Validar** si tu idea tiene mercado real\n🔭 **Explorar** qué problemas reales hay en tu industria\n\n¿Qué hacemos?',
    askIndustry: '¿A qué industria perteneces o en qué área trabajas?\n\nEj: contabilidad, salud, educación, tecnología...\n_(No necesitas tener profesión específica)_',
    askIdea:     '¿Cuál es tu idea o el problema que quieres resolver?\n\nEscríbela brevemente. Ej: _"app para contadores sin errores en facturas"_',
    validating:  '🔍 Buscando evidencia real en internet...',
    exploring:   '🔍 Buscando problemas reales en tu industria...',
    noData:      '⚠️ Pocas discusiones encontradas. Puede ser un mercado muy nuevo o muy específico.',
    interested:  '👥 **{n} personas** en IdeaScout también exploran este nicho.',
    onlyYou:     '👥 **Eres el primero** en explorar este nicho aquí.',
    connectPaid: '💎 ¿Ver quiénes son? → próximamente con $SUPR',
    menuLabel:   '¿Qué hacemos?',
    help:        '**IdeaScout — Ayuda**\n\n✅ **Validar** — dime tu idea, te digo si hay mercado\n🔭 **Explorar** — dime tu industria, busco problemas reales\n📊 **Tendencias** — top oportunidades de la semana\n\nTambién puedes escribir directamente:\n_"valida mi idea de..."_ o _"qué problemas hay en salud"_',
  },
  en: {
    welcome:     '👋 I\'m **IdeaScout**\n\nI help you:\n✅ **Validate** if your idea has real market demand\n🔭 **Explore** what real problems exist in your industry\n\nWhat do we do?',
    askIndustry: 'What industry do you belong to or work in?\n\nEx: accounting, health, education, tech...\n_(No specific profession needed)_',
    askIdea:     'What\'s your idea or the problem you want to solve?\n\nDescribe it briefly. Ex: _"app for accountants to manage invoices without errors"_',
    validating:  '🔍 Searching for real evidence on the internet...',
    exploring:   '🔍 Searching for real problems in your industry...',
    noData:      '⚠️ Few discussions found. This might be a very new or niche market.',
    interested:  '👥 **{n} people** on IdeaScout are also exploring this niche.',
    onlyYou:     '👥 **You\'re the first** to explore this niche here.',
    connectPaid: '💎 See who they are? → coming soon with $SUPR',
    menuLabel:   'What do we do?',
    help:        '**IdeaScout — Help**\n\n✅ **Validate** — tell me your idea, I\'ll check the market\n🔭 **Explore** — tell me your industry, I\'ll find real problems\n📊 **Trends** — top opportunities this week\n\nYou can also write directly:\n_"validate my idea of..."_ or _"what problems exist in health"_',
  }
};

function t(lang, key, vars) {
  const str = (T[lang] || T['es'])[key] || key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replace('{' + k + '}', v), str);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
async function sendMenu(roomId, lang, isChannel = false) {
  const isEs = lang !== 'en';
  const buttons = [
    [
      { text: '✅ ' + (isEs ? 'Validar mi idea' : 'Validate my idea'), callback_data: 'ACTION:validate' },
      { text: '🔭 ' + (isEs ? 'Explorar nichos' : 'Explore niches'),  callback_data: 'ACTION:explore'  },
    ],
    [
      { text: '📊 ' + (isEs ? 'Tendencias'      : 'Trends'),          callback_data: 'ACTION:trends'   },
      { text: '🌐 ' + (isEs ? 'English'         : 'Español'),         callback_data: 'ACTION:lang'     },
    ],
    [{ text: '❓ ' + (isEs ? 'Ayuda'            : 'Help'),            callback_data: 'ACTION:help'     }],
  ];
  await agent.sendReplyMarkupMessage('buttons', roomId, t(lang, 'menuLabel'), buttons, {}, isChannel ? 'channel' : 'chat');
}
async function sendInterestFooter(roomId, niche, lang) {
  registerInterest(roomId, niche);
  const count = getInterestCount(niche);
  const msg = (count > 1 ? t(lang, 'interested', { n: count }) : t(lang, 'onlyYou')) + '\n' + t(lang, 'connectPaid');
  await agent.sendConnectionMessage(roomId, msg);
}

// ── Flujos principales ────────────────────────────────────────────────────────
async function runExplore(roomId, industry, lang) {
  const session = getSession(roomId);
  session.industry = industry;
  await agent.sendConnectionMessage(roomId, t(lang, 'exploring'));
  const hn    = await searchHackerNews(industry + ' problem frustrated pain');
  const devto = await searchDevTo(industry);
  const total = hn.count + devto.count;
  if (total < 3) {
    await agent.sendConnectionMessage(roomId, t(lang, 'noData'));
    await sendMenu(roomId, lang);
    return;
  }
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  const analysis = await analyzeWithGroq(industry, total, hn.example || devto.example, hn.snippet, comments, lang);
  let msg = '🏭 **' + industry + '** — ' + total + (lang === 'en' ? ' discussions\n\n' : ' discusiones\n\n');
  msg += analysis || '✅ ' + (lang === 'en' ? 'Real activity detected in this niche.' : 'Actividad real detectada en este nicho.');
  await agent.sendConnectionMessage(roomId, msg);
  await sendInterestFooter(roomId, industry, lang);
  await sendMenu(roomId, lang);
}

async function runValidate(roomId, idea, lang) {
  const session = getSession(roomId);
  await agent.sendConnectionMessage(roomId, t(lang, 'validating'));
  const result = await validateIdea(idea, lang, session.industry);
  if (!result) {
    await agent.sendConnectionMessage(roomId, t(lang, 'noData'));
    await sendMenu(roomId, lang);
    return;
  }
  await agent.sendConnectionMessage(roomId, result.analysis);
  await sendInterestFooter(roomId, result.niche, lang);
  await sendMenu(roomId, lang);
}

async function runTrends(roomId, lang) {
  await agent.sendConnectionMessage(roomId, t(lang, 'exploring'));
  if (Object.keys(patternCount).length === 0) await analyzePatterns();
  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  if (!sorted.length) { await agent.sendConnectionMessage(roomId, t(lang, 'noData')); await sendMenu(roomId, lang); return; }
  const isEs = lang !== 'en';
  let msg = isEs ? '📊 **Top oportunidades esta semana:**\n\n' : '📊 **Top opportunities this week:**\n\n';
  sorted.forEach(([kw, c], i) => { msg += (i+1) + '. ' + kw + ' → ' + c + (isEs ? ' discusiones\n' : ' discussions\n'); });
  await agent.sendConnectionMessage(roomId, msg);
  const rows = sorted.map(([kw], i) => [{ text: (i+1) + '. ' + kw, callback_data: 'DEEP:' + i }]);
  rows.push([{ text: isEs ? '🔙 Volver' : '🔙 Back', callback_data: 'ACTION:menu' }]);
  await agent.sendReplyMarkupMessage('buttons', roomId, isEs ? '¿Cuál profundizas?' : 'Which one to explore?', rows);
}

async function detectIntent(text, session, roomId) {
  const lang  = session.lang;
  const lower = text.toLowerCase();
  const isEs  = lang !== 'en';

  if (lower.match(/valid|hay mercado|is there market|mi idea|my idea|idea de .+/i)) {
    const ideaMatch = text.match(/idea(?:\s+de)?\s+(.+)/i) || text.match(/valid(?:a(?:r)?)?\s+(.+)/i);
    if (ideaMatch && ideaMatch[1].length > 3) { await runValidate(roomId, ideaMatch[1].trim(), lang); return true; }
    session.waitingFor = 'idea';
    await agent.sendConnectionMessage(roomId, t(lang, 'askIdea'));
    return true;
  }
  if (lower.match(/problema|problem|industria|industry|sector|nicho|niche|explora|explore/i)) {
    const indMatch = text.match(/(?:en|in|industria|industry|sector)\s+(.+)/i);
    if (indMatch && indMatch[1].length > 2) { await runExplore(roomId, indMatch[1].trim(), lang); return true; }
    session.waitingFor = 'industry';
    await agent.sendConnectionMessage(roomId, t(lang, 'askIndustry'));
    return true;
  }
  if (lower.match(/tendencia|trend|oportunidad|opportunity/i)) {
    await runTrends(roomId, lang);
    return true;
  }
  return false;
}

// ── Registrar handlers ────────────────────────────────────────────────────────
let handlersRegistered = false;
function registerHandlers() {
  if (!agent || handlersRegistered) return;
  handlersRegistered = true;

  agent.addCommand('/start', async ({ roomId }) => {
    const s = getSession(roomId);
    await agent.sendConnectionMessage(roomId, t(s.lang, 'welcome'));
    await sendMenu(roomId, s.lang);
  });

  agent.addCommand('/help', async ({ roomId }) => {
    const s = getSession(roomId);
    await agent.sendConnectionMessage(roomId, t(s.lang, 'help'));
    await sendMenu(roomId, s.lang);
  });

  agent.addCommand('/menu', async ({ roomId }) => {
    const s = getSession(roomId);
    await sendMenu(roomId, s.lang);
  });

  agent.addCommand('/validar', async ({ roomId, message }) => {
    const s    = getSession(roomId);
    const text = (message?.body?.m?.body || '').replace('/validar', '').trim();
    if (!text) { s.waitingFor = 'idea'; await agent.sendConnectionMessage(roomId, t(s.lang, 'askIdea')); return; }
    await runValidate(roomId, text, s.lang);
  });

  agent.addCommand('/explorar', async ({ roomId, message }) => {
    const s    = getSession(roomId);
    const text = (message?.body?.m?.body || '').replace('/explorar', '').trim();
    if (!text) { s.waitingFor = 'industry'; await agent.sendConnectionMessage(roomId, t(s.lang, 'askIndustry')); return; }
    await runExplore(roomId, text, s.lang);
  });

  agent.addCommand('callback_query', async ({ message, roomId }) => {
    const cmd  = message.callback_command || '';
    const data = message.data             || '';
    const s    = getSession(roomId);
    const lang = s.lang;

    if (cmd === 'ACTION') {
      if (data === 'validate') { s.waitingFor = 'idea'; await agent.sendConnectionMessage(roomId, t(lang, 'askIdea')); return; }
      if (data === 'explore')  {
        if (s.industry) { await runExplore(roomId, s.industry, lang); }
        else { s.waitingFor = 'industry'; await agent.sendConnectionMessage(roomId, t(lang, 'askIndustry')); }
        return;
      }
      if (data === 'trends') { await runTrends(roomId, lang); return; }
      if (data === 'lang')   { s.lang = lang === 'es' ? 'en' : 'es'; await agent.sendConnectionMessage(roomId, s.lang === 'en' ? '🌐 Switched to English!' : '🌐 ¡Cambiado a Español!'); await sendMenu(roomId, s.lang); return; }
      if (data === 'help')   { await agent.sendConnectionMessage(roomId, t(lang, 'help')); await sendMenu(roomId, lang); return; }
      if (data === 'menu')   { await sendMenu(roomId, lang); return; }
    }

    if (cmd === 'DEEP') {
      const idx    = parseInt(data);
      const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]);
      if (idx >= 0 && idx < sorted.length) {
        const [kw] = sorted[idx];
        const story    = topStories[kw] || {};
        const comments = story.storyId ? await getPostComments(story.storyId) : '';
        await agent.sendConnectionMessage(roomId, t(lang, 'exploring'));
        const analysis = await analyzeWithGroq(kw, patternCount[kw], story.title, story.snippet, comments, lang);
        const isEs = lang !== 'en';
        let msg = '🔍 **' + kw + '**\n\n' + (analysis || (isEs ? '✅ Alta demanda detectada.' : '✅ High demand detected.'));
        await agent.sendConnectionMessage(roomId, msg);
        await sendInterestFooter(roomId, kw, lang);
        await sendMenu(roomId, lang);
      }
      return;
    }
  });

  agent.addCommand('message', async ({ message, roomId }) => {
    const m    = message.body && message.body.m;
    const text = (typeof m === 'object' && typeof m.body === 'string' ? m.body : message.data) || '';
    if (!text || (message.rawMessage && message.rawMessage.isBot)) return;
    const isChannel =  !!message.rawMessage && message.rawMessage.__typename === 'ChannelMessage';
    if (isChannel && message.rawMessage?.isBot) return;

    const s    = getSession(roomId);
    const lang = s.lang;

    // Respuesta a pregunta pendiente
    if (s.waitingFor === 'industry') { s.waitingFor = null; await runExplore(roomId, text.trim(), lang); return; }
    if (s.waitingFor === 'idea')     { s.waitingFor = null; await runValidate(roomId, text.trim(), lang); return; }

    // Detectar intención
    const handled = await detectIntent(text, s, roomId);
    if (handled) return;

    // Respuesta abierta con Groq
    if (GROQ_API_KEY) {
      try {
        const isEs = lang !== 'en';
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
          { model: 'llama-3.1-8b-instant', messages: [
            { role: 'system', content: isEs
              ? 'Eres IdeaScout, ayudas a validar ideas de negocio y encontrar oportunidades de mercado. Responde en español, breve y útil.'
              : 'You are IdeaScout, you help validate business ideas and find market opportunities. Answer in English, brief and helpful.' },
            { role: 'user', content: text }
          ], max_tokens: 300 },
          { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
        );
       await sendMsg(roomId, r.data.choices[0].message.content, isChannel);
          } catch(e) {
       await sendMsg(roomId, lang === 'en' ? 'How can I help you?' : '¿En qué te ayudo?', isChannel);
      }
    }
    await sendMenu(roomId, lang);
  });

  console.log('[IdeaScout] Handlers registrados ✅');
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  if (!agent) return;
  try {
    const payload = req.body;
    if (payload && payload.challenge) return;
    registerHandlers();
    await agent.processRequest(payload);
  } catch(e) { console.error('[IdeaScout] Webhook error:', e.message); }
});

app.get('/',       (req, res) => res.json({ status: 'IdeaScout running', users: userSessions.size, niches: nicheInterest.size }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log('[IdeaScout] Puerto ' + PORT);
  analyzePatterns();
});
