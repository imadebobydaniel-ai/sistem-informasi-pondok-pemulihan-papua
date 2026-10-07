(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.lifecycle) return;

    var ROOT_ATTR = "data-sipapua-notification-root";
    var MODAL_ATTR = "data-sipapua-modal-root";
    var LIVE_ATTR = "data-sipapua-live-region";
    var idCounter = 0;
    var modalStack = [];

    function host() {
        return document.body || document.documentElement;
    }

    function findOrCreate(attr) {
        var existing = document.querySelector("[" + attr + "]");
        if (existing) return existing;
        var node = document.createElement("div");
        node.setAttribute(attr, "true");
        host().appendChild(node);
        return node;
    }

    function liveRegion() {
        var live = findOrCreate(LIVE_ATTR);
        live.setAttribute("role", "status");
        live.setAttribute("aria-live", "polite");
        live.setAttribute("aria-atomic", "true");
        return live;
    }

    // Roots resolve on access, so the scripts may load in <head> before <body> exists and a
    // root removed by the page is recreated instead of throwing. They are created up front
    // when <body> is already available.
    function roots() {
        var api = Object.create(null, {
            notification: { enumerable: true, get: function () { return findOrCreate(ROOT_ATTR); } },
            modal: { enumerable: true, get: function () { return findOrCreate(MODAL_ATTR); } },
            live: { enumerable: true, get: liveRegion }
        });
        if (document.body) {
            void api.notification;
            void api.modal;
            void api.live;
        }
        return api;
    }

    function uid(prefix) {
        idCounter += 1;
        return (prefix || "sip") + "-" + idCounter;
    }

    function focusable(container) {
        return Array.prototype.slice.call(container.querySelectorAll(
            "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"
        ));
    }

    // Only the top-most open dialog reacts to Escape/Tab, so stacked dialogs close one at a time.
    function trapFocus(container, onEscape) {
        var layer = { container: container };
        modalStack.push(layer);

        function keydown(event) {
            if (event.__sipapuaModalHandled || modalStack[modalStack.length - 1] !== layer) return;
            if (event.key === "Escape") {
                event.__sipapuaModalHandled = true;
                event.preventDefault();
                if (onEscape) onEscape(event);
                return;
            }
            if (event.key !== "Tab") return;
            event.__sipapuaModalHandled = true;
            var nodes = focusable(container);
            if (!nodes.length) {
                event.preventDefault();
                return;
            }
            var first = nodes[0];
            var last = nodes[nodes.length - 1];
            if (!container.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }

        document.addEventListener("keydown", keydown);
        return function release() {
            document.removeEventListener("keydown", keydown);
            var index = modalStack.indexOf(layer);
            if (index >= 0) modalStack.splice(index, 1);
        };
    }

    function restoreFocus(previous) {
        if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus();
    }

    registry.lifecycle = { roots: roots, trapFocus: trapFocus, restoreFocus: restoreFocus, uid: uid };
}(window));
