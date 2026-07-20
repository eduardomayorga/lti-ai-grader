/**
 * Herramienta LTI 1.3 - "AI Grader"
 * -------------------------------------------------------------
 * - Se lanza desde Moodle (LTI 1.3) y recibe la identidad del alumno.
 * - Muestra la consigna/rubrica; el alumno pega su trabajo.
 * - Evalua el trabajo con Gemini y devuelve feedback + una nota sugerida.
 * - Envia la nota al libro de calificaciones de Moodle (LTI AGS).
 *
 * Variables de entorno necesarias (se cargan en Render):
 *   LTI_KEY         -> una cadena secreta larga (clave interna de cifrado)
 *   MONGO_URL       -> cadena de conexion de MongoDB Atlas
 *   GEMINI_API_KEY  -> API key de Google AI Studio (Gemini)
 *   GEMINI_MODEL    -> opcional (por defecto: gemini-2.5-flash)
 *   PORT            -> lo define Render automaticamente
 */

require('dotenv').config()
const crypto = require('crypto')
const lti = require('ltijs').Provider

/* ============================================================
 *  OPCIÓN A — Puerta única LTI para los agentes de Apps Script
 *  ------------------------------------------------------------
 *  Cuando un launch LTI trae el parámetro custom "agent", este
 *  tool NO muestra el grader: acuña un token HMAC corto (firmado
 *  con AGENT_SECRET, con la identidad del alumno matriculado y un
 *  vencimiento) y redirige al /exec del Apps Script correspondiente.
 *  El Apps Script valida ese token antes de tocar Gemini, así que
 *  un externo sin launch de Moodle no puede usar el agente.
 *
 *  Variables de entorno adicionales en Render:
 *    AGENT_SECRET         -> cadena secreta larga y aleatoria
 *                            (la MISMA en las Propiedades del Script
 *                             de cada proyecto Apps Script).
 *    AGENT_URL_ASISTENTE  -> URL /exec del proyecto "asistente"
 *                            (multi-ejercicio: M2/M1desid/M3).
 *    AGENT_URL_M1PR       -> URL /exec del proyecto "M1 P&R".
 *    AGENT_TOKEN_TTL_MIN  -> opcional, minutos de validez (def. 180).
 * ============================================================ */

// agente lógico -> proyecto Apps Script (su URL /exec)
function agentBaseUrl (agent) {
  switch (agent) {
    case 'm4inicial':
    case 'm4scribeinicial':
    case 'm4practica':
    case 'm4scribe':   return process.env.AGENT_URL_M4
    case 'm1pr':       return process.env.AGENT_URL_M1PR
    case 'm1desid':
    case 'm2inicial':
    case 'm2practica':
    case 'm3inicial':
    case 'm3practica': return process.env.AGENT_URL_ASISTENTE
    case 'multiia':    return (process.env.TOOL_URL || 'https://lti-ai-grader-jubc.onrender.com') + '/multiia'
    default:           return null
  }
}

// agente lógico -> valor ?ex= que espera el proyecto asistente
// (el M1 P&R no usa ?ex=; el token ya lleva el agente)
const AGENT_EX = {
  m4inicial: 'm4inicial',
  m4scribeinicial: 'm4scribeinicial',
  m4practica: 'm4practica',
  m4scribe: 'm4scribe',
  m1desid: 'm1desid',
  m2inicial: 'inicial',
  m2practica: '',           // modo por defecto del asistente
  m3inicial: 'm3inicial',
  m3practica: 'm3practica'
}

