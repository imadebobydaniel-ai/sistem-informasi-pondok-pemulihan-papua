(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};

    if (registry.queue) return;

    function Queue(maxVisible) {
        this.maxVisible = maxVisible || 3;
        this.visible = [];
        this.pending = [];
        this.keys = new Map();
    }

    // Returns the existing open entry when the dedupe key is already shown or queued.
    Queue.prototype.add = function (item) {
        var key = item && item.dedupeKey;
        if (key && this.keys.has(key)) return this.keys.get(key);
        var entry = { item: item, state: "pending" };
        if (key) this.keys.set(key, entry);
        if (this.visible.length < this.maxVisible) {
            entry.state = "visible";
            this.visible.push(entry);
        } else {
            this.pending.push(entry);
        }
        return entry;
    };

    // Idempotent: closing an entry twice (or via a stale handle) never touches newer entries.
    Queue.prototype.remove = function (entry) {
        if (!entry || entry.state === "closed") return;
        var list = entry.state === "visible" ? this.visible : this.pending;
        var index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        var key = entry.item && entry.item.dedupeKey;
        if (key && this.keys.get(key) === entry) this.keys.delete(key);
        entry.state = "closed";
        this.promote();
    };

    Queue.prototype.promote = function () {
        while (this.visible.length < this.maxVisible && this.pending.length) {
            var entry = this.pending.shift();
            entry.state = "visible";
            this.visible.push(entry);
            if (typeof entry.item.onVisible === "function") entry.item.onVisible();
        }
    };

    Queue.prototype.clear = function () {
        this.visible.length = 0;
        this.pending.length = 0;
        this.keys.clear();
    };

    registry.queue = Queue;
}(window));
