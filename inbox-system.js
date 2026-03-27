// inbox-system.js
const InboxSystem = {
    // 1. FUNGSI MONITOR DAFTAR PESAN
    monitor: function(userJC, userEmail) {
        if (typeof db === 'undefined') return console.error("Firestore belum terinisialisasi!");

        // Membaca 'pengumuman_komsel' agar sinkron dengan portal input kegiatan
        db.collection("pengumuman_komsel")
            .orderBy("timestamp", "desc")
            .onSnapshot(snapshot => {
                let unreadCount = 0;
                const listDiv = document.getElementById('list-pesan');
                if (!listDiv) return;

                listDiv.innerHTML = "";

                if (snapshot.empty) {
                    listDiv.innerHTML = "<p style='text-align:center; color:#999; padding:20px; font-size:12px;'>Belum ada informasi terbaru.</p>";
                    return;
                }

                snapshot.forEach(doc => {
                    const data = doc.data();
                    const docId = doc.id;
                    
                    // MODIFIKASI DIAGNOSA: Memaksa tampil tanpa filter target
                    if (true) { 
                        const readBy = data.readBy || [];
                        const isUnread = !readBy.includes(userEmail);

                        if (isUnread) unreadCount++;

                        let tgl = "";
                        if (data.timestamp) {
                            const d = data.timestamp.toDate();
                            tgl = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                        }

                        // Membuat elemen item pesan
                        const item = document.createElement('div');
                        item.className = `msg-item ${isUnread ? 'unread' : ''}`;
                        item.style = `
                            display: flex; align-items: center; padding: 12px; 
                            border-bottom: 1px solid #eee; cursor: pointer;
                            background: ${isUnread ? '#fff9e6' : '#fff'};
                            border-left: 4px solid ${isUnread ? '#D4AF37' : 'transparent'};
                        `;
                        
                        item.innerHTML = `
                            <div style="flex:1">
                                <div style="font-weight:bold; font-size:13px; color:#003366;">${data.judul || 'Info Terbaru'}</div>
                                <div style="font-size:11px; color:#888;">${tgl} • ${data.kategori || 'Umum'} ${isUnread ? '• <b style="color:red;">BARU</b>' : ''}</div>
                            </div>
                            <i class="fas fa-chevron-right" style="font-size:10px; color:#ccc;"></i>
                        `;

                        item.onclick = () => this.bukaDetail(docId, userEmail);
                        listDiv.appendChild(item);
                    }
                });

                // Update badge notifikasi
                const badge = document.getElementById('email-badge');
                if (badge) {
                    badge.innerText = unreadCount;
                    badge.style.display = unreadCount > 0 ? 'block' : 'none';
                }
            });
    },

    // 2. FUNGSI BUKA DETAIL PESAN
    bukaDetail: function(docId, userEmail) {
        db.collection("pengumuman_komsel").doc(docId).get().then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                const listDiv = document.getElementById('list-pesan');
                
                listDiv.innerHTML = `
                    <div style="padding:15px; animation: fadeIn 0.3s ease;">
                        <button onclick="InboxSystem.monitor('${data.target}', '${userEmail}')" style="border:none; background:none; color:#007bff; font-weight:bold; cursor:pointer; margin-bottom:10px; padding:0;">
                            <i class="fas fa-arrow-left"></i> Kembali
                        </button>
                        <h3 style="margin:0 0 5px 0; font-size:18px; color:#003366;">${data.judul}</h3>
                        <div style="font-size:11px; color:#888; margin-bottom:15px;">
                            ${data.kategori} | ${data.timestamp ? data.timestamp.toDate().toLocaleString('id-ID') : ''}
                        </div>
                        <hr style="border:0; border-top:1px solid #eee; margin:15px 0;">
                        
                        <div style="white-space:pre-wrap; color:#333; line-height:1.6; font-size:14px;">${data.isi_pesan || "Isi pesan kosong."}</div>
                        
                        <div style="margin-top:40px; font-size:10px; color:#bbb; border-top:1px solid #f9f9f9; padding-top:10px;">
                            ID Pesan: ${docId}
                        </div>
                    </div>`;

                // Tandai sudah dibaca
                db.collection("pengumuman_komsel").doc(docId).update({
                    readBy: firebase.firestore.FieldValue.arrayUnion(userEmail)
                });
            }
        }).catch(err => console.error("Gagal memuat pesan:", err));
    }
};
