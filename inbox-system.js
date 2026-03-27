// inbox-system.js
// Script khusus untuk menangani Inbox tanpa mengganggu script utama

const InboxSystem = {
    // 1. Fungsi Monitor Pesan (Realtime)
    monitor: function(userJC, userEmail) {
        db.collection("pengumuman_komsel")
          .orderBy("timestamp", "desc")
          .onSnapshot(snapshot => {
            let unreadCount = 0;
            const listDiv = document.getElementById('list-pesan');
            if (!listDiv) return;

            listDiv.innerHTML = "";
            snapshot.forEach(doc => {
                const data = doc.data();
                const target = data.target || data.target_jc;
                
                // Pastikan target cocok (String comparison)
                if (target === "Semua JC" || String(target) === String(userJC)) {
                    const sudahDibaca = data.sudahDibaca || [];
                    const isUnread = !sudahDibaca.includes(userEmail);
                    if (isUnread) unreadCount++;

                    this.renderItem(doc.id, data, isUnread, userEmail);
                }
            });
            this.updateBadge(unreadCount);
        });
    },

    // 2. Render Item ke List
    renderItem: function(docId, data, isUnread, userEmail) {
        const listDiv = document.getElementById('list-pesan');
        const item = document.createElement('div');
        item.className = 'msg-item';
        item.style.cssText = `padding:15px; border-bottom:1px solid #eee; cursor:pointer; background:${isUnread ? '#fff9e6' : '#fff'};`;
        
        item.innerHTML = `
            <b style="color:#003366;">${data.judul} ${isUnread ? '<span style="color:red; font-size:10px;">(BARU)</span>' : ''}</b>
            <small style="display:block; color:#888;">${data.timestamp ? data.timestamp.toDate().toLocaleDateString('id-ID') : '-'}</small>
        `;
        
        item.onclick = () => this.bukaDetail(docId, userEmail);
        listDiv.appendChild(item);
    },

    // 3. Fungsi Buka Detail
    bukaDetail: async function(docId, userEmail) {
        try {
            const doc = await db.collection("pengumuman_komsel").doc(docId).get();
            if (doc.exists) {
                const data = doc.data();
                // Deteksi field agar tidak undefined
                const isiPesan = data.isiDetail || data.isi || data.pesan || "Konten tidak tersedia.";
                
                document.getElementById('detail-judul').innerText = data.judul || "Informasi";
                document.getElementById('detail-isi').innerText = isiPesan;

                // Tampilkan Detail, Sembunyikan List
                document.getElementById('list-pesan').style.display = "none";
                document.getElementById('detail-pesan-konten').style.display = "block";

                // Update status baca di background
                db.collection("pengumuman_komsel").doc(docId).update({
                    sudahDibaca: firebase.firestore.FieldValue.arrayUnion(userEmail)
                });
            }
        } catch (e) { console.error("Inbox Error:", e); }
    },

    updateBadge: function(count) {
        const badge = document.getElementById('email-badge');
        const icon = document.getElementById('icon-mail');
        if (badge) {
            badge.innerText = count;
            badge.style.display = count > 0 ? 'block' : 'none';
        }
        if (icon) {
            count > 0 ? icon.classList.add('vibrate') : icon.classList.remove('vibrate');
        }
    }
};
