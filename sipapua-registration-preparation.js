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
        for(const [key,uid] of claims){if(existing.has(key)&&existing.get(key)!==uid)issue('IDENTITY_RESERVATION_CONFLICT',key);else if(!existing.has(key))writes.push({key,uid});}
        const removes=[];
        for(const r of data.claims){
            if(!/^(email_|phone_)/.test(r.id)||typeof r.data.uid!=='string'||Object.keys(r.data).some(k=>!['uid','createdAt'].includes(k)))issue('UNKNOWN_REGISTRY_DOCUMENT',r.id);
            // Permanent old reservations are retained; no removal operation is planned.
        }
        const countMap=new Map(data.counters.map(r=>[r.id,r.data.last]));
        const counterWrites=Object.entries(counters).filter(([r,n])=>countMap.get(r)!==n).map(([region,last])=>({region,last}));
        const projection=data.users.map(r=>({id:r.id,...Object.fromEntries(['uid','email','email_normalized','whatsapp','whatsapp_normalized','nij','nij_number','wilayah'].filter(k=>Object.hasOwn(r.data,k)).map(k=>[k,r.data[k]]))})).sort((a,b)=>a.id.localeCompare(b.id));
        const allocationProjection=data.allocations.map(r=>({id:r.id,nij:r.data.nij,nij_number:r.data.nij_number})).sort((a,b)=>a.id.localeCompare(b.id));
        const counterProjection=data.counters.map(r=>({id:r.id,last:r.data.last})).sort((a,b)=>a.id.localeCompare(b.id));
        return {issues,warnings,counters,writes,removes,counterWrites,profileCount:data.users.length,
            source:JSON.stringify([projection,allocationProjection,counterProjection]),identities:JSON.stringify([projection,allocationProjection])};
    }
    // Analysis remains pure; all database access and mutations belong to backend.
    function create(db,auth,stamp,functions){
        async function call(name,data){
            const user=auth.currentUser;
            if(!user)throw error("ACTIVE_MANAGER_REQUIRED");
            const invoke=functions?functions.httpsCallable(name):root.SIPAPUA_MEMBER_SESSION.create(root.firebase).callable(name);
            const response=await invoke(data);
            if(auth.currentUser?.uid!==user.uid)throw error("SESSION_CHANGED");
            return response.data;
        }
        async function audit(){return call("auditSIPAPUARegistry",{});}
        async function prepare(fingerprint){await call("prepareSIPAPUARegistry",{fingerprint});return audit();}
        async function enable(fingerprint){await call("enableSIPAPUARegistry",{fingerprint});return audit();}
        async function abort(){const report=await audit();return call("abortSIPAPUARegistry",{fingerprint:report.fingerprint});}
        return Object.freeze({audit,prepare,enable,abort});
    }
    const exported=Object.freeze({create,plan});root.SIPAPUA_REGISTRATION_PREPARATION=exported;
    if(typeof module==='object'&&module.exports)module.exports=exported;
})(typeof window==='object'?window:globalThis);
