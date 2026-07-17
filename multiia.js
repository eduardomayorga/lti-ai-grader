/**
 * multiia.js — Proxy + página gateada de la app "Multi-IA" para el curso.
 * =====================================================================
 * Se monta sobre el MISMO servicio ltijs del AI Grader (Render), sin tocar
 * el grader ni los otros agentes. Reutiliza el token HMAC "Opción A":
 * el alumno entra por Moodle → onConnect mintea un token (ex="multiia") y
 * redirige a /multiia?t=<token> → esta página llama al proxy /api/multiia/*
 * que valida el token y habla con OpenRouter con la clave SECRETA del servidor.
 *
 * INTEGRACIÓN EN index.js (3 cambios mínimos):
 *   1) En agentBaseUrl(agent) agregar:
 *        case 'multiia': return (process.env.TOOL_URL || 'https://lti-ai-grader-jubc.onrender.com') + '/multiia'
 *   2) Justo ANTES de lti.deploy(...):  require('./multiia').mount(lti)
 *   3) En Render → Environment, agregar OPENROUTER_API_KEY (y opcionalmente
 *      MULTIIA_ALLOWED_PREFIXES y MULTIIA_FRAME_ANCESTORS).
 *
 * La actividad en Moodle es una "Herramienta externa" (AI Grader) con
 * Parámetro personalizado:  agent=multiia
 * =====================================================================
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OPENROUTER = 'https://openrouter.ai/api/v1';

// Mismo system prompt que el prototipo: fuerza referencias y prohíbe inventarlas.
const SYSTEM_PROMPT =
  'Eres un asistente de apoyo para profesionales de la salud de habla hispana. ' +
  'Responde en español claro y estructurado. Sé preciso y prudente: si algo es incierto, dilo. ' +
  'Recuerda que la decisión clínica es del profesional. ' +
  'Respalda SIEMPRE tu respuesta con referencias o fuentes (guías clínicas, estudios, autor y año) e ' +
  'inclúyelas al final en una lista bajo el título "Referencias". ' +
  'MUY IMPORTANTE: no inventes datos, cifras ni citas. Si no estás seguro de una referencia exacta ' +
  '(autor, año, revista o DOI), NO la inventes: dilo explícitamente e indica que debe verificarse en la ' +
  'fuente primaria. Es preferible admitir que no recuerdas la cita que fabricar una.';

// Prefijos de modelo permitidos (evita que alguien pida modelos caros arbitrarios).
const ALLOWED_PREFIXES = (process.env.MULTIIA_ALLOWED_PREFIXES ||
  'anthropic/,openai/,google/,deepseek/').split(',').map(s => s.trim()).filter(Boolean);

// Dominios que pueden embeber la página en un iframe (Moodle).
const FRAME_ANCESTORS = process.env.MULTIIA_FRAME_ANCESTORS ||
  "'self' https://campusdepruebas.org https://*.campusdepruebas.org";

/* ---------- token HMAC (paridad exacta con Render/_seguridad_token.gs) ---------- */
function b64url (buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode (s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
// Solo para pruebas / paridad; en producción el token lo mintea redirectToAgent de index.js.
function mintAgentToken (payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}
function verifyAgentToken (t, expectedEx) {
  try {
    const secret = process.env.AGENT_SECRET;
    if (!secret) return { ok: false, reason: 'sin-secreto' };
    if (!t || String(t).indexOf('.') < 0) return { ok: false, reason: 'formato' };
    const parts = String(t).split('.');
    const body = parts[0], sig = parts[1];
    const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    // comparación en tiempo constante
    const a = Buffer.from(expected), b = Buffer.from(String(sig || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'firma' };
    const p = JSON.parse(b64urlDecode(body));
    const now = Math.floor(Date.now() / 1000);
    if (!p.exp || p.exp < now) return { ok: false, reason: 'vencido' };
    if (expectedEx && p.ex !== expectedEx) return { ok: false, reason: 'agente' };
    return { ok: true, uid: p.uid, name: p.name || '', email: p.email || '', ex: p.ex };
  } catch (e) { return { ok: false, reason: 'error:' + e.message }; }
}

function getToken (req) {
  return (req.query && req.query.t) ||
         (req.body && req.body.t) ||
         (req.headers && req.headers['x-agent-token']) || '';
}
function modelAllowed (id) {
  return typeof id === 'string' && ALLOWED_PREFIXES.some(p => id.startsWith(p));
}
async function callOpenRouter (pathname, opts) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Falta OPENROUTER_API_KEY en el servidor.');
  const base = {
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.TOOL_URL || 'https://lti-ai-grader-jubc.onrender.com',
    'X-Title': 'Multi-IA Curso IA para medicos'
  };
  return fetch(OPENROUTER + pathname, Object.assign({}, opts, {
    headers: Object.assign(base, (opts && opts.headers) || {})
  }));
}
function accessDenied (reason) {
  return '<!doctype html><meta charset="utf-8">' +
    '<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:48px auto;' +
    'padding:24px;border:1px solid #e0b4b4;background:#fff6f6;border-radius:10px;color:#7a2b2b">' +
    '<h2 style="margin-top:0">Acceso no autorizado</h2>' +
    '<p>Esta actividad debe abrirse desde el aula del curso en Moodle. ' +
    'El enlace directo no funciona por seguridad.</p>' +
    '<p style="color:#b99;font-size:12px;margin-top:20px">ref: ' + reason + '</p></div>';
}

/* ---------- handlers (exportados para poder testearlos aparte) ---------- */
function framing (res) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors ' + FRAME_ANCESTORS);
}

function pageHandler (req, res) {
  const v = verifyAgentToken(getToken(req), 'multiia');
  if (!v.ok) { framing(res); return res.status(403).type('html').send(accessDenied(v.reason)); }
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'multiia.html'), 'utf8'); }
  catch (e) { return res.status(500).send('Falta multiia.html en el servidor.'); }
  framing(res);
  res.type('html').send(html);
}

