/* Original SIPAPUA: administrator-only preparation. No operation runs on load.
 * audit() only reads. prepare()/enable()/abort() require explicit calls.
 * Existing member profiles and Auth accounts are never written by this module.
 */
(function(root){
    'use strict';
    const api = typeof module === 'object' && module.exports ? require('./sipapua-registration.js') : root.SIPAPUA_REGISTRATION;
    const regions = Object.values(api.regions);
    const error = code => Object.assign(new Error(code), {code});
    const validNumber = n => Number.isSafeInteger(n) && n >= 0 && n < 1000000000;
    function plan(data) {
        const issues=[], warnings=[], claims=new Map(), counters=Object.fromEntries(regions.map(r=>[r,0]));
        function issue(code,id){issues.push({code,id});}
        const nijSeen=new Set();
        function nij(record,source){
            const d=record.data, match=/^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-(\d+)-(\d{4})$/i.exec(String(d.nij||'').trim());
            if(!match || !validNumber(Number(match[2])) || Number(match[2])===0){issue('NIJ_REVIEW_REQUIRED',source+'/'+record.id);return;}
            const n=Number(match[2]), region=api.regions[match[1].toUpperCase()];
            counters[region]=Math.max(counters[region],n);
            if(d.nij_number!==undefined && (!validNumber(d.nij_number) || d.nij_number!==n)) issue('NIJ_NUMBER_MISMATCH',source+'/'+record.id);
            if(source==='users'){
                const key=match[1].toUpperCase()+'-'+n+'-'+match[3];
                if(nijSeen.has(key))warnings.push({code:'EXISTING_DUPLICATE_NIJ',id:record.id});
                nijSeen.add(key);
            }
        }
        function reserve(key,id){if(claims.has(key)&&claims.get(key)!==id)issue('DUPLICATE_CONTACT',id);else claims.set(key,id);}
        for(const r of data.users){
            const d=r.data;
            const email=typeof d.email==='string'?d.email.trim().toLowerCase():'';
            const phone=api.normalizePhone(d.whatsapp);
            if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))issue('EMAIL_REVIEW_REQUIRED',r.id);
            else {reserve(api.emailKey(email),r.id);if(d.email_normalized!==undefined&&d.email_normalized!==email)issue('EMAIL_NORMALIZATION_MISMATCH',r.id);}
            if(!/^62[0-9]{8,13}$/.test(phone))issue('PHONE_REVIEW_REQUIRED',r.id);
            else {reserve('phone_'+phone,r.id);if(d.whatsapp_normalized!==undefined&&d.whatsapp_normalized!==phone)issue('PHONE_NORMALIZATION_MISMATCH',r.id);}
            nij(r,'users');
        }
        for(const r of data.allocations)nij(r,'nij_allocations');
        for(const r of data.counters){
            if(!regions.includes(r.id)||!validNumber(r.data.last)||Object.keys(r.data).some(k=>!['last','updatedAt'].includes(k)))issue('COUNTER_REVIEW_REQUIRED',r.id);
            else counters[r.id]=Math.max(counters[r.id],r.data.last);
        }
        const existing=new Map(data.claims.map(r=>[r.id,r.data.uid]));
        const writes=[];
        for(const [key,uid] of claims)if(existing.get(key)!==uid)writes.push({key,uid});
        const removes=[];
        for(const r of data.claims){
            if(!/^(email_|phone_)/.test(r.id)||typeof r.data.uid!=='string'||Object.keys(r.data).some(k=>!['uid','createdAt'].includes(k)))issue('UNKNOWN_REGISTRY_DOCUMENT',r.id);
            else if(!claims.has(r.id))removes.push(r.id);
        }
        const countMap=new Map(data.counters.map(r=>[r.id,r.data.last]));
        const counterWrites=Object.entries(counters).filter(([r,n])=>countMap.get(r)!==n).map(([region,last])=>({region,last}));
        const projection=data.users.map(r=>({id:r.id,...Object.fromEntries(['uid','email','email_normalized','whatsapp','whatsapp_normalized','nij','nij_number','wilayah'].filter(k=>Object.hasOwn(r.data,k)).map(k=>[k,r.data[k]]))})).sort((a,b)=>a.id.localeCompare(b.id));
        const allocationProjection=data.allocations.map(r=>({id:r.id,nij:r.data.nij,nij_number:r.data.nij_number})).sort((a,b)=>a.id.localeCompare(b.id));
        const counterProjection=data.counters.map(r=>({id:r.id,last:r.data.last})).sort((a,b)=>a.id.localeCompare(b.id));
        return {issues,warnings,counters,writes,removes,counterWrites,profileCount:data.users.length,
            source:JSON.stringify([projection,allocationProjection,counterProjection]),identities:JSON.stringify([projection,allocationProjection])};
    }
    async function hash(text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
    function create(db,auth,stamp){
        const project=db.app.options.projectId;
        if(!['boby-apps-project','demo-sipapua-original'].includes(project)||auth.app.options.projectId!==project)throw error('WRONG_PROJECT');
        const state=db.doc('registration_control/state');
        function same(user){if(!user||auth.currentUser?.uid!==user.uid)throw error('SESSION_CHANGED');}
        async function manager(){
            const user=auth.currentUser;same(user);
            const snap=await db.doc('admin_users/'+user.uid).get({source:'server'});same(user);
            if(!snap.exists||snap.data().status!=='active'||!['master','super_admin'].includes(snap.data().role))throw error('ACTIVE_MANAGER_REQUIRED');
            return user;
        }
        async function scan(){
            const user=await manager(),data={};
            for(const [key,collection] of Object.entries({users:'users',allocations:'nij_allocations',counters:'nij_counters',claims:'registration_unique'})){
                const snap=await db.collection(collection).get({source:'server'});same(user);
                if(snap.metadata.fromCache||snap.metadata.hasPendingWrites)throw error('SERVER_READ_REQUIRED');
                data[key]=snap.docs.map(d=>({id:d.id,data:d.data()}));
            }
            const p=plan(data),control=await state.get({source:'server'});same(user);
            if(control.exists&&control.data().version!==api.version)throw error('UNKNOWN_PREPARATION_VERSION');
            return {user,p,control,fingerprint:await hash(p.source)};
        }
        function report(s){return {projectId:project,profileCount:s.p.profileCount,issues:s.p.issues,warnings:s.p.warnings,counters:s.p.counters,
            claimWrites:s.p.writes.length,claimRemovals:s.p.removes.length,counterWrites:s.p.counterWrites.length,
            prepared:s.p.issues.length===0&&!s.p.writes.length&&!s.p.removes.length&&!s.p.counterWrites.length,
            enabled:s.control.exists&&s.control.data().enabled===true,fingerprint:s.fingerprint};}
        async function audit(){return report(await scan());}
        async function abort(){
            const user=await manager();
            await db.runTransaction(async tx=>{same(user);const c=await tx.get(state);if(c.exists){if(c.data().enabled===true)throw error('REGISTRATION_ALREADY_OPEN');tx.delete(state);}});
        }
        async function prepare(expectedFingerprint){
            const before=await scan();
            if(before.fingerprint!==expectedFingerprint)throw error('SOURCE_CHANGED_REVIEW_AGAIN');
            if(before.p.issues.length)throw error('LEGACY_DATA_REVIEW_REQUIRED');
            if(before.control.exists&&before.control.data().enabled===true)throw error('REGISTRATION_ALREADY_OPEN');
            await db.runTransaction(async tx=>{same(before.user);const c=await tx.get(state);if(c.exists&&c.data().enabled===true)throw error('REGISTRATION_ALREADY_OPEN');tx.set(state,{enabled:false,version:api.version,preparedAt:stamp()});});
            try {
                const frozen=await scan();
                if(frozen.fingerprint!==before.fingerprint)throw error('SOURCE_CHANGED_REVIEW_AGAIN');
                const operations=[...frozen.p.writes.map(r=>({type:'set',path:'registration_unique/'+r.key,data:{uid:r.uid,createdAt:stamp()}})),
                    ...frozen.p.removes.map(key=>({type:'delete',path:'registration_unique/'+key})),
                    ...frozen.p.counterWrites.map(r=>({type:'set',path:'nij_counters/'+r.region,data:{last:r.last,updatedAt:stamp()}}))];
                for(let i=0;i<operations.length;i+=100){same(before.user);const batch=db.batch();for(const op of operations.slice(i,i+100)){const ref=db.doc(op.path);if(op.type==='set')batch.set(ref,op.data);else batch.delete(ref);}await batch.commit();}
                const after=await scan();
                if(after.p.identities!==before.p.identities||!report(after).prepared)throw error('PREPARATION_NOT_CONFIRMED');
                return report(after);
            } catch(e){
                // Registration stays closed if abort succeeds; member profiles were never written.
                try {await abort();}catch(_){throw error('PREPARATION_INTERRUPTED_ADMIN_REVIEW_REQUIRED');}
                throw e;
            }
        }
        async function enable(expectedFingerprint){
            const s=await scan();if(s.fingerprint!==expectedFingerprint)throw error('SOURCE_CHANGED_REVIEW_AGAIN');
            if(!report(s).prepared||!s.control.exists)throw error('PREPARATION_REQUIRED');
            await db.runTransaction(async tx=>{same(s.user);const c=await tx.get(state);if(!c.exists||c.data().version!==api.version)throw error('PREPARATION_REQUIRED');tx.set(state,{enabled:true,version:api.version,preparedAt:stamp()});});
            return {projectId:project,enabled:true};
        }
        return Object.freeze({audit,prepare,enable,abort});
    }
    const exported=Object.freeze({create,plan});root.SIPAPUA_REGISTRATION_PREPARATION=exported;
    if(typeof module==='object'&&module.exports)module.exports=exported;
})(typeof window==='object'?window:globalThis);
