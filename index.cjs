require('dotenv').config();
const { SuperDappAgent } = require('@superdapp/agents');
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const API_TOKEN    = process.env.API_TOKEN    || '';
const GROQ_API_KEY = process.env.Groq_IA      || '';
const GROUP_ID     = process.env.GROUP_ID     || 'ddcfc5f0-9436-4549-aa9b-937f1845d223';
// Cuántas exploraciones gratuitas tiene cada usuario antes del paywall
const FREE_EXPLORES = 2;

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
  const proto = Object.getPrototypeOf(agent);
  proto.sendChannelMessage = async function(channelId, message, options) {
    const msgBody = { body: JSON.stringify({ m: encodeURIComponent(JSON.stringify({ body: message })), t: 'channel' }) };
    return this.client.sendChannelMessage(channelId, { message: msgBody, isSilent: options?.isSilent || false });
  };
}

// ── sendMsg — helper único para DM y canal ────────────────────────────────────
// Todos los flujos usan este wrapper en vez de llamar directamente al agente.
async function sendMsg(roomId, text, isChannel = false) {
  if (!agent) return;
  if (isChannel) {
    return agent.sendChannelMessage(roomId, text);
  }
  return agent.sendConnectionMessage(roomId, text);
}

// ── Sesiones ──────────────────────────────────────────────────────────────────
const userSessions = new Map();
function getSession(roomId) {
  if (!userSessions.has(roomId)) {
    userSessions.set(roomId, {
      lang:          'es',
      industry:      null,
      profession:    null,   // NUEVO: profesión del usuario
      waitingFor:    null,
      exploreCount:  0,      // NUEVO: contador de exploraciones gratuitas
      unlockedExtra: false,  // NUEVO: si ya pagó por más nichos
    });
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

async function analyzeWithGroq(keyword, mentions, example, snippet, comments, lang, profession) {
  if (!GROQ_API_KEY) return null;
  const isEs = lang !== 'en';
  // Si tenemos profesión, la incluimos en el prompt para personalizar el análisis
  const profCtx = profession
    ? (isEs ? ' El usuario es: ' + profession + '.' : ' The user is: ' + profession + '.')
    : '';
  try {
    const prompt = isEs
      ? 'Analista de oportunidades.' + profCtx + ' Personas buscan solución a: "' + keyword + '". ' + mentions + ' discusiones. ' +
        (example ? 'Post: "' + example + '". ' : '') + (comments ? 'Comentarios: "' + comments + '". ' : '') +
        'Responde en español sin markdown:\n💬 Lo que dice la gente: [2 líneas]\n😤 El dolor principal: [1 frase]\n💡 Oportunidad: [1 frase]\n❓ [1 pregunta de validación]'
      : 'Market analyst.' + profCtx + ' People seek solution to: "' + keyword + '". ' + mentions + ' discussions. ' +
        (example ? 'Post: "' + example + '". ' : '') + (comments ? 'Comments: "' + comments + '". ' : '') +
        'Answer in English without markdown:\n💬 What people say: [2 lines]\n😤 Main pain: [1 sentence]\n💡 Opportunity: [1 sentence]\n❓ [1 validation question]';
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 350 },
      { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
    );
    return r.data.choices[0].message.content;
  } catch(e) { return null; }
}

async function validateIdea(idea, lang, industry, profession) {
  if (!GROQ_API_KEY) return null;
  const isEs = lang !== 'en';
  const hn    = await searchHackerNews(idea + ' problem pain');
  const devto = await searchDevTo(idea);
  const total = hn.count + devto.count;
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  const profCtx = profession
    ? (isEs ? ' El usuario es: ' + profession + '.' : ' The user is: ' + profession + '.')
    : '';
  try {
    const prompt = isEs
      ? 'Valida si existe demanda para: "' + idea + '"' + (industry ? ' (industria: ' + industry + ')' : '') + profCtx +
        '. Encontré ' + total + ' discusiones.' + (hn.example ? ' Ejemplo: "' + hn.example + '".' : '') +
        (comments ? ' Comentarios: "' + comments + '".' : '') +
        '\nSin markdown:\n✅ o ❌ Veredicto: [existe o no el problema]\n📊 Evidencia: [qué encontré]\n🎯 Oportunidad: [cómo monetizar si existe]\n⚠️ Riesgo: [qué podría fallar]'
      : 'Validate demand for: "' + idea + '"' + (industry ? ' (industry: ' + industry + ')' : '') + profCtx +
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
    welcome:        '👋 Soy **IdeaScout**\n\nTe ayudo a:\n✅ **Validar** si tu idea tiene mercado real\n🔭 **Explorar** qué problemas reales hay en tu industria\n\n¿Qué hacemos?',
    askProfession:  '¿A qué te dedicas o qué profesión tienes?\n\nEj: contador, médico, abogado, desarrollador, emprendedor...\n_(Esto me ayuda a personalizar el análisis para ti)_',
    profSaved:      '✅ Guardado. Usaré eso para personalizar tus análisis.',
    askIndustry:    '¿A qué industria perteneces o en qué área trabajas?\n\nEj: contabilidad, salud, educación, tecnología...\n_(No necesitas tener profesión específica)_',
    askIdea:        '¿Cuál es tu idea o el problema que quieres resolver?\n\nEscríbela brevemente. Ej: _"app para contadores sin errores en facturas"_',
    validating:     '🔍 Buscando evidencia real en internet...',
    exploring:      '🔍 Buscando problemas reales en tu industria...',
    noData:         '⚠️ Pocas discusiones encontradas. Puede ser un mercado muy nuevo o muy específico.',
    interested:     '👥 **{n} personas** en IdeaScout también exploran este nicho.',
    onlyYou:        '👥 **Eres el primero** en explorar este nicho aquí.',
    connectPaid:    '💎 ¿Ver quiénes son? → próximamente con $SUPR',
    menuLabel:      '¿Qué hacemos?',
    unlockMore:     '🔓 **¿Quieres explorar más nichos?**\n\nYa usaste tus {free} exploraciones gratuitas.\n\nDesbloquea **5 búsquedas extra** por **10 $SUPR**.\n\n_(Funcionalidad de pago en construcción — conéctate pronto)_',
    unlockSuccess:  '🎉 ¡Desbloqueado! Ya tienes acceso a exploraciones extra.',
    help:           '**IdeaScout — Ayuda**\n\n✅ **Validar** — dime tu idea, te digo si hay mercado\n🔭 **Explorar** — dime tu industria, busco problemas reales\n📊 **Tendencias** — top oportunidades de la semana\n👤 **Profesión** — configura tu perfil\n\n**Comandos rápidos:**\n`/v [idea]` — validar idea\n`/e [industria]` — explorar nicho\n`/t` — ver tendencias\n`/p [profesión]` — guardar tu profesión\n\nO escribe directamente: _"valida mi idea de..."_',
  },
  en: {
    welcome:        '👋 I\'m **IdeaScout**\n\nI help you:\n✅ **Validate** if your idea has real market demand\n🔭 **Explore** what real problems exist in your industry\n\nWhat do we do?',
    askProfession:  'What do you do for a living or what\'s your profession?\n\nEx: accountant, doctor, lawyer, developer, entrepreneur...\n_(This helps me personalise the analysis for you)_',
    profSaved:      '✅ Saved. I\'ll use that to personalise your analysis.',
    askIndustry:    'What industry do you belong to or work in?\n\nEx: accounting, health, education, tech...\n_(No specific profession needed)_',
    askIdea:        'What\'s your idea or the problem you want to solve?\n\nDescribe it briefly. Ex: _"app for accountants to manage invoices without errors"_',
    validating:     '🔍 Searching for real evidence on the internet...',
    exploring:      '🔍 Searching for real problems in your industry...',
    noData:         '⚠️ Few discussions found. This might be a very new or niche market.',
    interested:     '👥 **{n} people** on IdeaScout are also exploring this niche.',
    onlyYou:        '👥 **You\'re the first** to explore this niche here.',
    connectPaid:    '💎 See who they are? → coming soon with $SUPR',
    menuLabel:      'What do we do?',
    unlockMore:     '🔓 **Want to explore more niches?**\n\nYou\'ve used your {free} free explorations.\n\nUnlock **5 extra searches** for **10 $SUPR**.\n\n_(Payment feature under construction — coming soon)_',
    unlockSuccess:  '🎉 Unlocked! You now have access to extra explorations.',
    help:           '**IdeaScout — Help**\n\n✅ **Validate** — tell me your idea, I\'ll check the market\n🔭 **Explore** — tell me your industry, I\'ll find real problems\n📊 **Trends** — top opportunities this week\n👤 **Profession** — configure your profile\n\n**Quick commands:**\n`/v [idea]` — validate idea\n`/e [industry]` — explore niche\n`/t` — see trends\n`/p [profession]` — save your profession\n\nOr type directly: _"validate my idea of..."_',
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
  const session = getSession(roomId);
  const rows = [
    [
      { text: '✅ ' + (isEs ? 'Validar mi idea'  : 'Validate my idea'), callback_data: 'ACTION:validate' },
      { text: '🔭 ' + (isEs ? 'Explorar nichos'  : 'Explore niches'),   callback_data: 'ACTION:explore'  },
    ],
    [
      { text: '📊 ' + (isEs ? 'Tendencias'        : 'Trends'),           callback_data: 'ACTION:trends'   },
      { text: '👤 ' + (isEs ? 'Mi profesión'      : 'My profession'),    callback_data: 'ACTION:profession'},
    ],
    [
      { text: '🌐 ' + (isEs ? 'English'           : 'Español'),          callback_data: 'ACTION:lang'     },
      { text: '❓ ' + (isEs ? 'Ayuda'             : 'Help'),             callback_data: 'ACTION:help'     },
    ],
  ];
  // Mostrar botón de desbloqueo si el usuario ya agotó sus exploraciones gratuitas
  if (session.exploreCount >= FREE_EXPLORES && !session.unlockedExtra) {
    rows.push([{ text: '🔓 ' + (isEs ? 'Explorar más nichos ($SUPR)' : 'Explore more niches ($SUPR)'), callback_data: 'ACTION:unlock_more' }]);
  }
  if (agent) {
    await agent.sendReplyMarkupMessage('buttons', roomId, t(lang, 'menuLabel'), rows);
  }
}

async function sendInterestFooter(roomId, niche, lang, isChannel = false) {
  registerInterest(roomId, niche);
  const count = getInterestCount(niche);
  const msg = (count > 1 ? t(lang, 'interested', { n: count }) : t(lang, 'onlyYou')) + '\n' + t(lang, 'connectPaid');
  await sendMsg(roomId, msg, isChannel);
}

// ── Flujo de pago / desbloqueo ────────────────────────────────────────────────
// STUB: cuando tengas la documentación de SuperDapp Payments, reemplaza el interior
// de esta función con la llamada al SDK correspondiente. El resto del código no cambia.
async function handleUnlockMore(roomId, lang, isChannel = false) {
  const session = getSession(roomId);
  const isEs = lang !== 'en';

  // TODO: iniciar flujo de pago real con el SDK de SuperDapp
  // Ejemplo (pseudocódigo):
  //   const paymentResult = await agent.requestPayment({ roomId, amount: 10, token: 'SUPR', reason: 'IdeaScout extra explores' });
  //   if (paymentResult.success) { session.unlockedExtra = true; }

  // Por ahora mostramos el mensaje informativo y desbloqueamos en modo demo
  await sendMsg(roomId, t(lang, 'unlockMore', { free: FREE_EXPLORES }), isChannel);

  // Botón de confirmar pago (stub — en producción este botón lo maneja el SDK)
  if (agent) {
    await agent.sendReplyMarkupMessage('buttons', roomId, isEs ? '¿Confirmar?' : 'Confirm?', [
      [{ text: isEs ? '💳 Pagar 10 $SUPR' : '💳 Pay 10 $SUPR', callback_data: 'ACTION:confirm_payment' }],
      [{ text: isEs ? '❌ Cancelar'        : '❌ Cancel',        callback_data: 'ACTION:menu'            }],
    ]);
  }
}

// ── Flujos principales ────────────────────────────────────────────────────────
async function runExplore(roomId, industry, lang, isChannel = false) {
  const session = getSession(roomId);

  // Verificar límite gratuito
  if (session.exploreCount >= FREE_EXPLORES && !session.unlockedExtra) {
    await handleUnlockMore(roomId, lang, isChannel);
    return;
  }

  session.industry = industry;
  session.exploreCount++;

  await sendMsg(roomId, t(lang, 'exploring'), isChannel);
  const hn    = await searchHackerNews(industry + ' problem frustrated pain');
  const devto = await searchDevTo(industry);
  const total = hn.count + devto.count;
  if (total < 3) {
    await sendMsg(roomId, t(lang, 'noData'), isChannel);
    await sendMenu(roomId, lang, isChannel);
    return;
  }
  const comments = hn.storyId ? await getPostComments(hn.storyId) : '';
  const analysis = await analyzeWithGroq(industry, total, hn.example || devto.example, hn.snippet, comments, lang, session.profession);
  let msg = '🏭 **' + industry + '** — ' + total + (lang === 'en' ? ' discussions\n\n' : ' discusiones\n\n');
  msg += analysis || '✅ ' + (lang === 'en' ? 'Real activity detected in this niche.' : 'Actividad real detectada en este nicho.');
  await sendMsg(roomId, msg, isChannel);
  await sendInterestFooter(roomId, industry, lang, isChannel);
  await sendMenu(roomId, lang, isChannel);
}

async function runValidate(roomId, idea, lang, isChannel = false) {
  const session = getSession(roomId);
  await sendMsg(roomId, t(lang, 'validating'), isChannel);
  const result = await validateIdea(idea, lang, session.industry, session.profession);
  if (!result) {
    await sendMsg(roomId, t(lang, 'noData'), isChannel);
    await sendMenu(roomId, lang, isChannel);
    return;
  }
  await sendMsg(roomId, result.analysis, isChannel);
  await sendInterestFooter(roomId, result.niche, lang, isChannel);
  await sendMenu(roomId, lang, isChannel);
}

async function runTrends(roomId, lang, isChannel = false) {
  await sendMsg(roomId, t(lang, 'exploring'), isChannel);
  if (Object.keys(patternCount).length === 0) await analyzePatterns();
  const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]).slice(0,5);
  if (!sorted.length) { await sendMsg(roomId, t(lang, 'noData'), isChannel); await sendMenu(roomId, lang, isChannel); return; }
  const isEs = lang !== 'en';
  let msg = isEs ? '📊 **Top oportunidades esta semana:**\n\n' : '📊 **Top opportunities this week:**\n\n';
  sorted.forEach(([kw, c], i) => { msg += (i+1) + '. ' + kw + ' → ' + c + (isEs ? ' discusiones\n' : ' discussions\n'); });
  await sendMsg(roomId, msg, isChannel);
  if (agent) {
    const rows = sorted.map(([kw], i) => [{ text: (i+1) + '. ' + kw, callback_data: 'DEEP:' + i }]);
    rows.push([{ text: isEs ? '🔙 Volver' : '🔙 Back', callback_data: 'ACTION:menu' }]);
    await agent.sendReplyMarkupMessage('buttons', roomId, isEs ? '¿Cuál profundizas?' : 'Which one to explore?', rows);
  }
}

