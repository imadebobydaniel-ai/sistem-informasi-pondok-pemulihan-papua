'use strict';
// Official CDN bytes only, saved in ignored local test storage; never site assets.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const expected={app:'0dbf0df8409c85768aa712c92cdc573bc768fff7975e8e19d17d54710006047a',
    auth:'4697f7d3fb4d4f6c5aa997303688e25ad7188f4ad8d092ac9ffe4cc8f8a946fd',
    firestore:'d337de5376e1a59c7f5e937be66c0fcd45b441c2c8a21d2cb0bf1981192a746c',
    functions:'9b512ced8129c156f9738da04723b2672e4e13c40bb23c735b57495a684a51ab',
    'app-check':'2120e9ea91746238f3f8f3654e73d1c2f8de24a6b582f61339ce7ad5d1cd552a'};
async function main(){const out=path.join(__dirname,'_runtime-sdk');fs.mkdirSync(out,{recursive:true});
    await Promise.all(Object.entries(expected).map(async([name,checksum])=>{
        const file='firebase-'+name+'-compat.js',url='https://www.gstatic.com/firebasejs/12.18.0/'+file;
        const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw Error(file+': HTTP '+response.status);
        const bytes=Buffer.from(await response.arrayBuffer());
        if(crypto.createHash('sha256').update(bytes).digest('hex')!==checksum)throw Error('Official SDK checksum changed: '+file);
        fs.writeFileSync(path.join(out,file),bytes);console.log('PASS official checksum '+file);
    }));fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(expected,null,2)+'\n');}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
