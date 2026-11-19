(function (root) {
    "use strict";

    // Candidate adapter for the QR result page. The existing camera handoff and
    // callable helper retain ownership of navigation, Auth and App Check.
    function createQrIntroduction(card = root.SIPAPUA_MEMBER_CARD) {
        let proof = null;
        let busy = false;

        async function scanPending() {
            if (busy) throw new Error("Permintaan QR sedang diproses.");
            if (card.paused()) throw new Error(card.message());
            proof = null;
            const token = card.takeScan();
            if (!token) throw new Error("Kartu QR tidak tersedia.");
            busy = true;
            try {
                const result = await card.call("scanQrIntroduction", { token });
                proof = { receipt: result.receipt, expiresAt: result.expiresAt };
                return result.member;
            } finally {
                busy = false;
            }
        }

        async function requestFriendship() {
            if (busy) throw new Error("Permintaan QR sedang diproses.");
            if (!proof || !(proof.expiresAt > Date.now())) {
                proof = null;
                throw new Error("Pindai ulang kartu QR.");
            }
            busy = true;
            try {
                const result = await card.call("requestQrIntroduction", { receipt: proof.receipt });
                proof = null;
                return result;
            } finally {
                busy = false;
            }
        }

        return Object.freeze({ scanPending, requestFriendship });
    }

    root.SIPAPUA_QR_INTRODUCTION = Object.freeze({ create: createQrIntroduction });
})(window);