async function runSetProfession(roomId, profession, lang, isChannel = false) {
  const session = getSession(roomId);
  session.profession = profession.trim();
  await sendMsg(roomId, t(lang, 'profSaved'), isChannel);
  await sendMenu(roomId, lang, isChannel);
}

async function detectIntent(text, session, roomId, isChannel = false) {
  const lang  = session.lang;
  const lower = text.toLowerCase();
  // Saludo o mensaje abierto corto → bienvenida con menú
if (lower.match(/^(hola|hello|hi|hey|buenas|buenos|good|start|inicio|comenzar|empezar|ayuda|help|\s*)$/) || lower.length < 12) {
  const isEs = lang !== 'en';
  const greeting = isEs
    ? '👋 ¡Hola! Soy **IdeaScout**. ¿Por dónde empezamos?'
    : '👋 Hey! I\'m **IdeaScout**. Where do you want to start?';
  await sendMsg(roomId, greeting, isChannel);
  await sendMenu(roomId, lang, isChannel);
  return true;
}

  if (lower.match(/valid|hay mercado|is there market|mi idea|my idea|idea de .+/i)) {
    const ideaMatch = text.match(/idea(?:\s+de)?\s+(.+)/i) || text.match(/valid(?:a(?:r)?)?\s+(.+)/i);
    if (ideaMatch && ideaMatch[1].length > 3) { await runValidate(roomId, ideaMatch[1].trim(), lang, isChannel); return true; }
    session.waitingFor = 'idea';
    await sendMsg(roomId, t(lang, 'askIdea'), isChannel);
    return true;
  }
  if (lower.match(/problema|problem|industria|industry|sector|nicho|niche|explora|explore/i)) {
    const indMatch = text.match(/(?:en|in|industria|industry|sector)\s+(.+)/i);
    if (indMatch && indMatch[1].length > 2) { await runExplore(roomId, indMatch[1].trim(), lang, isChannel); return true; }
    session.waitingFor = 'industry';
    await sendMsg(roomId, t(lang, 'askIndustry'), isChannel);
    return true;
  }
  if (lower.match(/tendencia|trend|oportunidad|opportunity/i)) {
    await runTrends(roomId, lang, isChannel);
    return true;
  }
  if (lower.match(/profesion|profesión|profession|trabajo|soy |i am |work as/i)) {
    const profMatch = text.match(/(?:soy|trabajo como|me dedico a|profession:|i am|work as)\s+(.+)/i);
    if (profMatch && profMatch[1].length > 2) { await runSetProfession(roomId, profMatch[1].trim(), lang, isChannel); return true; }
    session.waitingFor = 'profession';
    await sendMsg(roomId, t(lang, 'askProfession'), isChannel);
    return true;
  }
  return false;
}

