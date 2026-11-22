export const lifetime = 5 * 60_000;
export const profile = Object.freeze({name:"Nara Demo",nij:"DEMO-NIJ-001",group:"Komsel Demo"});
const prefix = "SIPAPUA-STATIC-DEMO-V1:sample-001:";
const pattern = /^SIPAPUA-STATIC-DEMO-V1:sample-001:([0-9]{13})$/;

export function issue(now = Date.now()) {
    const expires = now + lifetime;
    return {payload:prefix + expires, expires};
}

export function read(payload, now = Date.now()) {
    const match = typeof payload === "string" && pattern.exec(payload);
    if (!match || match[0] !== payload) return {status:"invalid"};
    const expires = Number(match[1]);
    if (expires <= now) return {status:"expired"};
    if (expires > now + lifetime) return {status:"invalid"};
    return {status:"accepted",profile};
}

export function showProfile(value) {
    for (const key of ["name","nij","group"]) document.getElementById(key).textContent=value[key];
}
