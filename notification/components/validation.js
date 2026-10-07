(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.validation) return;

    // One summary per container: showing again replaces the previous one.
    var activeByContainer = typeof WeakMap === "function" ? new WeakMap() : null;

    function show(manager, options) {
        options = options || {};
        // options.form may be an element or a selector; anything else falls back to the root.
        var form = typeof options.form === "string" ? document.querySelector(options.form) : options.form;
        var container = form && typeof form.prepend === "function" ? form : manager.roots.notification;
        if (activeByContainer && activeByContainer.has(container)) activeByContainer.get(container).close();

        var root = document.createElement("section");
        root.className = "sip-validation-summary";
        root.id = manager.lifecycle.uid("sip-validation");
        root.setAttribute("role", "alert");
        root.setAttribute("aria-live", "assertive");
        var heading = document.createElement("strong");
        heading.textContent = options.summary || "Periksa data berikut:";
        root.appendChild(heading);
        var list = document.createElement("ul");
        // Original ARIA state of each marked control, restored on close().
        var marked = [];
        (options.fields || []).forEach(function (field) {
            var item = document.createElement("li");
            item.textContent = field.message || "Data belum valid.";
            list.appendChild(item);
            var control = field.id ? document.getElementById(field.id) : null;
            if (!control) return;
            var describedBy = control.getAttribute("aria-describedby");
            marked.push({ control: control, describedBy: describedBy, invalid: control.getAttribute("aria-invalid") });
            control.setAttribute("aria-invalid", "true");
            var ids = describedBy ? describedBy.split(/\s+/) : [];
            if (ids.indexOf(root.id) < 0) ids.push(root.id);
            control.setAttribute("aria-describedby", ids.join(" "));
        });
        root.appendChild(list);
        container.prepend(root);

        var closed = false;
        var handle = {
            close: function () {
                if (closed) return;
                closed = true;
                root.remove();
                marked.forEach(function (state) {
                    if (state.describedBy === null) state.control.removeAttribute("aria-describedby");
                    else state.control.setAttribute("aria-describedby", state.describedBy);
                    if (state.invalid === null) state.control.removeAttribute("aria-invalid");
                    else state.control.setAttribute("aria-invalid", state.invalid);
                });
                if (activeByContainer && activeByContainer.get(container) === handle) activeByContainer.delete(container);
            }
        };
        if (activeByContainer) activeByContainer.set(container, handle);

        var first = options.fields && options.fields[0] && options.fields[0].id && document.getElementById(options.fields[0].id);
        var reduceMotion = typeof global.matchMedia === "function" && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (first && options.scrollFirst !== false) first.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
        if (first && options.focusFirst !== false) first.focus({ preventScroll: options.scrollFirst !== false });
        return handle;
    }

    registry.validation = { show: show };
}(window));
