'use strict';
// Owner-run public HTTP GETs only. Does not execute the site or call Firebase.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const origin='https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/';
const files=['index.html','registrasi.html','profil.html','edit-jemaat-administrator.html','auth-handler.html','verify-success.html','sipapua-registration.js','sipapua-maintenance.js',
    'sipapua-app-check.js','sipapua-spark-registration.js','sipapua-spark-member.js','sipapua-member-session.js','sipapua-login.js'];
const hash=x=>crypto.createHash('sha256').update(x.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')).digest('hex');
async function verify(fetchImpl){
    for(const f of files){const url=new URL(f,origin);let response;
        try{response=await fetchImpl(url.href,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(30000)});}catch(_){throw Error('PUBLIC_READ_FAILED');}
        if(response.status!==200)throw Error('PUBLIC_ASSET_UNAVAILABLE');
        if(hash(await response.text())!==hash(fs.readFileSync(path.join(root,f),'utf8')))throw Error('PUBLIC_RELEASE_HASH_MISMATCH');
    }
    return{publicAssetsMatched:files.length,appCheckAttestationVerified:false,authenticatedCompatibilityVerified:false};
}
module.exports={verify,files};
if(require.main===module)verify(globalThis.fetch).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('PUBLIC_VERIFICATION_FAILED');process.exitCode=1;});