function b64url (buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mintAgentToken (payload, secret) {
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  return body + '.' + sig
}

function redirectToAgent (agent, token, res) {
  const base = agentBaseUrl(agent)
  const secret = process.env.AGENT_SECRET
  if (!base || !secret) {
    return res.status(500).send('Agente no configurado en el servidor (falta URL o AGENT_SECRET).')
  }
  const ui = token.userInfo || {}
  const ttlMin = Number(process.env.AGENT_TOKEN_TTL_MIN || 180)
  const payload = {
    uid: token.user,                                   // id LTI estable del alumno
    name: ((ui.name || ui.given_name || '') + '').slice(0, 120),
    email: ((ui.email || '') + '').slice(0, 120),
    ex: agent,                                         // ata el token a este agente
    exp: Math.floor(Date.now() / 1000) + ttlMin * 60
  }
  const t = mintAgentToken(payload, secret)
  const params = new URLSearchParams()
  const exVal = AGENT_EX[agent]
  if (exVal) params.set('ex', exVal)
  params.set('t', t)
  return res.redirect(base + '?' + params.toString())
}

// ---- Configuracion de ltijs (LTI 1.3) ----
lti.setup(
  process.env.LTI_KEY,
  { url: process.env.MONGO_URL },
  {
    appRoute: '/',
    loginRoute: '/login',
    keysetRoute: '/keys',
    dynRegRoute: '/register',
    dynReg: {
      url: process.env.TOOL_URL || 'https://lti-ai-grader-jubc.onrender.com',
      name: 'AI Grader - Evaluacion con IA',
      autoActivate: true
    },
    cookies: { secure: true, sameSite: 'None' },
    devMode: false
  }
)

// ---- Registro dinamico (conectar Moodle sin copiar endpoints a mano) ----
lti.onDynamicRegistration(async (req, res, next) => {
  try {
    if (!req.query.openid_configuration) {
      return res.status(400).send('Falta el parametro openid_configuration.')
    }
    const message = await lti.DynamicRegistration.register(
      req.query.openid_configuration,
      req.query.registration_token
    )
    res.setHeader('Content-type', 'text/html')
    return res.send(message)
  } catch (err) {
    if (err.message === 'PLATFORM_ALREADY_REGISTERED') {
      return res.status(403).send('Esta plataforma ya esta registrada.')
    }
    return next(err)
  }
})

// ---- Llamada a Gemini ----
async function evaluarConGemini (rubrica, maxNota, trabajo) {
  const key = process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  const prompt = `Sos un evaluador docente de un curso de medicina. Evalua el TRABAJO del alumno contra la RUBRICA.
Devolve SOLO un JSON valido con esta forma exacta, sin texto adicional:
{"nota": <numero entre 0 y ${maxNota}>, "feedback": "<devolucion clara y constructiva para el alumno, en espanol>"}

RUBRICA:
${rubrica}

TRABAJO DEL ALUMNO:
${trabajo}`

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    })
  })
  const data = await r.json()
  const text = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text
  let parsed
  try {
    parsed = JSON.parse(text || '{}')
  } catch (e) {
    parsed = { nota: 0, feedback: 'No se pudo interpretar la respuesta de la IA.' }
  }
  return parsed
}

