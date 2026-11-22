import {issue,profile,showProfile} from './demo-core.mjs';

const qr=document.getElementById("qr");
const status=document.getElementById("status");
let timer;
showProfile(profile);
document.getElementById("issue").onclick=()=>{
    clearTimeout(timer);
    qr.replaceChildren();
    const {payload,expires}=issue();
    try {
        new QRCode(qr,{text:payload,width:240,height:240,correctLevel:QRCode.CorrectLevel.M});
        status.textContent="QR demo siap dipindai.";
        timer=setTimeout(()=>{
            qr.replaceChildren();
            status.textContent="QR demo kedaluwarsa. Buat QR baru.";
        },Math.max(0,expires-Date.now()));
    } catch {
        qr.replaceChildren();
        status.textContent="QR demo tidak dapat dibuat.";
    }
};
addEventListener("pagehide",()=>clearTimeout(timer));
