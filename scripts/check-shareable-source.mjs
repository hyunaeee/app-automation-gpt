// Read-only preflight for the Git index or a not-yet-staged repository.
// Reports filenames only; never prints credential values.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
const staged=process.argv.includes('--staged');
const gitOptions={windowsHide:true,maxBuffer:64*1024*1024};
const args=staged?['-c','core.excludesFile=','ls-files','-z']:['-c','core.excludesFile=','ls-files','--cached','--others','--exclude-standard','-z'];
const files=[...new Set(execFileSync('git',args,{...gitOptions,encoding:'utf8'}).split('\0').filter(Boolean))];
const blocked=/(^|\/)(\.env(?!\.example$)(\.|$)|\.data|\.codex|\.validation|node_modules|auth\.json)(\/|$)|\.(keystore|jks|p12|pfx|pem|key)$/i;
const patterns=[['OpenAI key',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]];
// Reviewed synthetic credentials used only by these mocked tests. Exact value
// hashes are scoped to their files; other credentials in tests remain blocked.
const syntheticFixtures={
  'e2e/personal-key.spec.ts':['0d1693408a108d0dd92109a5b8c53b4c3155d968e5016fa6903f0a031c9ec9a4'],
  'tests/credentials.test.mjs':['0c7be42a57686d81639dd419cfd3a76e2f59739217c905550530670d435dc4c0','27a580fa8ad22f4e6926aa259d4396bd6625f7c93e05242cc98e7e5cea77d46a'],
  'tests/google-integration.test.mjs':['c2b2a5a5756154e381f9bb113aec5e640bcd6225e6ad845cdd21fd8d9f05d565','898adec75162cfaa67bbcc16286bc44a8e53cde00c5d22017aed086b66572032'],
  'tests/revisions.test.mjs':['8c2dcd14e2c28014629173bf569970570c108e70bdaf916b7e5648bb8d70a614'],
};
const issues=[];let bytes=0;
for(const file of files){
  if(blocked.test(file))issues.push({file,reason:'Private/runtime path'});
  const data=staged?execFileSync('git',['show',`:${file}`],gitOptions):await fs.readFile(file);bytes+=data.length;
  if(data.length>50*1024*1024)issues.push({file,reason:'File exceeds 50 MB'});
  if(!/\.(?:m?[jt]sx?|json|md|html|css|ya?ml|toml|txt|example)$/.test(file))continue;
  const contents=data.toString('utf8');
  for(const [name,pattern]of patterns){
    const unexpected=[...contents.matchAll(new RegExp(pattern.source,'g'))].some(([value])=>{
      const hash=createHash('sha256').update(value).digest('hex');
      return name!=='OpenAI key'||!syntheticFixtures[file]?.includes(hash);
    });
    if(unexpected)issues.push({file,reason:name+' pattern; inspect locally before sharing'});
  }
}
console.log(JSON.stringify({files:files.length,bytes,issues},null,2));
if(issues.length)process.exitCode=1;
