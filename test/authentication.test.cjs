const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Spotify, SpotifyAuthError, SpotifyApiError} = require('spdl');
const undici = require('undici');

test('cookie rejection redirects require reconnection without following the redirect', async () => {
  const cases = [
    [302, '/api/token/?_authfailed=private-detail', true],
    [307, 'https://open.spotify.com/api/token/?_authfailed=private-detail', true],
    [302, 'https://example.com/api/token/?_authfailed=private-detail', false],
    [302, '/other/?_authfailed=private-detail', false],
    [302, '/api/token/?unrelated=true', false],
    [429, undefined, false],
    [401, undefined, false],
  ];
  for (const [status, location, rejected] of cases) {
    const agent = new undici.MockAgent(); agent.disableNetConnect();
    const previous = undici.getGlobalDispatcher(); undici.setGlobalDispatcher(agent);
    try {
      agent.get('https://git.gay').intercept({path:'/thereallo/totp-secrets/raw/branch/main/secrets/secrets.json', method:'GET'}).reply(200, [{version:61,secret:'fixture'}]);
      const pool = agent.get('https://open.spotify.com');
      pool.intercept({path:'/api/server-time/',method:'GET'}).reply(200,{serverTime:Math.floor(Date.now()/1000)});
      pool.intercept({path:value=>value.startsWith('/api/token/'),method:'GET'}).reply(status,'',{headers:{...(location ? {location} : {}), 'retry-after':'58'}});
      const client = new Spotify({cookie:'sp_dc=fixture-cookie'});
      await assert.rejects(client.refreshToken(), error => {
        assert.equal(error.message.includes('private-detail'), false);
        assert.equal(error.message.includes('fixture-cookie'), false);
        if (rejected) assert.ok(error instanceof SpotifyAuthError);
        else {
          assert.ok(error instanceof SpotifyApiError);
          assert.equal(error.statusCode,status);
          assert.equal(error.retryAfter,'58');
        }
        return true;
      });
      agent.assertNoPendingInterceptors();
    } finally {undici.setGlobalDispatcher(previous); await agent.close();}
  }
});
