'use strict';
// Resume official archive with validated HTTP byte ranges; local tools only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const dir=path.join(__dirname,'.cache/tools'),url='https://get.enterprisedb.com/postgresql/postgresql-17.12-1-windows-x64-binaries.zip',size=386263884;
async function main(){
  const original=path.join(dir,'postgresql-17.12.zip'),target=path.join(dir,'postgresql-17.12-complete.zip');
  const prefix=fs.statSync(original).size;if(prefix>size)throw Error('Unexpected archive size');
  const parts=[],n=12,chunk=Math.ceil((size-prefix)/n);
  await Promise.all(Array.from({length:n},async(_,i)=>{
    const start=prefix+i*chunk,end=Math.min(size-1,start+chunk-1);if(start>end)return;
    const response=await fetch(url,{headers:{Range:'bytes='+start+'-'+end},signal:AbortSignal.timeout(300000)});
    if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${end}/${size}`)throw Error('Official range response mismatch');
    const file=path.join(dir,'pg-part-'+String(i).padStart(2,'0'));await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(file,{flags:'wx'}));
    if(fs.statSync(file).size!==end-start+1)throw Error('Incomplete range');parts.push({i,file});console.log('Official archive range '+(i+1)+' complete');
  }));
  const output=fs.createWriteStream(target,{flags:'wx'});
  async function append(stream){for await(const chunk of stream){if(!output.write(chunk))await new Promise(r=>output.once('drain',r));}}
  if(prefix)await append(fs.createReadStream(original,{start:0,end:prefix-1}));
  for(const part of parts.sort((a,b)=>a.i-b.i))await append(fs.createReadStream(part.file));
  await new Promise((r,j)=>{output.on('error',j);output.end(r);});if(fs.statSync(target).size!==size)throw Error('Archive length mismatch');
  const pgHash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(target))pgHash.update(chunk);
  const pg={name:path.basename(target),bytes:size,sha256:pgHash.digest('hex'),source:'official EDB archive linked by postgresql.org'};console.log(JSON.stringify(pg));
  const rest=await fetch('https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-windows-x86-64.zip',{signal:AbortSignal.timeout(120000)});if(!rest.ok)throw Error('Official PostgREST unavailable');
  const file=path.join(dir,'postgrest-16.5-verified.zip');await pipeline(Readable.fromWeb(rest.body),fs.createWriteStream(file,{flags:'wx'}));
  const restHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(restHash!=='17f595b0d8dd37473d0231417dea07c5ac9f791282ff5b017fae51ff29e5de2f')throw Error('Official release digest mismatch');
  fs.writeFileSync(path.join(__dirname,'TEST-TOOLS-VERIFIED.json'),JSON.stringify({postgres:pg,postgrest:{name:path.basename(file),sha256:restHash,officialReleaseDigestVerified:true}},null,2));console.log('Portable local test tools downloaded; no system install');
}
main().catch(()=>{console.log('PARALLEL_TOOL_DOWNLOAD_BLOCKED_NO_PRODUCTION_ACCESS');process.exitCode=1;});
