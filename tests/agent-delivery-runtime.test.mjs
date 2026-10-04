import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateTemplate, getTemplateFiles, localPlan, TEMPLATE_FILES } from '../server/templates.mjs';
import { startRuntime, stopProcess, minimalEnv } from '../server/processes.mjs';
import { runAgent } from '../server/templates/agent-core.mjs';
import { validateMcpDirectory } from '../server/agent-validation.mjs';

async function fixture(delivery, options = {}) {
  const parent = path.resolve('.data/agent-delivery-tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'artifact-'));
  const project = { id: crypto.randomUUID(), kind: options.kind || 'ai-agent', ...(delivery ? { agentDelivery: delivery } : {}) };
  project.plan = localPlan('팀의 텍스트를 분석하고 정리하는 에이전트', project.kind, { agentDelivery: delivery });
  const files = await generateTemplate(project);
  for (const file of files) { const location = path.join(directory, file.path); await fs.mkdir(path.dirname(location), { recursive: true }); await fs.writeFile(location, file.content); }
  let runtime;
  const dataFile = path.join(directory, 'test-data.json');
  const previewAccessToken = options.gate ? crypto.randomBytes(20).toString('hex') : undefined;
  return { directory, project, files, dataFile, previewAccessToken,
    async start() { runtime = await startRuntime(directory, { dataFile, previewAccessToken }); },
    async stop() { await stopProcess(runtime?.child); },
    async request(route, { method = 'GET', data, cookie, token, headers } = {}) {
      const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, { method, redirect: 'manual', headers: { ...(data !== undefined ? { 'Content-Type':'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
      const body = await response.text(); let value; try { value = JSON.parse(body); } catch { value = body; }
      return { response, value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    async close() { await stopProcess(runtime?.child); assert.ok(path.resolve(directory).startsWith(parent + path.sep)); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('shared core validates input and tools and only invokes OpenAI for the ai tool', async () => {
  assert.match((await runAgent('검증 텍스트 검증', 'analyze')).output, /검증 \(2\)/);
  assert.equal((await runAgent('첫 작업\n둘째 작업', 'checklist')).output, '1. 첫 작업\n2. 둘째 작업');
  for (const input of ['', '  ', {}, 'x'.repeat(20001)]) await assert.rejects(runAgent(input, 'analyze'), error => error.status === 400);
  await assert.rejects(runAgent('텍스트', 'shell'), error => error.status === 400);
  await assert.rejects(runAgent('텍스트', 'ai', {}, { env: { GEMINI_API_KEY: 'not-an-openai-key' } }), error => error.status === 503);
  let request;
  const result = await runAgent('요약', 'ai', { summary:'회의 정리' }, { env:{OPENAI_API_KEY:'fixture-secret',OPENAI_MODEL:'fixture-model'}, fetcher:async (url, options) => { request={url,options}; return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'요약 결과'}]}]}); } });
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(JSON.parse(request.options.body).model,'fixture-model'); assert.equal(result.mode,'openai'); assert.equal(result.output,'요약 결과'); assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  await assert.rejects(runAgent('text','ai',{}, {env:{OPENAI_API_KEY:'fixture-secret'},fetcher:async()=>Response.json({error:'fixture-secret'}, {status:429})}), error=>error.status===502&&!error.message.includes('fixture-secret'));
});

test('actual generated file trees distinguish web, API and MCP without changing non-agent dependencies', async () => {
  for (const delivery of ['web','api','mcp']) {
    const f = await fixture(delivery);
    try {
      assert.deepEqual([...f.files.map(file=>file.path)].sort(), getTemplateFiles(f.project).sort());
      assert.ok(f.files.every(file=>TEMPLATE_FILES.includes(file.path)));
      assert.equal(JSON.parse(f.files.find(file=>file.path==='project.json').content).agentDelivery,delivery);
      const pkg=JSON.parse(f.files.find(file=>file.path==='package.json').content);
      if(delivery==='mcp'){assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'],'1.32.0');assert.equal(pkg.scripts.mcp,'node agent-mcp.mjs');assert.match(f.files.find(file=>file.path==='mcp.config.json').content,/ABSOLUTE\/PATH/);}
      else assert.equal(pkg.dependencies,undefined);
      if(delivery==='api')assert.match(f.files.find(file=>file.path==='public/app.js').content,/href="\/console"/);
    } finally { await f.close(); }
  }
  const f=await fixture(undefined,{kind:'web-app'});
  try { assert.equal(f.files.length,7);assert.equal(JSON.parse(f.files.find(file=>file.path==='package.json').content).dependencies,undefined);assert.ok(!f.files.some(file=>file.path==='agent-core.mjs')); }
  finally {await f.close();}
});

test('bearer API bypasses only the preview cookie, with hash-only owner-scoped expiry and revocation', async () => {
  const a=await fixture('api',{gate:true}), b=await fixture('api');
  try {
    await a.start();await b.start();
    assert.equal((await a.request('/console')).response.status,403);
    assert.equal((await a.request('/api/tokens',{method:'POST',data:{}})).response.status,403);
    const schema=await a.request('/openapi.json');assert.equal(schema.response.status,200);assert.equal(schema.value.openapi,'3.1.0');assert.ok(schema.value.paths['/v1/agent/run'].post.security);
    const access=await a.request('/console?access='+a.previewAccessToken);assert.equal(access.response.status,303);assert.equal(access.response.headers.get('location'),'/console');const preview=access.cookie;
    assert.equal((await a.request('/console',{cookie:preview})).response.status,200);
    assert.equal((await a.request('/api/tokens',{cookie:preview})).response.status,401);
    const first=await a.request('/api/auth/signup',{method:'POST',cookie:preview,data:{name:'Owner',email:'owner@example.test',password:'secure-pass-123'}});
    const cookie=preview+'; '+first.cookie;
    const other=await a.request('/api/auth/signup',{method:'POST',cookie:preview,data:{name:'Other',email:'other@example.test',password:'secure-pass-123'}});
    const otherCookie=preview+'; '+other.cookie;
    for(const expiresInSeconds of [0,59,2592001,'3600',1.5]) assert.equal((await a.request('/api/tokens',{method:'POST',cookie,data:{expiresInSeconds}})).response.status,400);
    const issued=await a.request('/api/tokens',{method:'POST',cookie,data:{name:'Automation',expiresInSeconds:3600}});
    assert.equal(issued.response.status,201);assert.match(issued.value.token,/^lpa_[a-f0-9]{64}$/);assert.equal(issued.value.scope,'agent:run');
    const token=issued.value.token, payload={input:'첫 작업\n둘째 작업',tool:'checklist'};
    assert.equal((await a.request('/v1/agent/run',{method:'POST',cookie,data:payload})).response.status,401);
    const run=await a.request('/v1/agent/run',{method:'POST',token,data:payload});assert.equal(run.response.status,200);assert.equal(run.value.output,'1. 첫 작업\n2. 둘째 작업');
    assert.equal((await a.request('/v1/agent/run',{method:'POST',token,data:{input:'x',tool:'shell'}})).response.status,400);
    assert.equal((await a.request('/v1/agent/run',{method:'POST',token,data:{input:'x'.repeat(20001)}})).response.status,400);
    assert.equal((await a.request('/v1/agent/run',{method:'POST',token,data:{input:'ai request',tool:'ai'}})).response.status,503);
    assert.equal((await a.request('/v1/agent/run',{method:'POST',token,data:payload,headers:{Origin:'https://foreign.example'}})).response.status,403);
    assert.equal((await a.request('/api/items',{token})).response.status,403);
    assert.equal((await b.request('/v1/agent/run',{method:'POST',token,data:payload})).response.status,401);
    const list=await a.request('/api/tokens',{cookie});assert.equal(list.value.length,1);assert.equal(list.value[0].token,undefined);assert.equal(list.value[0].tokenHash,undefined);
    assert.deepEqual((await a.request('/api/tokens',{cookie:otherCookie})).value,[]);
    assert.equal((await a.request('/api/tokens/'+issued.value.id,{method:'DELETE',cookie:otherCookie})).response.status,404);
    const disk=await fs.readFile(a.dataFile,'utf8');assert.ok(!disk.includes(token));assert.equal(JSON.parse(disk).tokens[0].tokenHash,crypto.createHash('sha256').update(token).digest('hex'));
    // Even copying token records cannot grant access to another project.
    await b.stop();await fs.writeFile(b.dataFile,disk);await b.start();assert.equal((await b.request('/v1/agent/run',{method:'POST',token,data:payload})).response.status,401);
    await a.request('/api/tokens/'+issued.value.id,{method:'DELETE',cookie});assert.equal((await a.request('/v1/agent/run',{method:'POST',token,data:payload})).response.status,401);
    const expiring=await a.request('/api/tokens',{method:'POST',cookie,data:{}});await a.stop();const data=JSON.parse(await fs.readFile(a.dataFile,'utf8'));data.tokens.find(value=>value.id===expiring.value.id).expiresAt=Date.now()-1;await fs.writeFile(a.dataFile,JSON.stringify(data));await a.start();
    assert.equal((await a.request('/v1/agent/run',{method:'POST',token:expiring.value.token,data:payload})).response.status,401);
  } finally {await a.close();await b.close();}
});

test('generated MCP speaks initialize/list/call over stdio, shares tool results and rejects invalid calls', async () => {
  const f=await fixture('mcp');
  let client;
  try {
    const checks=await validateMcpDirectory(f.directory);assert.equal(checks.length,4);assert.ok(checks.every(check=>check.passed),JSON.stringify(checks));
    client=new Client({name:'delivery-test',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(f.directory,'agent-mcp.mjs')],cwd:path.resolve('.'),env:minimalEnv(),stderr:'pipe'});
    await client.connect(transport);
    const invalid=await client.callTool({name:'analyze',arguments:{input:''}});assert.equal(invalid.isError,true);
    const missing=await client.callTool({name:'ai',arguments:{input:'텍스트'}});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/OPENAI_API_KEY/);
    const result=await client.callTool({name:'analyze',arguments:{input:'동일한 입력입니다.'}});assert.equal(result.structuredContent.output,(await runAgent('동일한 입력입니다.','analyze')).output);
  } finally {await client?.close();await f.close();}
});
