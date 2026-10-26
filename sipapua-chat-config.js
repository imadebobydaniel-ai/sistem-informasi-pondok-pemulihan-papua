// SIPAPUA CHAT feature gates, one per feature:
//   enabled       private 1:1 chat (chat.html, CHAT button in kontak.html)
//   groupEnabled  the default group room (chat-group.html, CHAT GRUP BERSAMA
//                 in kontak.html)
// Both need rules that are NOT deployed to Production
// (firestore.chat-policy-draft.rules). While a gate is false its button is shown
// disabled and its page makes no Firestore call at all. Set a gate to true only
// after those rules are reviewed and deployed with the PO's approval.
(function () {
    var enabled = true;
    var groupEnabled = true;
    window.SIPAPUA_CHAT = Object.freeze({
        isEnabled: function () { return enabled === true; },
        isGroupEnabled: function () { return groupEnabled === true; },
        message: "Chat pribadi belum tersedia. Fitur ini sedang disiapkan oleh pengurus SIPAPUA.",
        groupMessage: "Chat grup belum tersedia. Fitur ini sedang disiapkan oleh pengurus SIPAPUA."
    });
})();
