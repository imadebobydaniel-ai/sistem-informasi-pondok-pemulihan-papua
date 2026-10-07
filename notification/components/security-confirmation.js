(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.securityConfirmation) return;

    // Resolves { confirmed, verified, reason }. Fails closed: without an expectedPhrase or a
    // verify() callback nothing can be verified, so the action is never confirmed.
    function open(manager, options) {
        options = options || {};
        return new Promise(function (resolve) {
            var previous = document.activeElement;
            var box = document.createElement("section");
            box.className = "sip-modal sip-security-confirmation";
            box.setAttribute("role", "alertdialog");
            box.setAttribute("aria-modal", "true");
            var title = document.createElement("h2");
            title.id = manager.lifecycle.uid("sip-security-title");
            title.textContent = options.title || "Verifikasi keamanan";
            var message = document.createElement("p");
            message.id = manager.lifecycle.uid("sip-security-message");
            message.textContent = options.message || "Konfirmasi tindakan sensitif ini.";
            box.setAttribute("aria-labelledby", title.id);
            box.setAttribute("aria-describedby", message.id);
            var input = document.createElement("input");
            input.type = options.mode === "password" ? "password" : "text";
            input.autocomplete = "off";
            input.setAttribute("aria-label", options.inputLabel || "Verifikasi");
            var error = document.createElement("p");
            error.id = manager.lifecycle.uid("sip-security-error");
            error.className = "sip-security-error";
            error.setAttribute("role", "alert");
            error.hidden = true;
            input.setAttribute("aria-describedby", message.id + " " + error.id);
            var cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = options.cancelLabel || "Batal";
            var confirm = document.createElement("button");
            confirm.type = "button";
            confirm.textContent = options.confirmLabel || "Verifikasi";
            box.appendChild(title);
            box.appendChild(message);
            box.appendChild(input);
            box.appendChild(error);
            box.appendChild(cancel);
            box.appendChild(confirm);
            manager.roots.modal.appendChild(box);
            var release = manager.lifecycle.trapFocus(box, function () { finish(false, "cancelled"); });
            var done = false;
            var verifying = false;
            function finish(confirmed, reason) {
                if (done) return;
                done = true;
                release();
                box.remove();
                manager.lifecycle.restoreFocus(previous);
                resolve({ confirmed: confirmed, verified: confirmed, reason: reason });
            }
            function showError(text) {
                input.setAttribute("aria-invalid", "true");
                error.textContent = text;
                error.hidden = false;
                input.focus();
            }
            function attempt() {
                if (done || verifying) return;
                if (options.expectedPhrase === undefined && typeof options.verify !== "function") {
                    finish(false, "verification-not-configured");
                    return;
                }
                // Exact match, like the existing prompt(...) === "HAPUS" checks.
                if (options.expectedPhrase !== undefined && input.value !== options.expectedPhrase) {
                    showError(options.mismatchMessage || "Teks verifikasi tidak sesuai.");
                    return;
                }
                if (typeof options.verify === "function") {
                    verifying = true;
                    confirm.disabled = true;
                    input.disabled = true;
                    // The executor also catches a verify() that throws synchronously.
                    new Promise(function (settle) { settle(options.verify(input.value)); }).then(function (verified) {
                        finish(Boolean(verified), verified ? undefined : "verification-failed");
                    }).catch(function () { finish(false, "verification-failed"); });
                    return;
                }
                finish(true);
            }
            cancel.addEventListener("click", function () { finish(false, "cancelled"); });
            confirm.addEventListener("click", attempt);
            // Enter submits only from the input; on the buttons the native click applies,
            // so Enter on "Batal" can never confirm.
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter") {
                    event.preventDefault();
                    attempt();
                }
            });
            input.focus();
        });
    }

    registry.securityConfirmation = { open: open };
}(window));
