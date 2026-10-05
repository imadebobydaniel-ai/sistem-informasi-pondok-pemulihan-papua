(() => {
    const dateValue = document.querySelector(".date-value");
    if (dateValue) {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        dateValue.dateTime = `${now.getFullYear()}-${month}-${day}`;
        dateValue.textContent = new Intl.DateTimeFormat("id-ID", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric"
        }).format(now);
    }

    const search = document.querySelector(".menu-search input");
    if (!search) return;

    const emptyState = document.querySelector(".menu-search-empty");
    const emptyQuery = emptyState && emptyState.querySelector("strong");

    search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase("id-ID");
        let hasAnyMatch = false;
        document.querySelectorAll(".menu-group, .quick-links").forEach((group) => {
            let hasVisibleTile = false;
            group.querySelectorAll(".menu-box, .quick-link").forEach((tile) => {
                const matches = !query || tile.textContent.toLocaleLowerCase("id-ID").includes(query);
                tile.hidden = !matches;
                hasVisibleTile ||= matches;
            });
            group.hidden = !hasVisibleTile;
            hasAnyMatch ||= hasVisibleTile;
        });

        if (emptyState) {
            emptyState.hidden = hasAnyMatch;
            if (emptyQuery) emptyQuery.textContent = search.value.trim();
        }
    });
})();
