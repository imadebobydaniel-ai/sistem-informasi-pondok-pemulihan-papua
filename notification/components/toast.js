(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.toast) return;

    var DEFAULT_TITLES = { success: "Berhasil", error: "Gagal", warning: "Peringatan", info: "Informasi" };
    var MIN_RESUME_MS = 1000;

    function create(manager, type, options) {
        options = options || {};
        // A toast with the same dedupeKey already shown or queued is returned as-is.
        var item = { dedupeKey: options.dedupeKey, handle: null, onVisible: null };
        var entry = manager.queue.add(item);
        if (entry.item !== item) return entry.item.handle;

        var node = document.createElement("article");
        node.className = "sip-notification sip-notification-" + type;
        node.setAttribute("role", type === "error" ? "alert" : "status");
        node.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
        var title = document.createElement("strong");
        title.className = "sip-notification-title";
        title.textContent = options.title || DEFAULT_TITLES[type] || "";
        var message = document.createElement("p");
        message.className = "sip-notification-message";
        message.textContent = options.message || "";
        var close = document.createElement("button");
        close.type = "button";
        close.className = "sip-notification-close";
        close.setAttribute("aria-label", "Tutup notifikasi");
        close.textContent = "×";
        node.appendChild(title);
        node.appendChild(message);
        node.appendChild(close);

        var closed = false;
        var timer = null;
        var remaining = options.duration === 0 ? 0 : (options.duration || manager.defaults[type]);
        var startedAt = 0;
        var hovered = false;
        var focused = false;

        function closeNode() {
            if (closed) return;
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            node.remove();
            manager.releaseToast(entry);
        }

        function startTimer() {
            if (closed || !remaining || timer || hovered || focused) return;
            startedAt = Date.now();
            timer = setTimeout(closeNode, remaining);
        }

        // Timed toasts pause while the user hovers or focuses them (WCAG 2.2.1).
        function pauseTimer() {
            if (!timer) return;
            clearTimeout(timer);
            timer = null;
            remaining = Math.max(MIN_RESUME_MS, remaining - (Date.now() - startedAt));
        }

        function show() {
            if (closed) return;
            if (!node.isConnected) manager.roots.notification.appendChild(node);
            startTimer();
        }

        close.addEventListener("click", closeNode);
        node.addEventListener("mouseenter", function () { hovered = true; pauseTimer(); });
        node.addEventListener("mouseleave", function () { hovered = false; startTimer(); });
        node.addEventListener("focusin", function () { focused = true; pauseTimer(); });
        node.addEventListener("focusout", function () { focused = false; startTimer(); });

        item.onVisible = show;
        item.handle = { close: closeNode, isOpen: function () { return !closed; } };
        if (entry.state === "visible") show();
        return item.handle;
    }

    registry.toast = { create: create };
}(window));
