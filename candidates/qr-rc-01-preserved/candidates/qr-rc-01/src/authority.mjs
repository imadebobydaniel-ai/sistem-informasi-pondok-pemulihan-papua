// Reference authority for a private, Owner-approved runtime. No credentials or public route.
export function createQrAuthority({auth, appCheck, firestore, expectedAppId}) {
  async function authorize({idToken, appToken, uid, authTime, appId}) {
    if (appId !== expectedAppId) return {allowed:false};
    let identity;
    try { identity = await auth.verifyIdToken(idToken, true); }
    catch (error) {
      if (['auth/id-token-revoked','auth/user-disabled','auth/user-not-found','auth/argument-error',
        'auth/invalid-id-token','auth/id-token-expired'].includes(error?.code)) return {allowed:false};
      throw error;
    }
    if (identity.uid !== uid || identity.auth_time !== authTime ||
        identity.firebase?.sign_in_provider === 'anonymous') return {allowed:false};
    let attestation;
    try { attestation = await appCheck.verifyToken(appToken,{consume:true}); }
    catch (error) {
      if (['app-check/invalid-argument','app-check/invalid-token','app-check/token-expired'].includes(error?.code)) return {allowed:false};
      throw error;
    }
    if (attestation.appId !== expectedAppId || attestation.alreadyConsumed !== false) return {allowed:false};
    return {allowed:true,uid,authTime,appId};
  }

  async function owner({uid,authTime}) {
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !Number.isSafeInteger(authTime)) return {active:false};
    let account;
    try { account=await auth.getUser(uid); }
    catch (error) { if(error?.code==='auth/user-not-found')return {active:false}; throw error; }
    const cutoff=Date.parse(account.tokensValidAfterTime);
    if(account.uid!==uid||account.disabled||!Number.isFinite(cutoff)||authTime*1000<cutoff)return {active:false};
    const [member,binding]=await firestore.getAll(firestore.doc('users/'+uid),firestore.doc('nij_allocations/'+uid));
    const data=member.data(), allocation=binding.data();
    if(data?.uid!==uid||data.status_akun!=='Aktif'||allocation?.uid!==uid||allocation.nij!==data.nij)return {active:false};
    return {active:true,uid,authTime,profile:{
      nij:allocation.nij,nama:String(data.nama||data.nama_lengkap||'').slice(0,120),
      komsel:String(data.komsel||'').slice(0,80)
    }};
  }

  return Object.freeze({authorize,owner});
}
