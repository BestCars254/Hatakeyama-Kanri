import { getStore } from '@netlify/blobs';
import { handle } from '../lib/core.mjs';

const MAX_BODY = 2.5 * 1024 * 1024; // 写真1枚（端末で縮小済み）を送れる大きさ

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// 本番以外（デプロイプレビュー等）は別の保存領域を使い、本番のお客様データに触れない
const storeName = (context) => {
  const ctx = (context && context.deploy && context.deploy.context) || process.env.CONTEXT || 'production';
  return ctx === 'production' ? 'kanri' : 'kanri-' + ctx.replace(/[^a-z0-9-]/gi, '-');
};

export default async (req, context) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'bad_request' }, 405);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'bad_request' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return json({ ok: false, error: 'bad_request' }, 400); }

  const out = await handle(body, {
    store: getStore({ name: storeName(context), consistency: 'strong' }),
    env: { APP_PASSWORD: process.env.APP_PASSWORD, TOKEN_SECRET: process.env.TOKEN_SECRET },
  });
  return json(out);
};

export const config = { path: '/api' };
