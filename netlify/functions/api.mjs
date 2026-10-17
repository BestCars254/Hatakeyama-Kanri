import { getStore } from '@netlify/blobs';
import { handle } from '../lib/core.mjs';

const MAX_BODY = 200 * 1024;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'bad_request' }, 405);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'bad_request' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return json({ ok: false, error: 'bad_request' }, 400); }

  const out = await handle(body, {
    store: getStore({ name: 'kanri', consistency: 'strong' }),
    env: { APP_PASSWORD: process.env.APP_PASSWORD, TOKEN_SECRET: process.env.TOKEN_SECRET },
  });
  return json(out);
};

export const config = { path: '/api' };
