const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {Spotify, SpotifyApiError, SpotifyError} = require('spdl');
const undici = require('undici');
test('legacy package entry loads in CommonJS and ESM',async()=>{
  assert.equal(typeof require('spdl').Spotify,'function');
  assert.equal(typeof (await import('spdl')).Spotify,'function');
});
test('original cookie login accepts the current seed feed and does not leak cookies to it',async()=>{
  const agent=new undici.MockAgent(); agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher(); undici.setGlobalDispatcher(agent);
  try {
    agent.get('https://git.gay').intercept({path:'/thereallo/totp-secrets/raw/branch/main/secrets/secrets.json',method:'GET',headers:headers=>!headers.cookie}).reply(200,[{version:59,secret:'older'},{version:61,secret:'current'}]);
    const spotify=agent.get('https://open.spotify.com');
    spotify.intercept({path:'/api/server-time/',method:'GET',headers:headers=>!headers.cookie}).reply(200,{serverTime:Math.floor(Date.now()/1000)});
    spotify.intercept({path:path=>path.startsWith('/api/token/')&&path.includes('totpVer=61'),method:'GET',headers:{cookie:'sp_dc=fixture-cookie'}}).reply(200,{isAnonymous:false,accessToken:'fixture-token',accessTokenExpirationTimestampMs:Date.now()+3600000});
    const client=await Spotify.create({cookie:'sp_dc=fixture-cookie'});
    assert.equal(client.accessToken,'fixture-token');
    agent.assertNoPendingInterceptors();
  } finally {undici.setGlobalDispatcher(previous);await agent.close();}
});
const id='0123456789abcdefghijkl';
const item=uid=>({uid,itemV2:{data:{__typename:'Track',uri:'spotify:track:'+id,name:'Song',artists:{items:[{profile:{name:'Artist'}}]},albumOfTrack:{name:'Album',coverArt:{sources:[]}},trackDuration:{totalMilliseconds:1000},playability:{playable:true}}}});
const page=(items,offset=0,total=3,revision='snapshot')=>({data:{playlistV2:{uri:'spotify:playlist:'+id,revisionId:revision,name:'Playlist',content:{items,totalCount:total,pagingInfo:{offset}}}}});
test('original playlist get discovers its query and preserves duplicates across complete pages',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try {
    agent.get('https://open.spotify.com').intercept({path:'/',method:'GET',headers:headers=>!headers.authorization}).reply(200,'https://open.spotifycdn.com/cdn/build/web-player/web-player.abcdef12.js');
    agent.get('https://open.spotifycdn.com').intercept({path:'/cdn/build/web-player/web-player.abcdef12.js',method:'GET'}).reply(200,require('node:zlib').gzipSync(`new Query("fetchPlaylist","query","${'a'.repeat(64)}",null)`),{headers:{'content-encoding':'gzip'}});
    const query=agent.get('https://api-partner.spotify.com');
    query.intercept({path:'/pathfinder/v2/query',method:'POST',headers:{authorization:'Bearer fixture-token'}}).reply(200,page([item('one'),item('two')]));
    query.intercept({path:'/pathfinder/v2/query',method:'POST',body:body=>JSON.parse(body).variables.offset===2}).reply(200,page([{uid:'three',itemV2:{data:null}}],2));
    query.intercept({path:'/pathfinder/v2/query',method:'POST',body:body=>JSON.parse(body).variables.limit===1}).reply(200,page([item('one')]));
    const client=new Spotify({accessToken:'fixture-token'});
    const playlist=await client.playlists.get(id);
    assert.deepEqual(playlist.tracks.map(track=>track.id),[id,id,'']);
    assert.equal(playlist.tracks[2].isPlayable,false);
    assert.equal(playlist.tracks[0].artists[0].name,'Artist');
    assert.equal(playlist.snapshotId,'snapshot');
    agent.assertNoPendingInterceptors();
  } finally {undici.setGlobalDispatcher(previous);await agent.close();}
});
test('original playlist get refuses changing and incomplete snapshots',async()=>{
  for (const response of [page([],1),page([item('two'),item('three')],1,3,'changed')]) {
    const client=new Spotify({accessToken:'fixture-token'});
    client.playlists.queryHash=async()=> 'a'.repeat(64);
    const responses=[page([item('one')]),response];
    client.request=async()=>responses.shift();
    await assert.rejects(client.playlists.get(id),SpotifyError);
  }
});
test('original playlist get retries a rejected query only once',async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const refreshed=[];client.playlists.queryHash=async force=>{refreshed.push(force);return 'a'.repeat(64);};
  const responses=[{errors:[{message:'PersistedQueryNotFound'}]},page([],0,0)];
  client.request=async()=>responses.shift();
  assert.equal((await client.playlists.get(id)).tracks.length,0);
  assert.deepEqual(refreshed,[undefined,true]);
  let calls=0;client.request=async()=>{calls++;return {errors:[{message:'PersistedQueryNotFound'}]};};
  await assert.rejects(client.playlists.get(id),SpotifyError);
  assert.equal(calls,2);
});
test('original request exposes provider status and Retry-After without returning an error as metadata',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try {
    agent.get('https://api-partner.spotify.com').intercept({path:'/pathfinder/v2/query',method:'POST'}).reply(429,{error:{message:'rate limited'}},{headers:{'retry-after':'40'}});
    const client=new Spotify({accessToken:'fixture-token'});
    await assert.rejects(client.request('https://api-partner.spotify.com/pathfinder/v2/query',{}),error=>error instanceof SpotifyApiError&&error.statusCode===429&&error.retryAfter==='40');
  } finally {undici.setGlobalDispatcher(previous);await agent.close();}
});
test('package entry loads outside the repository working directory',()=>{
  const entry=require.resolve('spdl');
  const esm=require('node:url').pathToFileURL(require('node:path').join(require('node:path').dirname(entry),'index.js')).href;
  execFileSync(process.execPath,['-e', "import("+JSON.stringify(esm)+").then(m=>require(\"node:assert/strict\").equal(typeof m.Spotify,\"function\"));"],{cwd:require('node:os').tmpdir(),stdio:'pipe'});
  execFileSync(process.execPath,['-e',`const assert=require('node:assert/strict'); assert.equal(typeof require(${JSON.stringify(entry)}).Spotify,'function');`],{cwd:require('node:os').tmpdir(),stdio:'pipe'});
});
