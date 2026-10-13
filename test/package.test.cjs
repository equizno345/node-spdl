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
