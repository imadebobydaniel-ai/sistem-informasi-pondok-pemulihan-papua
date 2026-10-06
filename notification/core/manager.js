(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.manager) return;
    function create(existing) {
        if (existing && existing.__notificationManager) return existing;
        var manager = { __notificationManager: true, roots: registry.lifecycle.roots(), lifecycle: registry.lifecycle, queue: new registry.queue(3), loadings: Object.create(null), defaults: { success: 4000, error: 8000, warning: 7000, info: 5000 } };
        manager.releaseToast = function (entry) { if (entry) manager.queue.remove(entry); };
        manager.notify = { success: function (o) { return registry.toast.create(manager, "success", o); }, error: function (o) { return registry.toast.create(manager, "error", o); }, warning: function (o) { return registry.toast.create(manager, "warning", o); }, info: function (o) { return registry.toast.create(manager, "info", o); } };
        manager.validation = { show: function (o) { return registry.validation.show(manager, o); } };
        manager.loading = { show: function (o) { return registry.loading.show(manager, o); }, hide: function (h) { if (h && typeof h.hide === "function") h.hide(); } };
        manager.confirm = function (o) { return registry.confirmation.open(manager, o); };
        manager.confirmDelete = function (o) { o = Object.assign({ tone: "danger", initialFocus: "cancel", confirmLabel: "Hapus" }, o || {}); return registry.confirmation.open(manager, o); };
        manager.securityConfirm = function (o) { return registry.securityConfirmation.open(manager, o); };
        manager.error = { normalize: registry.errorNormalizer };
        return manager;
    }
    registry.manager = { create: create };
}(window));
