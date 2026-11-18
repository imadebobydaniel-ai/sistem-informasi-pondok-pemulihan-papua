'use strict';
// A real upload requires an explicitly designated disposable TEST cloud/preset.
// Do not silently treat the application's existing live cloud as a test account.
async function main(){
    const cloud=process.env.SIPAPUA_CLOUDINARY_TEST_CLOUD,preset=process.env.SIPAPUA_CLOUDINARY_TEST_PRESET;
    if(!cloud||!preset||process.env.SIPAPUA_CLOUDINARY_TEST_APPROVED!=='true'){
        console.log(JSON.stringify({status:'BLOCKED',realUploadAttempts:0,reason:'No explicitly designated disposable Cloudinary test cloud/preset; existing application cloud was not assumed safe for a real upload'}));process.exitCode=2;return;
    }
    if(!/^[a-zA-Z0-9_-]+$/.test(cloud)||!/^[a-zA-Z0-9_-]+$/.test(preset))throw Error('Invalid test target');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ikAAAAASUVORK5CYII=','base64');
    // Unsigned requests cannot force arbitrary preset settings. The designated
    // test preset must already enable return_delete_token; never change a preset.
    const body=new FormData();body.set('file',new Blob([png],{type:'image/png'}),'synthetic-005a.png');body.set('upload_preset',preset);
    const response=await fetch('https://api.cloudinary.com/v1_1/'+cloud+'/image/upload',{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    if(!response.ok||!result.secure_url){console.log(JSON.stringify({status:'BLOCKED',httpStatus:response.status,reason:'Synthetic upload was not accepted by the designated test configuration'}));return;}
    if(!result.delete_token){console.log(JSON.stringify({status:'BLOCKED',reason:'Upload succeeded but provider did not issue disposable cleanup token; no delete API secret was requested'}));return;}
    const cleanup=new FormData();cleanup.set('token',result.delete_token);
    const deleted=await fetch('https://api.cloudinary.com/v1_1/'+cloud+'/delete_by_token',{method:'POST',body:cleanup,redirect:'error',signal:AbortSignal.timeout(15000)});
    const deletion=await deleted.json();
    console.log(JSON.stringify({status:deleted.ok&&deletion.result==='ok'?'PASS':'BLOCKED',syntheticUpload:true,cleanupConfirmed:deleted.ok&&deletion.result==='ok',realMemberDataUsed:false}));
}
main().catch(()=>{console.log(JSON.stringify({status:'BLOCKED',reason:'Cloudinary test endpoint unavailable; no member data used'}));process.exitCode=2;});