// ---- Pantalla de lanzamiento ----
lti.onConnect(async (token, req, res) => {
  const custom = (token.platformContext && token.platformContext.custom) || {}

  // --- Opción A: si el launch trae custom "agent", desviamos al Apps Script ---
  const agent = (custom.agent || '').toString().trim()
  if (agent) {
    return redirectToAgent(agent, token, res)
  }

  const rubrica = custom.rubrica || 'Rubrica por defecto: claridad, exactitud clinica y verificacion de la informacion.'
  const maxNota = Number(custom.maxnota || 10)
  const nombre = (token.userInfo && token.userInfo.given_name) || 'colega'
  const ltik = res.locals.ltik

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evaluacion con IA</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1f3864}
 h1{font-size:22px}
 .rubrica{background:#f6f8fb;border-left:4px solid #1f5c99;padding:12px 16px;border-radius:6px;white-space:pre-wrap}
 textarea{width:100%;min-height:220px;font-size:15px;padding:10px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
 button{background:#1f5c99;color:#fff;border:0;padding:12px 20px;font-size:16px;border-radius:6px;cursor:pointer;margin-top:12px}
 button:disabled{opacity:.6;cursor:default}
 #resultado{margin-top:20px;padding:16px;border-radius:8px;background:#eef5ff;white-space:pre-wrap;display:none}
 .nota{font-weight:bold;font-size:18px}
</style></head><body>
<h1>Hola, ${nombre}. Practica y recibi tu devolucion</h1>
<p><strong>Consigna / Rubrica:</strong></p>
<div class="rubrica">${rubrica}</div>
<p>Pega tu trabajo aqui:</p>
<textarea id="trabajo" placeholder="Escribi o pega tu respuesta..."></textarea><br>
<button id="btn">Enviar para evaluacion</button>
<div id="resultado"></div>
<script>
 const ltik = ${JSON.stringify(ltik)};
 document.getElementById('btn').onclick = async () => {
   const trabajo = document.getElementById('trabajo').value.trim();
   if(!trabajo){ alert('Escribi tu trabajo primero.'); return; }
   const btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = 'Evaluando...';
   try {
     const resp = await fetch('/evaluate?ltik=' + encodeURIComponent(ltik), {
       method:'POST', headers:{'Content-Type':'application/json'},
       body: JSON.stringify({ trabajo })
     });
     const data = await resp.json();
     const div = document.getElementById('resultado');
     div.style.display='block';
     div.innerHTML = '<div class="nota">Nota sugerida: ' + data.nota + '/' + data.maxNota + '</div><br>' +
       (data.feedback || '');
   } catch(e){ alert('Error al evaluar: ' + e.message); }
   btn.disabled=false; btn.textContent='Enviar para evaluacion';
 };
</script></body></html>`
  return res.send(html)
})

// ---- Endpoint de evaluacion + envio de nota (AGS) ----
lti.app.post('/evaluate', async (req, res) => {
  const token = res.locals.token
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  const custom = (token.platformContext && token.platformContext.custom) || {}
  const rubrica = custom.rubrica || 'Claridad, exactitud clinica y verificacion de la informacion.'
  const maxNota = Number(custom.maxnota || 10)
  const trabajo = (req.body.trabajo || '').toString().slice(0, 20000)

  // 1) Evaluar con Gemini
  const evalIA = await evaluarConGemini(rubrica, maxNota, trabajo)
  let nota = Number(evalIA.nota)
  if (isNaN(nota)) nota = 0
  nota = Math.max(0, Math.min(maxNota, nota))

  // 2) Enviar la nota a Moodle (AGS)
  try {
    let lineItemId = token.platformContext.endpoint && token.platformContext.endpoint.lineitem
    if (!lineItemId) {
      const resp = await lti.Grade.getLineItems(token, { resourceLinkId: true })
      if (resp.lineItems && resp.lineItems.length) {
        lineItemId = resp.lineItems[0].id
      } else {
        const created = await lti.Grade.createLineItem(token, {
          scoreMaximum: maxNota,
          label: 'Evaluacion IA',
          tag: 'ai',
          resourceLinkId: token.platformContext.resource.id
        })
        lineItemId = created.id
      }
    }
    await lti.Grade.submitScore(token, lineItemId, {
      userId: token.user,
      scoreGiven: nota,
      scoreMaximum: maxNota,
      comment: (evalIA.feedback || '').slice(0, 1000),
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded'
    })
  } catch (err) {
    console.error('Error al enviar la nota (AGS):', err.message)
  }

  return res.json({ nota, maxNota, feedback: evalIA.feedback })
})

// ---- Diagnostico: IP publica de salida de este servidor (para el soporte del hosting) ----
lti.app.get('/myip', async (req, res) => {
  try {
    const data = await fetch('https://api.ipify.org?format=json').then(r => r.json())
    return res.json({ outboundIp: data.ip })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ---- Arranque ----
const start = async () => {
  lti.whitelist('/myip')
  require('./multiia').mount(lti)
  await lti.deploy({ port: process.env.PORT || 3000 })
  console.log('LTI AI Grader en linea.')
}
start()