async function modelsHandler (req, res) {
  const v = verifyAgentToken(getToken(req), 'multiia');
  if (!v.ok) return res.status(403).json({ error: 'no-autorizado', reason: v.reason });
  try {
    const r = await callOpenRouter('/models', { method: 'GET' });
    const j = await r.json();
    const data = (j.data || []).filter(m => modelAllowed(m.id));
    res.json({ data });
  } catch (e) { res.status(502).json({ error: 'openrouter', message: e.message }); }
}

async function chatHandler (req, res) {
  const v = verifyAgentToken(getToken(req), 'multiia');
  if (!v.ok) return res.status(403).json({ error: 'no-autorizado', reason: v.reason });
  const model = ((req.body && req.body.model) || '').toString();
  const question = ((req.body && req.body.question) || '').toString().slice(0, 6000);
  if (!model || !question) return res.status(400).json({ error: 'faltan-datos' });
  if (!modelAllowed(model)) return res.status(400).json({ error: 'modelo-no-permitido' });
  try {
    const r = await callOpenRouter('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question }
        ]
      })
    });
    const raw = await r.text();
    if (!r.ok) {
      let detail = raw;
      try { detail = JSON.parse(raw).error?.message || raw; } catch (_) {}
      return res.status(r.status).json({ error: 'openrouter', detail: String(detail).slice(0, 500) });
    }
    const data = JSON.parse(raw);
    res.json({
      text: data.choices?.[0]?.message?.content ?? '(sin contenido)',
      usage: data.usage || null
    });
  } catch (e) { res.status(502).json({ error: 'proxy', message: e.message }); }
}

/* ---------- montaje sobre ltijs ---------- */
function mount (lti) {
  const express = require('express');
  const app = lti.app;
  // permitir estas rutas sin ltik (nuestro token HMAC las protege)
  lti.whitelist(
    { route: '/multiia', method: 'get' },
    { route: '/api/multiia/models', method: 'get' },
    { route: '/api/multiia/chat', method: 'post' }
  );
  app.get('/multiia', pageHandler);
  app.get('/api/multiia/models', modelsHandler);
  app.post('/api/multiia/chat', express.json({ limit: '32kb' }), chatHandler);
}

module.exports = {
  mount,
  verifyAgentToken, mintAgentToken,
  pageHandler, modelsHandler, chatHandler,
  SYSTEM_PROMPT,
  _internals: { b64url, b64urlDecode, modelAllowed, getToken, ALLOWED_PREFIXES }
};
