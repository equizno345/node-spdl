const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {Spotify, SpotifyApiError, SpotifyError} = require('spdl');
const undici = require('undici');
const protobuf = require('protobufjs');
const audioProtocol = protobuf.parse(`syntax = "proto3";
message Any {string type_url=1;bytes value=2;}
message Header {int32 status_code=1;}
message Entry {Header header=1;string entity_uri=2;Any extension_data=3;}
message Extension {int32 extension_kind=2;repeated Entry extension_data=3;}
message Batch {repeated Extension extended_metadata=2;}
message File {bytes file_id=1;int32 format=2;}
message ExtendedFile {File file=1;}
message Files {repeated ExtendedFile files=1;}
message Query {int32 extension_kind=1;}
message EntityRequest {string entity_uri=1;repeated Query query=2;}
message Request {repeated EntityRequest entity_request=2;}
`).root;
test('PlayPlay uses the configured provider for both the request token and key operation without logging keys',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  const fileId='a'.repeat(40),token=Buffer.alloc(16,7),obfuscated=Buffer.alloc(16,8),key=Buffer.alloc(16,9);
  const proto=protobuf.parse('syntax="proto3";message Request{int32 version=1;bytes token=2;}message Response{bytes obfuscated_key=1;}').root;
  const originalLog=console.log;const logs=[];console.log=(...args)=>logs.push(args);
  try{
    const provider={token,deobfuscateKey(actualFile,actualKey){assert.equal(this,provider);assert.deepEqual(actualFile,Buffer.from(fileId,'hex'));assert.deepEqual(actualKey,obfuscated);return key;}};
    const client=new Spotify({accessToken:'fixture-token',unplayplay:provider});
    agent.get('https://spclient.wg.spotify.com').intercept({path:'/playplay/v1/key/'+fileId,method:'POST',body:body=>{
      const decoded=proto.lookupType('Request').decode(Buffer.from(body));return decoded.version===2 && Buffer.from(decoded.token).equals(token);
    }}).reply(200,Buffer.from(proto.lookupType('Response').encode({obfuscatedKey:obfuscated}).finish()));
    assert.deepEqual(await client.playplay.getKey(fileId,1),key);
    assert.deepEqual(logs,[]);agent.assertNoPendingInterceptors();
  }finally{console.log=originalLog;undici.setGlobalDispatcher(previous);await agent.close();}
});
test('PlayPlay preserves HTTP status, opaque provider code and Retry-After without guessing a Premium requirement',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({accessToken:'fixture-token'});
    client.user.isPremium=async()=>{throw new Error('License errors must not request account metadata');};
    agent.get('https://spclient.wg.spotify.com').intercept({path:'/playplay/v1/key/'+ 'a'.repeat(40),method:'POST'}).reply(403,Buffer.from([8,3]));
    await assert.rejects(client.playplay.getKey('a'.repeat(40),1),error=>error instanceof SpotifyApiError && error.statusCode===403 && error.providerCode===3 && !error.message.includes('token invalid'));
    agent.get('https://spclient.wg.spotify.com').intercept({path:'/playplay/v1/key/'+ 'a'.repeat(40),method:'POST'}).reply(429,Buffer.from([8,7]),{headers:{'retry-after':'58'}});
    await assert.rejects(client.playplay.getKey('a'.repeat(40),1),error=>error.statusCode===429 && error.retryAfter==='58');
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});
test('PlayPlay rejects missing keys and malformed provider results before downstream decryption',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const provider={token:Buffer.alloc(16),deobfuscateKey(){return Buffer.alloc(0);}};
    const client=new Spotify({accessToken:'fixture-token',unplayplay:provider});
    const pool=agent.get('https://spclient.wg.spotify.com');
    pool.intercept({path:'/playplay/v1/key/'+ 'a'.repeat(40),method:'POST'}).reply(200,Buffer.alloc(0));
    await assert.rejects(client.playplay.getKey('a'.repeat(40),1),/No PlayPlay key/);
    pool.intercept({path:'/playplay/v1/key/'+ 'a'.repeat(40),method:'POST'}).reply(200,Buffer.from([10,1,1]));
    await assert.rejects(client.playplay.getKey('a'.repeat(40),1),/invalid audio key/);
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});
test('audio metadata keeps legacy files and tolerates missing previews and alternatives',async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const file={file_id:'a'.repeat(40),format:'OGG_VORBIS_160'};
  for(const payload of [{file:[file]},{alternative:[{}, {file:[file]}]}, {file:[],alternative:[{file:[file]}]},{}]){
    client.request=async()=>({gid:'0'.repeat(32),name:'Track',...payload});
    const metadata=await client.tracks.getMetadata('0'.repeat(32));
    assert.deepEqual(metadata.preview,[]);
    assert.equal(metadata.files.length,Object.keys(payload).length?1:0);
  }
});
test('new audio metadata resolves authenticated AUDIO_FILES protobuf without inventing IDs',async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const gid='0'.repeat(31)+'1',uri='spotify:track:'+'0'.repeat(21)+'1';
  const files=audioProtocol.lookupType('Files').encode({files:[{file:{fileId:Buffer.alloc(20,1),format:1}}]}).finish();
  const response=(status=200,entityUri=uri)=>audioProtocol.lookupType('Batch').encode({extendedMetadata:[{extensionKind:5,extensionData:[{header:{statusCode:status},entityUri,extensionData:{typeUrl:'type.googleapis.com/spotify.extendedmetadata.audiofiles.AudioFilesExtensionResponse',value:files}}]}]}).finish();
  let reply=response();
  client.request=async(endpoint,body,options)=>{
    if(endpoint.includes('/metadata/4/track/'))return {gid,name:'Track',audio_formats:[{original_audio:{uuid:'original-uuid',format:'AUDIO_FORMAT_STEREO'}}]};
    assert.equal(endpoint,require('spdl').Endpoints.EXTENDED_METADATA);
    assert.equal(options.protobuf,true);
    const request=audioProtocol.lookupType('Request').decode(body);
    assert.equal(request.entityRequest[0].entityUri,uri);
    assert.equal(request.entityRequest[0].query[0].extensionKind,5);
    return reply;
  };
  const metadata=await client.tracks.getMetadata(gid);
  assert.deepEqual(metadata.files,[{fileId:'01'.repeat(20),format:'OGG_VORBIS_160'}]);
  assert.deepEqual(metadata.preview,[]);
  reply=response(403);await assert.rejects(client.tracks.getMetadata(gid),error=>error instanceof SpotifyApiError && error.statusCode===403);
  reply=response(200,'spotify:track:another');await assert.rejects(client.tracks.getMetadata(gid),SpotifyError);
  reply=Buffer.from([255]);await assert.rejects(client.tracks.getMetadata(gid),SpotifyError);
});
test('protobuf requests preserve authorization, binary bodies, and genuine HTTP throttling',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    agent.get('https://spclient.wg.spotify.com').intercept({path:'/extended-metadata/v0/extended-metadata',method:'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/x-protobuf',accept:'application/x-protobuf'}}).reply(200,Buffer.from([1,2,3]));
    const client=new Spotify({accessToken:'fixture-token'});
    assert.deepEqual(await client.request(require('spdl').Endpoints.EXTENDED_METADATA,Buffer.from([1]),{protobuf:true}),Buffer.from([1,2,3]));
    agent.get('https://spclient.wg.spotify.com').intercept({path:'/extended-metadata/v0/extended-metadata',method:'POST'}).reply(429,'',{headers:{'retry-after':'58'}});
    await assert.rejects(client.request(require('spdl').Endpoints.EXTENDED_METADATA,Buffer.from([1]),{protobuf:true}),error=>error.statusCode===429 && error.retryAfter==='58');
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});
test('account metadata uses authenticated web-player queries and keeps the public user shape', async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const operations=[];
  client.playlists.queryHash=async(force,operation)=>{operations.push(operation);return 'c'.repeat(64);};
  client.request=async(endpoint,body)=>{
    assert.equal(endpoint,require('spdl').Endpoints.QUERY);
    assert.deepEqual(body.variables,{});
    return {data:{me:body.operationName==='accountAttributes'?{account:{product:'PREMIUM',country:'US',attributes:{}}}:{profile:{username:'fixture-user',uri:'spotify:user:fixture-user',name:'Fixture',avatar:{sources:[]}}}}};
  };
  const me=await client.user.me();
  assert.equal(me.id,'fixture-user');assert.equal(me.product,'premium');assert.equal(me.displayName,'Fixture');
  assert.equal(me.email,'');assert.equal(me.followers,0);
  operations.length=0;
  assert.equal(await client.user.isPremium(),true);
  assert.deepEqual(operations,['accountAttributes']);
  client.request=async()=>({data:{me:{account:{product:'FREE'}}}});
  assert.equal(await client.user.isPremium(),false);
  client.request=async()=>({data:{me:{account:{product:'UNKNOWN'}}}});
  await assert.rejects(client.user.isPremium(),SpotifyError);
});
test('account queries refresh a stale hash once and preserve genuine throttling',async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const refresh=[];client.playlists.queryHash=async(force)=>{refresh.push(force);return 'd'.repeat(64);};
  let count=0;client.request=async()=>++count===1?{errors:[{message:'PersistedQueryNotFound'}]}:{data:{me:{account:{product:'FREE'}}}};
  assert.equal(await client.user.isPremium(),false);assert.deepEqual(refresh,[false,true]);
  const failure=new SpotifyApiError(429,'Spotify metadata request failed','58');
  client.request=async()=>{throw failure;};
  await assert.rejects(client.user.isPremium(),error=>error===failure && error.retryAfter==='58');
});
test('both download entry points forward asynchronous failures into their readable stream',async()=>{
  for(const download of [(client)=>client.download('https://open.spotify.com/track/'+id,{}),
    (client)=>require('spdl').spdl('https://open.spotify.com/track/'+id,{client})]){
    const client=new Spotify({accessToken:'fixture-token'});
    const failure=new SpotifyApiError(429,'Spotify metadata request failed','58');
    client.user.isPremium=async()=>{throw failure;};
    const stream=download(client);
    await assert.rejects(require('node:stream/promises').pipeline(stream,new(require('node:stream').Writable)({write(chunk,encoding,callback){callback();}})),error=>error===failure);
    assert.equal(stream.destroyed,true);
  }
});
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
    spotify.intercept({path:path=>path.startsWith('/api/token/')&&path.includes('totpVer=61'),method:'GET',headers:{cookie:'sp_dc=fixture-cookie'}}).reply(200,{isAnonymous:false,accessToken:'fixture-token',clientId:'fixture-client',accessTokenExpirationTimestampMs:Date.now()+3600000});
    spotify.intercept({path:'/',method:'GET',headers:headers=>!headers.cookie&&!headers.authorization}).reply(200,'<script id="appServerConfig" type="text/plain">'+Buffer.from(JSON.stringify({clientVersion:'1.2.3.test'})).toString('base64')+'</script>');
    agent.get('https://clienttoken.spotify.com').intercept({path:'/v1/clienttoken',method:'POST',body:body=>JSON.parse(body).client_data.client_id==='fixture-client'}).reply(200,{granted_token:{token:'fixture-client-token',refresh_after_seconds:3600}});
    const client=await Spotify.create({cookie:'sp_dc=fixture-cookie'});
    assert.equal(client.accessToken,'fixture-token');
    assert.equal(client.getHeaders()['Client-Token'],'fixture-client-token');
    assert.equal(client.getRawHeaders()['Client-Token'],'fixture-client-token');
    await Promise.all(Array.from({length:8},()=>client.refresh()));
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
test('original track get reads current single-track metadata and retries a stale query once', async()=>{
  const client=new Spotify({accessToken:'fixture-token'});
  const hashes=[];client.playlists.queryHash=async(force,operation)=>{hashes.push({force,operation});return 'b'.repeat(64);};
  const track={__typename:'Track',uri:'spotify:track:'+id,id,name:'Single',firstArtist:{items:[{profile:{name:'First'}}]},otherArtists:{items:[{profile:{name:'Second'}}]},duration:{totalMilliseconds:123000},albumOfTrack:{name:'Album',coverArt:{sources:[]}},playability:{playable:true}};
  let calls=0;client.request=async(endpoint,body)=>{
    assert.equal(body.operationName,'getTrack');assert.equal(body.variables.uri,'spotify:track:'+id);
    calls++;return calls===1?{errors:[{message:'PersistedQueryNotFound'}]}:{data:{trackUnion:track}};
  };
  const result=await client.tracks.get('https://open.spotify.com/track/'+id);
  assert.deepEqual(result.artists.map(a=>a.name),['First','Second']);assert.equal(result.durationMs,123000);assert.equal(result.isPlayable,true);
  assert.deepEqual(hashes,[{force:false,operation:'getTrack'},{force:true,operation:'getTrack'}]);
  client.request=async()=>({data:{trackUnion:{__typename:'NotFound'}}});
  await assert.rejects(client.tracks.get(id),error=>error instanceof SpotifyApiError&&error.statusCode===404);
  client.request=async()=>({data:{trackUnion:{...track,uri:'spotify:track:other'}}});
  await assert.rejects(client.tracks.get(id),SpotifyError);
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

test('client tokens refresh once concurrently, honor expiry, and retain the authenticated client ID',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({accessToken:'access'});client.clientId='authenticated-client';
    const config='<script type="application/json" id="appServerConfig">'+JSON.stringify({clientVersion:'1.3.6.test',clientId:'unrelated-page-client'})+'</script>';
    const page=()=>agent.get('https://open.spotify.com').intercept({path:'/',headers:headers=>!headers.authorization&&!headers.cookie}).reply(200,config);
    const grant=(token,refresh=60,expiry=120)=>agent.get('https://clienttoken.spotify.com').intercept({path:'/v1/clienttoken',method:'POST',body:body=>{
      assert.deepEqual(JSON.parse(body),{client_data:{client_id:'authenticated-client',client_version:'1.3.6.test',js_sdk_data:{}}});return true;
    }}).reply(200,{granted_token:{token,refresh_after_seconds:refresh,expires_after_seconds:expiry}});
    page();grant('first');
    const started=Date.now();await Promise.all(Array.from({length:12},()=>client.refreshClient()));
    assert.equal(client.clientToken,'first');assert.equal(client.clientId,'authenticated-client');
    assert.ok(client.clientExpiration>=started+60000&&client.clientExpiration<=Date.now()+60000);
    await client.refresh();await client.refreshClient();
    client.clientExpiration=0;page();grant('second',120,30);
    await Promise.all([client.refresh(),client.refreshClient()]);
    assert.equal(client.clientToken,'second');assert.ok(client.clientExpiration<=Date.now()+30000);
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('expired cookie access refresh is coalesced and preserves an unexpired matching client token',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({cookie:'sp_dc=offline',clientToken:'existing-client-token'});
    client.accessToken='expired';client.clientId='same-client';
    agent.get('https://git.gay').intercept({path:'/thereallo/totp-secrets/raw/branch/main/secrets/secrets.json'}).reply(200,[{version:61,secret:'offline'}]);
    agent.get('https://open.spotify.com').intercept({path:'/api/server-time/'}).reply(200,{serverTime:Math.floor(Date.now()/1000)});
    agent.get('https://open.spotify.com').intercept({path:path=>path.startsWith('/api/token/'),headers:{cookie:'sp_dc=offline'}}).reply(200,{isAnonymous:false,accessToken:'renewed',clientId:'same-client',accessTokenExpirationTimestampMs:Date.now()+3600000});
    await Promise.all(Array.from({length:12},()=>client.refresh()));
    assert.equal(client.accessToken,'renewed');assert.equal(client.clientToken,'existing-client-token');
    await client.refresh();agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('client token failures preserve status, do not poison the cache, and never retry automatically',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({accessToken:'access'});client.clientId='client';
    for(const response of [null,{granted_token:{token:'invalid',refresh_after_seconds:0}}, {granted_token:{token:'good',refresh_after_seconds:60}}]){
      agent.get('https://open.spotify.com').intercept({path:'/'}).reply(200,'<script id="appServerConfig">{"clientVersion":"1.2.test"}</script>');
      const request=agent.get('https://clienttoken.spotify.com').intercept({path:'/v1/clienttoken',method:'POST'});
      if(response===null){request.reply(429,'private provider response',{headers:{'retry-after':'58'}});await assert.rejects(client.refreshClient(),error=>error.statusCode===429&&error.retryAfter==='58'&&!error.message.includes('private'));}
      else if(response.granted_token.token==='invalid'){request.reply(200,response);await assert.rejects(client.refreshClient(),/valid client token/);}
      else{request.reply(200,response);await client.refreshClient();assert.equal(client.clientToken,'good');}
    }
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('AAC licensing sends both tokens, preserves HTTP failures, and rejects missing credentials and empty licenses',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({accessToken:'account-token',clientToken:'account-client-token'});
    const pool=agent.get('https://gue1-spclient.spotify.com');
    for(const status of [403,429,200]){
      pool.intercept({path:'/widevine-license/v1/audio/license',method:'POST',headers:{authorization:'Bearer account-token','client-token':'account-client-token'}}).reply(status,Buffer.alloc(0),{headers:{'retry-after':'60'}});
      await assert.rejects(client.widevine.getWidevineLicense('audio',Buffer.from('challenge')),error=>status===200?/empty license/.test(error.message):error instanceof SpotifyApiError&&error.statusCode===status&&error.retryAfter==='60');
    }
    pool.intercept({path:'/widevine-license/v1/audio/license',method:'POST'}).reply(200,Buffer.from('license'));
    assert.equal((await client.widevine.getWidevineLicense('audio',Buffer.from('challenge'))).toString(),'license');
    const second=new Spotify({accessToken:'other-account'});
    await assert.rejects(second.widevine.getWidevineLicense('audio',Buffer.from('challenge')),/client token/);
    assert.equal(second.getHeaders()['Client-Token'],undefined);
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('AAC metadata reads only matching playback descriptors and leaves native metadata unchanged',async()=>{
  const client=new Spotify({accessToken:'access'}),gid='0'.repeat(31)+'1',uri='spotify:track:'+'0'.repeat(21)+'1';
  const original={gid,name:'Track',file:[{file_id:'a'.repeat(40),format:'OGG_VORBIS_160'}]};
  let descriptors=[{file_id:'b'.repeat(40),format:'10',bitrate:128000},{file_id:'c'.repeat(40),format:11,bitrate:256000},{file_id:'d'.repeat(40),format:99}];
  let calls=0;
  client.request=async endpoint=>{calls++;if(endpoint.includes('/metadata/4/'))return original;assert.equal(endpoint,require('spdl').Endpoints.TRACK_PLAYBACK+uri+'?manifestFileFormat=file_ids_mp4');return {media:{[uri]:{item:{manifest:{file_ids_mp4:descriptors}}}}};};
  const native=await client.tracks.getMetadata(gid);assert.equal(calls,1);assert.equal(native.files.length,1);
  const aac=await client.tracks.getMetadata(gid,'MP4_128');assert.deepEqual(aac.files.map(file=>file.format),['OGG_VORBIS_160','MP4_128','MP4_256']);
  descriptors=[{file_id:'bad',format:10}];await assert.rejects(client.tracks.getMetadata(gid,'MP4_128'),/descriptor/);
  descriptors=undefined;await assert.rejects(client.tracks.getMetadata(gid,'MP4_128'),/AAC metadata/);
});

test('AAC accepts one explicitly relinked audio track and rejects unrelated or ambiguous entries',async()=>{
  const client=new Spotify({accessToken:'access'}),gid='0'.repeat(31)+'1',uri='spotify:track:'+'0'.repeat(21)+'1';
  const alternate='spotify:track:'+'0'.repeat(21)+'2';
  const item={track_type:'AUDIO',metadata:{uri:alternate,linked_from_uri:uri},manifest:{file_ids_mp4:[{file_id:'b'.repeat(40),format:10}]}};
  let media={[alternate]:{item}};
  client.request=async endpoint=>endpoint.includes('/metadata/4/')?{gid,name:'Track'}:{media};
  assert.equal((await client.tracks.getMetadata(gid,'MP4_128')).files[0].fileId,'b'.repeat(40));
  item.metadata.linked_from_uri=null;await assert.rejects(client.tracks.getMetadata(gid,'MP4_128'),/AAC metadata/);
  item.metadata.linked_from_uri=uri;item.track_type='VIDEO';await assert.rejects(client.tracks.getMetadata(gid,'MP4_128'),/AAC metadata/);
  item.track_type='AUDIO';const other='spotify:track:'+'0'.repeat(21)+'3';media[other]={item:{...item,metadata:{...item.metadata,uri:other}}};
  await assert.rejects(client.tracks.getMetadata(gid,'MP4_128'),/AAC metadata/);
});

function mp4Fixture(){
  const box=(name,...parts)=>{const payload=Buffer.concat(parts),header=Buffer.alloc(8);header.writeUInt32BE(payload.length+8);header.write(name,4);return Buffer.concat([header,payload]);};
  const description=Buffer.alloc(8);description.writeUInt32BE(1,4);
  const init=box('moov',box('trak',box('mdia',box('minf',box('stbl',box('stsd',description,box('enca',Buffer.alloc(28),box('sinf',box('frma',Buffer.from('mp4a'))))))))));
  const key=Buffer.from('00112233445566778899aabbccddeeff','hex'),iv=Buffer.from('1020304050607080','hex');
  const plain=Buffer.from('encrypted-sample-now-readable');
  const cipher=require('node:crypto').createCipheriv('aes-128-ctr',key,Buffer.concat([iv,Buffer.alloc(8)]));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  const fragment=(sample,encrypted)=>{
    const tfhd=Buffer.alloc(8);tfhd.writeUInt32BE(1,4);
    const trun=Buffer.alloc(16);trun.writeUInt32BE(0x201);trun.writeUInt32BE(1,4);trun.writeUInt32BE(sample.length,12);
    const senc=Buffer.alloc(16);senc.writeUInt32BE(1,4);iv.copy(senc,8);
    const make=()=>box('moof',box('traf',box('tfhd',tfhd),box('trun',trun),...(encrypted?[box('senc',senc)]:[])));
    trun.writeUInt32BE(make().length+8,8);
    return Buffer.concat([make(),box('mdat',sample)]);
  };
  const clearSample=Buffer.from('clear-opening-sample');
  return {key:key.toString('hex'),plain,ciphertext,clearSample,parts:[init,fragment(clearSample,false),fragment(ciphertext,true)]};
}

async function mockMp4(agent,variant='success'){
  const fixture=mp4Fixture(),fileId='b'.repeat(40);
  const client=new Spotify({accessToken:'access',clientToken:'client'});
  client.user.isPremium=async()=>false;
  client.widevine.getKey=async()=>fixture.key;
  agent.get('https://spclient.wg.spotify.com').intercept({path:path=>path.startsWith('/metadata/4/track/')}).reply(200,{gid:'0'.repeat(32),name:'Fixture'});
  agent.get('https://gue1-spclient.spotify.com').intercept({path:path=>path.startsWith('/track-playback/')}).reply(200,{media:{['spotify:track:'+id]:{item:{manifest:{file_ids_mp4:[{file_id:fileId,format:'10'}]}}}}});
  agent.get('https://gue1-spclient.spotify.com').intercept({path:path=>path.startsWith('/storage-resolve/v2/files/audio/interactive/10/'+fileId)}).reply(200,{result:'CDN',cdnurl:['https://audio.example.test/track']});
  agent.get('https://seektables.scdn.co').intercept({path:'/seektable/'+fileId+'.json'}).reply(200,{offset:fixture.parts[0].length,segments:fixture.parts.slice(1).map(part=>[part.length]),pssh:Buffer.from('offline').toString('base64')});
  let start=0,requests=0;
  const total=fixture.parts.reduce((sum,part)=>sum+part.length,0);
  fixture.parts.forEach((part,index)=>{
    const end=start+part.length-1,range='bytes='+start+'-'+end;
    const options={headers:{'content-range':'bytes '+start+'-'+end+'/'+total}};
    agent.get('https://audio.example.test').intercept({path:'/track',headers:{range}}).reply(()=>{
      requests++;
      if(index===0&&variant==='status')return {statusCode:503,data:'provider detail',responseOptions:{headers:{'retry-after':'30'}}};
      if(index===0&&variant==='truncated')return {statusCode:206,data:part.subarray(0,-1),responseOptions:options};
      if(index===0&&variant==='range')return {statusCode:206,data:part,responseOptions:{headers:{'content-range':'bytes 1-2/3'}}};
      return {statusCode:206,data:part,responseOptions:options};
    });
    start=end+1;
  });
  return {client,fixture,requests:()=>requests};
}

test('public MP4 download decrypts encrypted fragments, preserves clear lead, streams early, and ends',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const {client,fixture,requests}=await mockMp4(agent);
    const chunks=[];
    await require('node:stream/promises').pipeline(client.download('https://open.spotify.com/track/'+id,{format:'MP4_128',highWaterMark:1}),new(require('node:stream').Writable)({highWaterMark:1,write(chunk,encoding,callback){if(!chunks.length)assert.ok(requests()<3,'must deliver before fetching the entire track');chunks.push(chunk);setTimeout(callback,5);}}),{signal:AbortSignal.timeout(2000)});
    const output=Buffer.concat(chunks);
    assert.ok(output.includes(fixture.clearSample));assert.ok(output.includes(fixture.plain));assert.ok(!output.includes(fixture.ciphertext));
    assert.equal(output.length,fixture.parts.reduce((sum,part)=>sum+part.length,0));
    assert.equal(requests(),3);agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('MP4 rejects failed, truncated and mismatched CDN ranges through its public readable',async()=>{
  for(const variant of ['status','truncated','range']){
    const agent=new undici.MockAgent();agent.disableNetConnect();
    const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
    try{
      const {client,requests}=await mockMp4(agent,variant);
      const stream=client.download('https://open.spotify.com/track/'+id,{format:'MP4_128'});
      await assert.rejects(require('node:stream/promises').pipeline(stream,new(require('node:stream').Writable)({write(chunk,encoding,callback){callback();}}),{signal:AbortSignal.timeout(2000)}),error=>variant==='status'?error.statusCode===503&&error.retryAfter==='30':error.message.includes(variant==='truncated'?'incomplete':'unexpected'));
      assert.equal(requests(),1);assert.equal(stream.destroyed,true);
    }finally{undici.setGlobalDispatcher(previous);await agent.close();}
  }
});

test('MP4 stops fetching when the consumer fails and rejects invalid seek tables',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const {client,requests}=await mockMp4(agent);
    const stopped=new Error('consumer stopped');
    await assert.rejects(require('node:stream/promises').pipeline(client.download('https://open.spotify.com/track/'+id,{format:'MP4_128',highWaterMark:1}),new(require('node:stream').Writable)({write(chunk,encoding,callback){callback(stopped);}}),{signal:AbortSignal.timeout(2000)}),error=>error===stopped);
    await new Promise(resolve=>setTimeout(resolve,20));assert.ok(requests()<3);
    agent.get('https://seektables.scdn.co').intercept({path:'/seektable/invalid.json'}).reply(200,{offset:1,segments:[[-1]],pssh:'fixture'});
    await assert.rejects(client.widevine.getSeektable('invalid'),/Invalid Spotify seek table/);
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});
test('a changed authenticated client ID invalidates its old client token before licensing',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({cookie:'sp_dc=offline',clientToken:'old-client-token'});
    client.accessToken='expired';client.clientId='old-client';
    agent.get('https://git.gay').intercept({path:'/thereallo/totp-secrets/raw/branch/main/secrets/secrets.json'}).reply(200,[{version:61,secret:'offline'}]);
    const spotify=agent.get('https://open.spotify.com');
    spotify.intercept({path:'/api/server-time/'}).reply(200,{serverTime:Math.floor(Date.now()/1000)});
    spotify.intercept({path:path=>path.startsWith('/api/token/')}).reply(200,{isAnonymous:false,accessToken:'renewed',clientId:'new-client',accessTokenExpirationTimestampMs:Date.now()+3600000});
    spotify.intercept({path:'/'}).reply(200,'<script id="appServerConfig">{"clientVersion":"1.3.test"}</script>');
    agent.get('https://clienttoken.spotify.com').intercept({path:'/v1/clienttoken',method:'POST',body:body=>JSON.parse(body).client_data.client_id==='new-client'}).reply(200,{granted_token:{token:'new-client-token',refresh_after_seconds:3600}});
    agent.get('https://gue1-spclient.spotify.com').intercept({path:'/widevine-license/v1/audio/license',method:'POST',headers:{authorization:'Bearer renewed','client-token':'new-client-token'}}).reply(200,Buffer.from('license'));
    assert.equal((await client.widevine.getWidevineLicense('audio',Buffer.from('challenge'))).toString(),'license');
    assert.equal(client.clientId,'new-client');assert.equal(client.clientToken,'new-client-token');
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('client version discovery rejects unavailable configuration without issuing a token request',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({accessToken:'account'});client.clientId='account-client';
    for(const body of ['<html>changed player</html>','<script id="appServerConfig">not-json</script>','<script id="appServerConfig">{"clientVersion":null}</script>']){
      agent.get('https://open.spotify.com').intercept({path:'/'}).reply(200,body);
      await assert.rejects(client.refreshClient(),/client version/);
      assert.equal(client.clientToken,'');
    }
    agent.get('https://open.spotify.com').intercept({path:'/'}).reply(429,'private',{headers:{'retry-after':'10'}});
    await assert.rejects(client.refreshClient(),error=>error.statusCode===429&&error.retryAfter==='10');
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});

test('AAC licensing refreshes an expired client token without renewing valid access credentials',async()=>{
  const agent=new undici.MockAgent();agent.disableNetConnect();
  const previous=undici.getGlobalDispatcher();undici.setGlobalDispatcher(agent);
  try{
    const client=new Spotify({cookie:'sp_dc=offline',accessToken:'still-valid',clientToken:'expired-client'});
    client.clientId='account';client.accessExpiration=Date.now()+3600000;client.clientExpiration=0;
    agent.get('https://open.spotify.com').intercept({path:'/'}).reply(200,'<script id="appServerConfig">{"clientVersion":"1.3.test"}</script>');
    agent.get('https://clienttoken.spotify.com').intercept({path:'/v1/clienttoken',method:'POST'}).reply(200,{granted_token:{token:'renewed-client',refresh_after_seconds:3600}});
    agent.get('https://gue1-spclient.spotify.com').intercept({path:'/widevine-license/v1/audio/license',method:'POST',headers:{authorization:'Bearer still-valid','client-token':'renewed-client'}}).reply(200,Buffer.from('license'));
    await client.widevine.getWidevineLicense('audio',Buffer.from('challenge'));
    agent.assertNoPendingInterceptors();
  }finally{undici.setGlobalDispatcher(previous);await agent.close();}
});
test('client expiry is rechecked after access refresh completes',async()=>{
  const client=new Spotify({cookie:'sp_dc=offline'});
  client.accessToken='expired';client.clientId='account';client.clientToken='expires-during-refresh';
  client.clientExpiration=Date.now()+10;
  client.refreshToken=async()=>{await new Promise(resolve=>setTimeout(resolve,20));client.accessExpiration=Date.now()+3600000;};
  let clientRefreshes=0;client.refreshClient=async()=>{clientRefreshes++;client.clientExpiration=Date.now()+3600000;};
  await client.refresh();assert.equal(clientRefreshes,1);
});

test('playlist pages resume at the exact cursor and validate revisions, totals, bounds and occurrence IDs', async () => {
  const client = new Spotify({accessToken:'fixture-token'});
  client.playlists.queryHash = async () => 'a'.repeat(64);
  const calls = [];
  client.request = async (_url, body) => {
    calls.push(body.variables.offset);
    return page([item('two'), item('three')], body.variables.offset, 3);
  };
  const result = await client.playlists.getPage(id, 1, 2, {snapshotId:'snapshot',total:3});
  assert.deepEqual(calls,[1]);
  assert.equal(result.playlist.tracks.length,2);
  assert.equal(result.nextOffset,null);
  assert.deepEqual(result.itemUids,['two','three']);
  await assert.rejects(client.playlists.getPage(id,1,2,{snapshotId:'changed',total:3}),error=>error.statusCode===409);
  await assert.rejects(client.playlists.getPage(id,1,2,{snapshotId:'snapshot',total:4}),error=>error.statusCode===409);
  await assert.rejects(client.playlists.getPage(id,-1),/pagination/);
  await assert.rejects(client.playlists.getPage(id,0,101),/pagination/);
  client.request = async () => page([item('same'),item('same')],1,3);
  await assert.rejects(client.playlists.getPage(id,1,2),/invalid playlist page/);
});
