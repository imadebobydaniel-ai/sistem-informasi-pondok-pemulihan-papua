'use strict';
// Official portable test tools only; no system install or production credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const directory=path.join(__dirname,'.cache/tools');fs.mkdirSync(directory,{recursive:true});
async function main(){
  const results=[];
  for(const [name,url,digest] of [
    ['postgresql-17.12.zip','https://get.enterprisedb.com/postgresql/postgresql-17.12-1-windows-x64-binaries.zip',null],
    ['postgrest-16.5.zip','https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-windows-x86-64.zip','17f595b0d8dd37473d0231417dea07c5ac9f791282ff5b017fae51ff29e5de2f']
  ]){
    const file=path.join(directory,name);if(fs.existsSync(file))throw Error('Preserve existing archive');
    const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw Error('Official tool download unavailable');
    await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(file,{flags:'wx'}));
    const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);const sha256=hash.digest('hex');
    if(digest&&sha256!==digest)throw Error('Official release checksum mismatch');
    results.push({name,sha256,bytes:fs.statSync(file).size,officialReleaseDigestVerified:!!digest});console.log(JSON.stringify(results[results.length-1]));
  }
  fs.writeFileSync(path.join(__dirname,'TEST-TOOLS.json'),JSON.stringify(results,null,2));
}
main().catch(()=>{console.log('LOCAL_TOOL_DOWNLOAD_BLOCKED_NO_PRODUCTION_ACCESS');process.exitCode=1;});