// ── Registrar handlers ────────────────────────────────────────────────────────
let handlersRegistered = false;
function registerHandlers() {
  if (!agent || handlersRegistered) return;
  handlersRegistered = true;

  // /start — bienvenida + pregunta de profesión si no la tiene
  agent.addCommand('/start', async ({ roomId }) => {
    const s = getSession(roomId);
    await sendMsg(roomId, t(s.lang, 'welcome'));
    if (!s.profession) {
      s.waitingFor = 'profession';
      await sendMsg(roomId, t(s.lang, 'askProfession'));
    } else {
      await sendMenu(roomId, s.lang);
    }
  });

  agent.addCommand('/help', async ({ roomId }) => {
    const s = getSession(roomId);
    await sendMsg(roomId, t(s.lang, 'help'));
    await sendMenu(roomId, s.lang);
  });

  agent.addCommand('/menu', async ({ roomId }) => {
    const s = getSession(roomId);
    await sendMenu(roomId, s.lang);
  });

  // /validar y alias corto /v
  const handleValidar = async ({ roomId, message }) => {
    const s    = getSession(roomId);
    const raw  = message?.body?.m?.body || message?.data || '';
    const text = raw.replace(/^\/v(?:alidar)?\s*/i, '').trim();
    if (!text) { s.waitingFor = 'idea'; await sendMsg(roomId, t(s.lang, 'askIdea')); return; }
    await runValidate(roomId, text, s.lang);
  };
  agent.addCommand('/validar', handleValidar);
  agent.addCommand('/v',       handleValidar);

  // /explorar y alias corto /e
  const handleExplorar = async ({ roomId, message }) => {
    const s    = getSession(roomId);
    const raw  = message?.body?.m?.body || message?.data || '';
    const text = raw.replace(/^\/e(?:xplorar)?\s*/i, '').trim();
    if (!text) { s.waitingFor = 'industry'; await sendMsg(roomId, t(s.lang, 'askIndustry')); return; }
    await runExplore(roomId, text, s.lang);
  };
  agent.addCommand('/explorar', handleExplorar);
  agent.addCommand('/e',        handleExplorar);

  // /tendencias y alias corto /t
  const handleTendencias = async ({ roomId }) => {
    const s = getSession(roomId);
    await runTrends(roomId, s.lang);
  };
  agent.addCommand('/tendencias', handleTendencias);
  agent.addCommand('/trends',     handleTendencias);
  agent.addCommand('/t',          handleTendencias);

  // /profesion y alias corto /p — guarda o pregunta la profesión
  const handleProfesion = async ({ roomId, message }) => {
    const s    = getSession(roomId);
    const raw  = message?.body?.m?.body || message?.data || '';
    const text = raw.replace(/^\/p(?:rofesi[oó]n)?\s*/i, '').trim();
    if (!text) { s.waitingFor = 'profession'; await sendMsg(roomId, t(s.lang, 'askProfession')); return; }
    await runSetProfession(roomId, text, s.lang);
  };
  agent.addCommand('/profesion', handleProfesion);
  agent.addCommand('/profession', handleProfesion);
  agent.addCommand('/p',          handleProfesion);

  // callback_query — botones inline
  agent.addCommand('callback_query', async ({ message, roomId }) => {
    const cmd  = message.callback_command || '';
    const data = message.data             || '';
    const s    = getSession(roomId);
    const lang = s.lang;

    if (cmd === 'ACTION') {
      if (data === 'validate')  { s.waitingFor = 'idea';       await sendMsg(roomId, t(lang, 'askIdea'));       return; }
      if (data === 'explore') {
        if (s.industry) { await runExplore(roomId, s.industry, lang); }
        else { s.waitingFor = 'industry'; await sendMsg(roomId, t(lang, 'askIndustry')); }
        return;
      }
      if (data === 'trends')    { await runTrends(roomId, lang);                                                return; }
      if (data === 'profession'){ s.waitingFor = 'profession'; await sendMsg(roomId, t(lang, 'askProfession')); return; }
      if (data === 'unlock_more'){ await handleUnlockMore(roomId, lang);                                        return; }
      if (data === 'confirm_payment') {
        // STUB: aquí va la confirmación real del pago con el SDK de SuperDapp
        s.unlockedExtra = true;
        await sendMsg(roomId, t(lang, 'unlockSuccess'));
        await sendMenu(roomId, lang);
        return;
      }
      if (data === 'lang') {
        s.lang = lang === 'es' ? 'en' : 'es';
        await sendMsg(roomId, s.lang === 'en' ? '🌐 Switched to English!' : '🌐 ¡Cambiado a Español!');
        await sendMenu(roomId, s.lang);
        return;
      }
      if (data === 'help') { await sendMsg(roomId, t(lang, 'help')); await sendMenu(roomId, lang); return; }
      if (data === 'menu') { await sendMenu(roomId, lang);                                         return; }
    }

    if (cmd === 'DEEP') {
      const idx    = parseInt(data);
      const sorted = Object.entries(patternCount).sort((a,b) => b[1]-a[1]);
      if (idx >= 0 && idx < sorted.length) {
        const [kw]  = sorted[idx];
        const story = topStories[kw] || {};
        const comments = story.storyId ? await getPostComments(story.storyId) : '';
        await sendMsg(roomId, t(lang, 'exploring'));
        const analysis = await analyzeWithGroq(kw, patternCount[kw], story.title, story.snippet, comments, lang, s.profession);
        const isEs = lang !== 'en';
        const msg  = '🔍 **' + kw + '**\n\n' + (analysis || (isEs ? '✅ Alta demanda detectada.' : '✅ High demand detected.'));
        await sendMsg(roomId, msg);
        await sendInterestFooter(roomId, kw, lang);
        await sendMenu(roomId, lang);
      }
      return;
    }
  });

  // message — texto libre
  agent.addCommand('message', async ({ message, roomId }) => {
    const m    = message.body && message.body.m;
    const text = (typeof m === 'object' && typeof m.body === 'string' ? m.body : message.data) || '';
    if (!text || (message.rawMessage && message.rawMessage.isBot)) return;

    const isChannel = !!(message.rawMessage && message.rawMessage.__typename === 'ChannelMessage');
    if (isChannel && message.rawMessage?.isBot) return;

    const s    = getSession(roomId);
    const lang = s.lang;

    // Respuesta a pregunta pendiente
    if (s.waitingFor === 'profession') { s.waitingFor = null; await runSetProfession(roomId, text.trim(), lang, isChannel); return; }
    if (s.waitingFor === 'industry')   { s.waitingFor = null; await runExplore(roomId, text.trim(), lang, isChannel);       return; }
    if (s.waitingFor === 'idea')       { s.waitingFor = null; await runValidate(roomId, text.trim(), lang, isChannel);      return; }

    // Detectar intención
    const handled = await detectIntent(text, s, roomId, isChannel);
    if (handled) return;

    // Respuesta abierta con Groq
    if (GROQ_API_KEY) {
      try {
        const isEs = lang !== 'en';
        const profCtx = s.profession
          ? (isEs ? ' El usuario es ' + s.profession + '.' : ' The user is ' + s.profession + '.')
          : '';
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
          { model: 'llama-3.1-8b-instant', messages: [
            { role: 'system', content: isEs
              ? 'Eres IdeaScout, ayudas a validar ideas de negocio y encontrar oportunidades de mercado.' + profCtx + ' Responde en español, breve y útil.'
              : 'You are IdeaScout, you help validate business ideas and find market opportunities.' + profCtx + ' Answer in English, brief and helpful.' },
            { role: 'user', content: text }
          ], max_tokens: 300 },
          { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
        );
        await sendMsg(roomId, r.data.choices[0].message.content, isChannel);
      } catch(e) {
        await sendMsg(roomId, lang === 'en' ? 'How can I help you?' : '¿En qué te ayudo?', isChannel);
      }
    }
    await sendMenu(roomId, lang, isChannel);
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
