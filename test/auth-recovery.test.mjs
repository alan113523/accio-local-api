import test from 'node:test';
import assert from 'node:assert/strict';
import {AccioAuth,ApiError,upstreamJson} from '../src/auth.mjs';
import {AccioClient} from '../src/accio.mjs';

const rejected=()=>Response.json({success:false,code:'401',message:'NOT_LOGIN'});
const grant={accessToken:'old',refreshToken:'own-refresh',expiresAt:Date.now()+86400000,sgcookie:'own-signing-cookie'};
function fixture(handler){
 const saved=[],calls=[];
 const auth=new AccioAuth({readSpace:async()=>({kind:'team',accountId:'own-account',teamId:'own-team'}),store:{write:async value=>saved.push(value)},fetchImpl:async(url,options)=>{
  const path=url.pathname;calls.push(path);
  if(path==='/api/auth/refresh_token')return Response.json({data:{accessToken:'new',refreshToken:'next-refresh',expiresAt:Date.now()/1000+3600}});
  return handler(url,options);
 }});
 auth.credentials={...grant};return{auth,saved,calls};
}

test('server-revoked login refreshes despite a future local expiry and verifies the selected team account',async()=>{
 const f=fixture(async(url,options)=>JSON.parse(options.body).accessToken==='old'?rejected():Response.json({data:{userId:'own-account',routeRegion:'CN'}}));
 await f.auth.context();
 assert.deepEqual(f.calls,['/api/auth/userinfo','/api/auth/refresh_token','/api/auth/userinfo']);
 assert.equal(f.auth.headers()['x-team-id'],'own-team');assert.equal(f.saved.length,1);assert.equal(f.saved[0].sgcookie,'own-signing-cookie');
});

test('concurrent model and quota rejections share one refresh and preserve native models and team quota',async()=>{
 const f=fixture(async(url,options)=>{
  if(url.pathname==='/api/auth/userinfo')return Response.json({data:{userId:'own-account',routeRegion:'CN'}});
  const token=url.searchParams.get('accessToken')??JSON.parse(options.body).token;
  if(token==='old'){await new Promise(resolve=>setTimeout(resolve,url.pathname.includes('config')?15:0));return rejected();}
  assert.equal(options.headers['x-team-id'],'own-team');
  if(url.pathname.includes('config'))return Response.json({data:{providers:[{provider:'claude',modelList:[{modelCode:'native-opus',modelDisplayName:'Claude Opus 5.5'}]}]}});
  assert.equal(url.searchParams.get('subscripType'),'TEAM');assert.equal(url.searchParams.get('teamId'),'own-team');
  return Response.json({data:{type:'TEAM',total:30000,remaining:21530}});
 });
 await f.auth.context();
 const client=new AccioClient(f.auth,f.auth.fetch);
 const [models,quota]=await Promise.all([client.models(),client.quota()]);
 assert.equal(f.calls.filter(x=>x==='/api/auth/refresh_token').length,1);assert.equal(f.saved.length,1);
 assert.equal(models[0].modelCode,'native-opus');assert.equal(quota.scope,'team');assert.equal(quota.remainingCredits,21530);
});

test('a repeated authentication rejection is retried only once',async()=>{
 const f=fixture(async()=>rejected());let attempts=0;
 await assert.rejects(f.auth.withToken(async()=>{attempts++;throw new ApiError(503,'accio_auth_expired','expired');}),/expired/);
 assert.equal(attempts,2);assert.equal(f.calls.length,1);assert.equal(f.saved.length,1);
});

test('business failures and network errors do not trigger authentication refresh',async()=>{
 for(const error of [new ApiError(429,'accio_rejected','rate limited'),new TypeError('fetch failed')]){
  const f=fixture(async()=>assert.fail('No network call expected'));let attempts=0;
  await assert.rejects(f.auth.withToken(async()=>{attempts++;throw error;}),e=>e===error);
  assert.equal(attempts,1);assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
 }
});

test('a rejected refresh preserves the stored grant and does not enter a retry loop',async()=>{
 let exchanges=0,writes=0,attempts=0;
 const auth=new AccioAuth({store:{write:async()=>{writes++;}},fetchImpl:async()=>{exchanges++;return rejected();}});
 auth.credentials={...grant};
 await assert.rejects(auth.withToken(async()=>{attempts++;throw new ApiError(503,'accio_auth_expired','expired');}),e=>e.code==='accio_auth_expired');
 assert.equal(exchanges,1);assert.equal(attempts,1);assert.equal(writes,0);assert.equal(auth.credentials.accessToken,'old');
});

test('HTTP and JSON authentication failures stay distinct from generic upstream failures',async()=>{
 for(const response of [new Response('',{status:401}),rejected(),Response.json({success:false,code:'OTHER',message:'NOT_LOGIN'})]){
  await assert.rejects(upstreamJson('/test',{},async()=>response),e=>e.code==='accio_auth_expired'&&e.status===503);
 }
 await assert.rejects(upstreamJson('/test',{},async()=>Response.json({success:false,code:'403',message:'denied'})),e=>e.code==='accio_rejected');
});

test('account mismatch after refresh still fails without enabling an unrelated team',async()=>{
 const f=fixture(async(url,options)=>JSON.parse(options.body).accessToken==='old'?rejected():Response.json({data:{userId:'other-account'}}));
 await assert.rejects(f.auth.context(),e=>e.code==='space_account_mismatch');assert.equal(f.auth.headers()['x-team-id'],undefined);
});

test('generation requests are never replayed by the metadata authentication recovery',async()=>{
 let generated=0;const f=fixture(async()=>assert.fail('No token refresh expected'));
 const client=new AccioClient(f.auth,async()=>{generated++;return new Response('',{status:401});},async()=>({}));
 f.auth.context=async()=>({teamId:'own-team'});
 await assert.rejects(async()=>{for await(const frame of client.generate({},AbortSignal.timeout(1000)))void frame;});
 assert.equal(generated,1);assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
});
