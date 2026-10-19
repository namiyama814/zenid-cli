import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { waitForToken, cancellation } from '../src/browser.js';
import { Store, credentialFor } from '../src/store.js';
import { Api } from '../src/api.js';
import { enroll, waitForEnrollment } from '../src/mfa.js';

function request(context: EventEmitter, token = 'test-token', url = 'https://mypage-api.zenid.jp/accounts') {
  context.emit('request', { url: () => url, headers: () => ({ authorization: `Bearer ${token}` }) });
}
test('login only accepts validated tokens from the account API and removes listeners', async () => {
  const context = new EventEmitter(); const validated: string[] = [];
  const result = waitForToken(context as BrowserContext, new AbortController().signal, async token => {
    validated.push(token); if (token === 'invalid') throw new Error();
  });
  request(context, 'ignore', 'https://other.example/accounts'); request(context, 'invalid');
  await new Promise(resolve => setImmediate(resolve)); request(context, 'valid');
  assert.equal(await result, 'valid'); assert.deepEqual(validated, ['invalid', 'valid']);
  assert.equal(context.listenerCount('request'), 0); assert.equal(context.listenerCount('close'), 0);
});
test('login rejects browser close, cancellation and timeout', async () => {
  for (const mode of ['close', 'cancel', 'timeout']) {
    const context = new EventEmitter(), parent = new AbortController();
    const lifecycle = cancellation(parent.signal, mode === 'timeout' ? 5 : 1000);
    const result = waitForToken(context as BrowserContext, lifecycle.signal);
    const check = assert.rejects(result, error => error instanceof Error);
    if (mode === 'close') context.emit('close');
    if (mode === 'cancel') parent.abort(new Error('cancel'));
    await check; lifecycle.dispose(); assert.equal(context.listenerCount('request'), 0);
  }
});
test('credentials are private, expire correctly, and profile lock prevents overlapping operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zenid-test-')); const store = new Store(dir);
  try {
    assert.equal(await store.read(), null);
    await store.save({ token: 'secret', expiresAt: Date.now() + 100_000 });
    assert.equal(await store.token(), 'secret');
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o777, 0o600);
    await store.locked(async () => { await assert.rejects(store.locked(async () => {}), { code: 'LOCKED' }); });
    await store.save({ token: 'expired', expiresAt: Date.now() - 1 });
    await assert.rejects(store.token(), { code: 'UNAUTHENTICATED' });
    await store.clear(); assert.equal(await store.read(), null);
    await assert.rejects(readFile(join(dir, 'browser.lock')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('JWT expiration extraction and opaque tokens', () => {
  const token = `a.${Buffer.from(JSON.stringify({ exp: 123 })).toString('base64url')}.b`;
  assert.equal(credentialFor(token).expiresAt, 123000); assert.equal(credentialFor('opaque').expiresAt, null);
});
function mfaApi(failure?: 'location' | 'delete') {
  const calls: string[] = []; let reads = 0;
  const api = new Api('token', async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`);
    if (init?.method === 'GET') return Response.json(reads++ ? [{ id: 'new', type: 'phone', createdAt: 2 }] : [{ id: 'old', type: 'phone', createdAt: 1 }]);
    if (init?.method === 'POST') return new Response(null, { status: 201, headers: failure === 'location' ? {} : { Location: 'https://auth.zenid.jp/enroll' } });
    return new Response(null, { status: failure === 'delete' ? 500 : 204 });
  });
  return { api, calls };
}
test('MFA reset obtains URL before deleting and waits for a new method', async () => {
  const h = mfaApi();
  const result = await enroll(h.api, async () => { h.calls.push('navigate'); }, new AbortController().signal, 'old');
  assert.equal(result.completed, true);
  assert.deepEqual(h.calls, ['GET /authentication-methods', 'POST /authentication-method-enrollments', 'DELETE /authentication-methods/old', 'navigate', 'GET /authentication-methods']);
});
test('MFA validates target and Location before deletion; delete failure never navigates', async () => {
  for (const failure of ['location', 'delete'] as const) {
    const h = mfaApi(failure); let opened = false;
    await assert.rejects(enroll(h.api, async () => { opened = true; }, new AbortController().signal, 'old'));
    assert.equal(opened, false); if (failure === 'location') assert.equal(h.calls.length, 2);
  }
  const h = mfaApi(); await assert.rejects(enroll(h.api, async () => {}, new AbortController().signal, 'missing'), { code: 'NOT_FOUND' });
  assert.equal(h.calls.length, 1);
});
test('MFA partial failure explicitly reports that deletion already happened', async () => {
  const h = mfaApi();
  await assert.rejects(enroll(h.api, async () => { throw new Error(); }, new AbortController().signal, 'old'), { code: 'MFA_INCOMPLETE' });
});
test('MFA does not consider existing methods a successful enrollment', async () => {
  const controller = new AbortController(); let reads = 0;
  const result = waitForEnrollment({ methods: async () => { reads++; return [{ id: 'old', type: 'phone', createdAt: 1 }]; } }, new Set(['old']), controller.signal, async () => { controller.abort(new Error('cancel')); });
  await assert.rejects(result, /cancel/); assert.equal(reads, 1);
});
test('MFA cancellation during an API read never reports success', async () => {
  const controller = new AbortController();
  await assert.rejects(waitForEnrollment({ methods: async () => {
    controller.abort(new Error('closed'));
    return [{ id: 'new', type: 'phone', createdAt: 1 }];
  } }, new Set(), controller.signal), /closed/);
});
test('MFA first enrollment opens the returned URL and verifies the new method', async () => {
  let reads = 0; const calls: string[] = [];
  const api = new Api('token', async (input, init) => {
    calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
    if (init?.method === 'GET') return Response.json(reads++ ? [{ id: 'new', type: 'phone', createdAt: 1 }] : []);
    return new Response(null, { status: 201, headers: { Location: 'https://auth.zenid.jp/enroll' } });
  });
  const result = await enroll(api, async () => { calls.push('navigate'); }, new AbortController().signal);
  assert.equal(result.completed, true);
  assert.deepEqual(calls, ['GET /authentication-methods', 'POST /authentication-method-enrollments', 'navigate', 'GET /authentication-methods']);
});
