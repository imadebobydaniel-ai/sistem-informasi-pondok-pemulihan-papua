// Registration stays paused until the Spark security and production gates pass.
// Do not unpause solely because local happy-path tests pass. Member cards keep
// their existing maintenance state pending a separate secure implementation.
//   registration: registrasi.html (checkRegistrationDuplicate, getNextNijNumber, allocateNij)
//   memberCard:   QR card in menu.html (getMyCardToken) and every card scan:
//                 qrcode.html, bio-singkat-jemaat.html, menu.html (lookupMemberCard)
(function () {
    var paused = { registration: true, memberCard: true };
    var messages = {
        registration: "Pendaftaran anggota baru sedang dalam pemeliharaan untuk peningkatan keamanan data jemaat. " +
            "Silakan coba kembali dalam beberapa waktu atau hubungi pengurus Pondok Pemulihan Papua.",
        memberCard: "Kartu QR dan pemindaian kartu jemaat sedang dalam pemeliharaan untuk peningkatan keamanan data jemaat. " +
            "Fitur lain SIPAPUA tetap dapat digunakan seperti biasa."
    };
    window.SIPAPUA_MAINTENANCE = Object.freeze({
        isPaused: function (feature) { return paused[feature] === true; },
        message: function (feature) { return messages[feature] || ""; }
    });
})();
