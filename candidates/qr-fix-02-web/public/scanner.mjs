import {read,showProfile} from './demo-core.mjs';

const el=id=>document.getElementById(id);
const preview=el("preview");
const status=text=>{el("status").textContent=text;};
let capture;

function stop() {
    const current=capture;
    capture=undefined;
    clearTimeout(current?.timer);
    current?.stream?.getTracks().forEach(track=>track.stop());
    preview.srcObject=null;
    preview.hidden=true;
    el("camera").disabled=false;
    el("stop").disabled=true;
}

async function start() {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        status("Akses kamera memerlukan HTTPS yang dipercaya browser.");
        return;
    }
    stop();
    el("profile").hidden=true;
    const current=capture={};
    el("camera").disabled=true;
    el("stop").disabled=false;
    status("Menunggu izin kamera.");
    try {
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"}}});
        if (capture!==current) {
            stream.getTracks().forEach(track=>track.stop());
            return;
        }
        current.stream=stream;
        stream.getVideoTracks().forEach(track=>track.addEventListener("ended",()=>{
            if (capture!==current) return;
            stop();
            status("Kamera terputus.");
        },{once:true}));
        preview.srcObject=stream;
        preview.hidden=false;
        await preview.play();
    } catch {
        if (capture!==current) return;
        stop();
        status("Izin kamera ditolak atau kamera tidak tersedia.");
        return;
    }
    if (capture!==current) return;
    status("Arahkan kamera ke QR demo.");
    let detector;
    try {
        if (typeof BarcodeDetector==="function" &&
            (!BarcodeDetector.getSupportedFormats || (await BarcodeDetector.getSupportedFormats()).includes("qr_code"))) {
            detector=new BarcodeDetector({formats:["qr_code"]});
        }
    } catch { /* Fallback to the bundled QR decoder. */ }
    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    async function decode() {
        if (detector) {
            try {
                const result=await detector.detect(preview);
                if (result[0]?.rawValue) return result[0].rawValue;
            } catch { detector=undefined; }
        }
        const ratio=Math.min(1,768/Math.max(preview.videoWidth,preview.videoHeight));
        canvas.width=Math.max(1,Math.round(preview.videoWidth*ratio));
        canvas.height=Math.max(1,Math.round(preview.videoHeight*ratio));
        ctx.drawImage(preview,0,0,canvas.width,canvas.height);
        const {data}=ctx.getImageData(0,0,canvas.width,canvas.height);
        return jsQR(data,canvas.width,canvas.height)?.data;
    }
    async function frame() {
        if (capture!==current) return;
        try {
            const payload=preview.readyState>=2 && preview.videoWidth>0 ? await decode() : "";
            if (capture!==current) return;
            if (!payload) {
                current.timer=setTimeout(frame,160);
                return;
            }
            stop();
            const result=read(payload);
            if (result.status==="accepted") {
                showProfile(result.profile);
                el("profile").hidden=false;
                status("Identitas sintetis cocok.");
            } else {
                status(result.status==="expired"?"QR demo kedaluwarsa.":"Format QR tidak valid untuk demo.");
            }
        } catch {
            if (capture!==current) return;
            stop();
            status("Gambar kamera tidak dapat diproses.");
        }
    }
    void frame();
}

el("camera").onclick=start;
el("stop").onclick=()=>{
    stop();
    status("Kamera ditutup.");
};
addEventListener("pagehide",stop);
document.addEventListener("visibilitychange",()=>{if(document.hidden && capture) stop();});
