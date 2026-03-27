// inbox-system.js
const InboxSystem = {
    // Fungsi Monitor Pesan Secara Realtime
    monitor: function(userJC, userEmail) {
        if (!db) return console.error("Firestore belum terinisialisasi!");

        db.collection("pengumuman_komsel")
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
                    const target = data.target || data.target_jc;

                    // Filter: Kirim ke Semua atau ke JC spesifik user
                    if (target === "Semua JC" || String(target) === String(userJC)) {
                        const sudahDibaca = data.sudahDibaca || [];
                        const isUnread = !sudahDibaca.includes(userEmail);

                        if (isUnread) unreadCount++;

                        // Format Tanggal
                        let tgl = "";
                        if (data.timestamp) {
                            const d = data.timestamp.toDate();
                            tgl = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                        }

                        // Buat Baris Pesan
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
                                <div style="font-weight:bold; font-size:13px; color:#003366;">${data.judul || 'Tanpa Judul'}</div>
                                <div style="font-size:11px; color:#888;">${tgl} • ${isUnread ? '<b style="color:red;">BARU</b>' : 'Sudah dibaca'}</div>
                            </div>
                            <i class="fas fa-chevron-right" style="font-size:10px; color:#ccc;"></i>
                        `;

                        item.onclick = () => this.bukaDetail(docId, userEmail);
                        listDiv.appendChild(item);
                    }
                });

                // Update Angka di Icon Amplop
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

    // Fungsi untuk menampilkan isi pesan (Ganti List jadi Detail)
    bukaDetail: function(docId, userEmail) {
        db.collection("pengumuman_komsel").doc(docId).get().then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                
                // Sembunyikan List, Tampilkan Detail
                document.getElementById('list-pesan').style.display = 'none';
                document.getElementById('detail-pesan-konten').style.display = 'block';

                // Isi Konten
                document.getElementById('detail-judul').innerText = data.judul || "Detail Pesan";
                document.getElementById('detail-isi').innerText = data.isi || data.pesan || "Tidak ada isi pesan.";

                // Update status baca di Firebase (Hanya jika belum ada di list sudahDibaca)
                db.collection("pengumuman_komsel").doc(docId).update({
                    sudahDibaca: firebase.firestore.FieldValue.arrayUnion(userEmail)
                });
            }
        });
    }
};

// Fungsi pembantu untuk tombol kembali
function kembaliKeList() {
    document.getElementById('list-pesan').style.display = 'block';
    document.getElementById('detail-pesan-konten').style.display = 'none';
}
