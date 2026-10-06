(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.confirmation) return;

    function open(manager, options) {
        options = options || {};
        return new Promise(function (resolve) {
            var previous = document.activeElement;
            var box = document.createElement("section");
            box.className = "sip-modal sip-confirmation";
            box.setAttribute("role", "dialog");
            box.setAttribute("aria-modal", "true");
            if (options.tone) box.setAttribute("data-tone", options.tone);
            var title = document.createElement("h2");
            title.id = manager.lifecycle.uid("sip-confirm-title");
            title.textContent = options.title || "Konfirmasi";
            var message = document.createElement("p");
            message.id = manager.lifecycle.uid("sip-confirm-message");
            message.textContent = options.message || "Lanjutkan tindakan ini?";
            box.setAttribute("aria-labelledby", title.id);
            box.setAttribute("aria-describedby", message.id);
            var cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "sip-modal-cancel";
            cancel.textContent = options.cancelLabel || "Batal";
            var confirm = document.createElement("button");
            confirm.type = "button";
            confirm.className = "sip-modal-confirm";
            confirm.textContent = options.confirmLabel || "Lanjutkan";
            box.appendChild(title);
            box.appendChild(message);
            box.appendChild(cancel);
            box.appendChild(confirm);
            manager.roots.modal.appendChild(box);
            var release = manager.lifecycle.trapFocus(box, function () { finish(false); });
            var done = false;
            function finish(value) {
                if (done) return;
                done = true;
                release();
                box.remove();
                manager.lifecycle.restoreFocus(previous);
                resolve(value);
            }
            cancel.addEventListener("click", function () { finish(false); });
            confirm.addEventListener("click", function () { finish(true); });
            // Enter only confirms when the confirm button itself has focus.
            box.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && document.activeElement === confirm) {
                    event.preventDefault();
                    finish(true);
                }
            });
            (options.initialFocus === "confirm" ? confirm : cancel).focus();
        });
    }

    registry.confirmation = { open: open };
}(window));
