// inbox-system.js
const InboxSystem = {
    // Fungsi Monitor Pesan Secara Realtime
    monitor: function(userJC, userEmail) {
        if (!db) return console.error("Firestore belum terinisialisasi!");

        // DISESUAIKAN: Mengarah ke portal_media sesuai link Firebase Anda
        db.collection("portal_media")
            .orderBy("timestamp", "desc")
            .onSnapshot(snapshot => {
                let unreadCount = 0;
                const listDiv = document.getElementById('list-pesan');
                if (!listDiv) return;

                listDiv.innerHTML = "";

                if (snapshot.empty) {
                    listDiv.innerHTML = "<p style='text-align:center; color:#999; padding:20px; font-size:12px;'>Belum ada pesan untuk Anda.</p>";
                    return;
                }

                snapshot.forEach(doc => {
                    const data = doc.data();
                    const docId = doc.id;
                    
                    // Filter berdasarkan target atau JC
                    const target = data.target || data.target_jc || "Semua JC";

                    if (target === "Semua JC" || String(target) === String(userJC)) {
                        const sudahDibaca = data.sudahDibaca || [];
                        const isUnread = !sudahDibaca.includes(userEmail);

                        if (isUnread) unreadCount++;

                        let tgl = "";
                        if (data.timestamp) {
                            const d = data.timestamp.toDate();
                            tgl = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                        }

                        const item = document.createElement('div');
                        item.className = 'msg-item';
                        item.style = `
                            display: flex; align-items: center; padding: 12px; 
                            border-bottom: 1px solid #eee; cursor: pointer;
                            background: ${isUnread ? '#fff9e6' : '#fff'};
                            border-left: 4px solid ${isUnread ? '#D4AF37' : 'transparent'};
                        `;
                        
                        item.innerHTML = `
                            <div style="flex:1">
                                <div style="font-weight:bold; font-size:13px; color:#003366;">${data.judul || 'Info Terbaru'}</div>
                                <div style="font-size:11px; color:#888;">${tgl} • ${isUnread ? '<b style="color:red;">BARU</b>' : 'Sudah dibaca'}</div>
                            </div>
                            <i class="fas fa-chevron-right" style="font-size:10px; color:#ccc;"></i>
                        `;

                        item.onclick = () => this.bukaDetail(docId, userEmail);
                        listDiv.appendChild(item);
                    }
                });

                const badge = document.getElementById('email-badge');
                if (badge) {
                    if (unreadCount > 0) {
                        badge.style.display = 'block';
                        badge.innerText = unreadCount;
                    } else {
                        badge.style.display = 'none';
                    }
                }
            });
    },

    bukaDetail: function(docId, userEmail) {
        // DISESUAIKAN: Mengarah ke portal_media
        db.collection("portal_media").doc(docId).get().then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                
                document.getElementById('list-pesan').style.display = 'none';
                document.getElementById('detail-pesan-konten').style.display = 'block';

                document.getElementById('detail-judul').innerText = data.judul || "Detail Pesan";
                // Mendukung field 'isi' atau 'pesan' sesuai input Anda
                document.getElementById('detail-isi').innerText = data.isi || data.pesan || "Konten tidak tersedia.";

                db.collection("portal_media").doc(docId).update({
                    sudahDibaca: firebase.firestore.FieldValue.arrayUnion(userEmail)
                });
            }
        });
    }
};

function kembaliKeList() {
    document.getElementById('list-pesan').style.display = 'block';
    document.getElementById('detail-pesan-konten').style.display = 'none';
}
