import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, publicAccount, trustedAuthUrl } from '../src/api.js';
import { run, type Dependencies } from '../src/cli.js';
import { Store } from '../src/store.js';
import type { Account } from '../src/types.js';

const account: Account = {
  id: 'test-user', email: 'test@example.com', emailVerified: true,
  changePasswordUrl: 'https://auth.zenid.jp/change?ticket=secret-ticket',
  memberships: [
    { id: 1, accountId: 'test-user', organization: { id: 1, name: 'school', displayName: '学校' }, joinedAt: 1, leftAt: null, profile: { specVersion: 1, fields: [] }, roleAssignings: [] },
    { id: 2, accountId: 'test-user', organization: { id: 2, name: 'previous', displayName: '以前の学校' }, joinedAt: 1, leftAt: 2, profile: { specVersion: 1, fields: [] }, roleAssignings: [] },
  ],
};
function harness(respond?: (url: string, init: RequestInit) => Response) {
  const requests: { path: string; init: RequestInit }[] = [];
  const api = new Api('secret-token', async (input, init) => {
    const url = String(input); requests.push({ path: new URL(url).pathname, init: init! });
    return respond ? respond(url, init!) : Response.json(url.endsWith('/accounts') && init?.method === 'GET' ? account : url.endsWith('/authentication-methods') ? [{ id: 'phone|test', type: 'phone', createdAt: 1 }] : {});
  });
  const out: string[] = [], err: string[] = [], opened: string[] = [];
  const deps: Dependencies = {
    store: new Store('/unused'), api: async () => api, login: async () => ({ authenticated: true }), logout: async () => ({ authenticated: false }),
    open: async url => { opened.push(url); }, mfa: async (_, id) => ({ completed: true, reset: id }),
    interactive: false, confirm: async () => false, out: value => out.push(value), err: value => err.push(value),
  };
  return { requests, api, deps, out, err, opened };
}
test('read commands produce JSON and never expose the password ticket or token', async () => {
  for (const args of [['account', 'show'], ['memberships', 'list'], ['memberships', 'list', '--past'], ['auth', 'status'], ['mfa', 'list']]) {
    const h = harness(); assert.equal(await run([...args, '--json'], h.deps), 0);
    assert.doesNotThrow(() => JSON.parse(h.out[0]));
    assert.doesNotMatch(h.out.join(''), /secret-token|secret-ticket|changePasswordUrl/);
    assert.equal(h.requests[0].init.method, 'GET');
    assert.equal(new Headers(h.requests[0].init.headers).get('authorization'), 'Bearer secret-token');
    if (args[0] === 'memberships') assert.equal(JSON.parse(h.out[0])[0].id, args.includes('--past') ? 2 : 1);
  }
  assert.equal('changePasswordUrl' in publicAccount(account), false);
});
test('email commands use the observed method/path/body exactly once', async () => {
  const h = harness();
  assert.equal(await run(['email', 'set', 'new@example.com', '--yes', '--json'], h.deps), 0);
  assert.equal(await run(['email', 'verify', '--yes'], h.deps), 0);
  assert.deepEqual(h.requests.map(r => [r.init.method, r.path, r.init.body]), [
    ['PUT', '/accounts', '{"email":"new@example.com"}'], ['POST', '/verify-email', undefined],
  ]);
});
test('confirmation refusal, non-interactive execution, and invalid email never send requests', async () => {
  for (const interactive of [false, true]) {
    const h = harness(); h.deps.interactive = interactive;
    for (const args of [['email', 'set', 'a@example.com'], ['email', 'verify'], ['mfa', 'enroll'], ['mfa', 'reset', 'test']]) assert.equal(await run(args, h.deps), 1);
    assert.equal(h.requests.length, 0);
  }
  const h = harness();
  for (const email of ['bad', 'a@nnn.ed.jp', 'a@student.zen.ac.jp']) assert.equal(await run(['email', 'set', email, '-y'], h.deps), 1);
  assert.equal(h.requests.length, 0);
});
test('password URL opens without leaking its ticket in JSON', async () => {
  const h = harness(); assert.equal(await run(['password', 'change', '--json'], h.deps), 0);
  assert.deepEqual(h.opened, [account.changePasswordUrl]); assert.doesNotMatch(h.out.join(''), /secret-ticket/);
});
test('HTTP errors are distinct, redacted and never retried', async () => {
  const codes = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 409: 'CONFLICT', 429: 'RATE_LIMITED', 500: 'API_ERROR' };
  for (const [status, code] of Object.entries(codes)) {
    const h = harness(() => new Response('secret-token secret-ticket', { status: Number(status) }));
    assert.equal(await run(['email', 'verify', '-y', '--json'], h.deps), 1);
    assert.equal(h.requests.length, 1); assert.equal(JSON.parse(h.err[0]).error.code, code);
    assert.equal(h.out.length, 0); assert.doesNotMatch(h.err.join(''), /secret-token|secret-ticket/);
  }
});
test('auth URLs reject other origins, credentials, and unsafe protocols', () => {
  for (const url of ['http://auth.zenid.jp/a', 'https://evil.example/a', 'javascript:alert(1)', 'https://u:p@auth.zenid.jp/a', null]) assert.throws(() => trustedAuthUrl(url));
});
test('MFA API encodes IDs and preserves Location without following redirects', async () => {
  const h = harness(() => new Response(null, { status: 201, headers: { Location: 'https://auth.zenid.jp/enroll?ticket=private' } }));
  assert.match(await h.api.enrollment(), /^https:\/\/auth.zenid.jp/);
  await h.api.deleteMethod('phone|a/b');
  assert.deepEqual(h.requests.map(r => [r.init.method, r.path]), [['POST', '/authentication-method-enrollments'], ['DELETE', '/authentication-methods/phone%7Ca%2Fb']]);
  assert.equal(h.requests[0].init.redirect, 'manual');
});
test('login/logout and MFA CLI actions propagate results and selected ID', async () => {
  for (const args of [['login'], ['logout'], ['mfa', 'enroll', '-y'], ['mfa', 'reset', 'phone|test', '-y']]) {
    const h = harness(); assert.equal(await run([...args, '--json'], h.deps), 0);
    const result = JSON.parse(h.out[0]);
    if (args[1] === 'reset') assert.equal(result.reset, 'phone|test');
  }
});
test('transport exceptions are redacted and issued once', async () => {
  let count = 0;
  const api = new Api('secret', async () => { count++; throw new Error('secret'); });
  await assert.rejects(api.verifyEmail(), { code: 'NETWORK' }); assert.equal(count, 1);
});
test('malformed successful responses cannot count as a valid login or MFA enrollment', async () => {
  const api = new Api('token', async () => Response.json({ unexpected: true }));
  await assert.rejects(api.account(), { code: 'INVALID_RESPONSE' });
  await assert.rejects(api.methods(), { code: 'INVALID_RESPONSE' });
});
