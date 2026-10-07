(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.loading) return;

    var RESULT_VISIBLE_MS = 1500;
    var loadingCounter = 0;

    // Unknown or missing targets fall back to the notification root instead of throwing.
    function resolveTarget(manager, target) {
        var node = typeof target === "string" ? document.querySelector(target) : target;
        return node && typeof node.appendChild === "function" ? node : manager.roots.notification;
    }

    // Lifecycle is explicit: the loading stays until the caller hides/finishes it.
    // The watchdog only updates the message; it never hides the loading on its own.
    function show(manager, options) {
        options = options || {};
        loadingCounter += 1;
        var key = options.operationKey || ("__sip-loading-auto-" + loadingCounter);
        if (manager.loadings[key]) return manager.loadings[key].handle;
        var node = document.createElement("div");
        node.className = "sip-loading sip-loading-" + (options.scope || "action");
        node.setAttribute("role", "status");
        node.setAttribute("aria-live", "polite");
        node.textContent = options.message || "Sedang memproses...";
        resolveTarget(manager, options.target).appendChild(node);
        var state = "loading";
        var watchdogTimer = options.watchdog ? setTimeout(function () {
            if (state === "loading") {
                node.setAttribute("data-watchdog", "warning");
                node.textContent = options.watchdogMessage || "Operasi masih diproses. Mohon tunggu.";
            }
        }, options.watchdog) : null;
        var handle = {
            hide: function () { finish("hidden"); },
            success: function (message) { finish("success", message || "Berhasil."); },
            error: function (message) { finish("error", message || "Operasi gagal."); },
            cancel: function () { finish("cancelled"); }
        };
        function finish(next, message) {
            if (state !== "loading") return;
            state = next;
            if (watchdogTimer) clearTimeout(watchdogTimer);
            // Free the key right away so the same operation can start a new loading.
            if (manager.loadings[key] && manager.loadings[key].handle === handle) delete manager.loadings[key];
            if (message) {
                node.removeAttribute("data-watchdog");
                node.textContent = message;
                setTimeout(function () { node.remove(); }, RESULT_VISIBLE_MS);
            } else {
                node.remove();
            }
        }
        manager.loadings[key] = { handle: handle, node: node, startedAt: Date.now(), watchdog: options.watchdog || null };
        return handle;
    }

    registry.loading = { show: show };
}(window));
