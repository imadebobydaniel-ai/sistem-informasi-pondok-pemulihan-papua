"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const phase5 = path.join(root, "candidates/phase5-e2e");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sipapua-checkpoint-tests-"));

// Extend the preserved integrated suite in TEMP. Each insertion requires one exact
// source anchor so an upstream harness change cannot silently remove coverage.
function extend(file, edits) {
    let contents = fs.readFileSync(path.join(phase5, file), "utf8");
    for (const [before, after] of edits) {
        assert.equal(contents.split(before).length, 2, file + ": " + before);
        contents = contents.replace(before, () => after);
    }
    fs.writeFileSync(path.join(scratch, file), contents);
}

const checkpoint = JSON.stringify(__dirname);
extend("verify.cjs", [
    ['const root = path.resolve(__dirname, "../..");', 'const root = ' + JSON.stringify(root) + ';'],
    ['const projectId = "demo-sipapua-phase5";', 'const projectId = "demo-sipapua-checkpoint";'],
    ['path.join(__dirname, "firestore.phase5.rules")', JSON.stringify(path.join(phase5, "firestore.phase5.rules"))],
    ['path.resolve(__dirname, "../phase4-compatibility")', JSON.stringify(path.resolve(phase5, "../phase4-compatibility"))],
    ['path.join(__dirname, "big-data.patch")', JSON.stringify(path.join(phase5, "big-data.patch"))],
    ['    return folder;', `    const checkpoint = ${checkpoint};
    execFileSync("git", ["apply", "--ignore-space-change", path.join(checkpoint, "administrator-rapor.patch")], { cwd: folder });
    fs.copyFileSync(path.join(checkpoint, "administrator-rapor.js"), path.join(folder, "functions/administrator-rapor.js"));
    return folder;`],
    ['        await require(path.join(__dirname, "transport.cjs"))({',
        `        const administratorRapor = load("administrator-rapor.js").getSIPAPUAAdministratorRapor;
        await require(path.join(${checkpoint}, "rapor-checks.cjs"))({ check, db, administratorRapor, authDirectory });
        await require(path.join(__dirname, "transport.cjs"))({ administratorRapor,`]
]);

extend("transport.cjs", [
    ["registration, lifecycle, authDirectory })", "registration, lifecycle, authDirectory, administratorRapor })"],
    ["        getSIPAPUAOwnProfile: lifecycle.getSIPAPUAOwnProfile,",
        "        getSIPAPUAOwnProfile: lifecycle.getSIPAPUAOwnProfile,\n        getSIPAPUAAdministratorRapor: administratorRapor,"]
]);

extend("browser.cjs", [
    ['        await check("browser Bible reading submission and own Rapor output"', `        let ownMetrics;
        async function periodMetrics() {
            return evalJs(` + "`" + `JSON.stringify(["WEEK", "MONTH", "YEAR"].map(mode => {
                const select = document.getElementById("period-mode");
                select.value = mode;
                select.dispatchEvent(new Event("change"));
                return {
                    period: document.getElementById("period-value").value,
                    metrics: buildMetrics(activePeriod()).map(({ key, count, percentage, points }) => ({ key, count, percentage, points })),
                    rendered: document.getElementById("excel-table-body-poin").textContent
                };
            }))` + "`" + `);
        }
        await check("browser Bible reading submission and own Rapor output"`],
    ['"Rapor row output");', `"Rapor row output");
            ownMetrics = await periodMetrics();
            const periods = JSON.parse(ownMetrics);
            assert.equal(periods.length, 3);
            assert.ok(periods.every(period => period.period && period.metrics.find(metric => metric.key === "alkitab").count === 1));`],
    ['    } finally {\n        if (cdp) {', `        await check("browser Viewer selects NIJ in Big Data and matches the member Rapor across three periods", async () => {
            await open("admin-bigdata.html");
            await until(() => evalJs('document.getElementById("bdSession")?.innerText === "VIEWER SESSION"'), "Viewer Rapor entry");
            await evalJs(field("bdRaporNij", "SYN-BROWSER") + 'document.getElementById("bdRaporNij").form.requestSubmit(); true');
            await until(() => evalJs('location.pathname === "/rapor.html" && document.getElementById("rapor-heading")?.textContent === "REKAPITULASI RAPOR ANGGOTA"'), "Administrator Rapor render");
            assert.equal(await evalJs('document.getElementById("display-nij").innerText'), "SYN-BROWSER");
            assert.equal(await evalJs('document.getElementById("display-nama").innerText'), "Browser Member");
            assert.equal(await periodMetrics(), ownMetrics);
        });
        for (const account of ["other", "inactive"]) {
            await check("browser denies Administrator Rapor for " + account, async () => {
                await open("kehadiran.html");
                await evalJs('(async () => { await firebase.auth().signInWithEmailAndPassword("' + account + '@example.test", "Synthetic-only-42!"); return true; })()');
                await open("rapor.html?adminNij=SYN-BROWSER");
                await until(() => evalJs('document.getElementById("rapor-admin-status")?.textContent.includes("tidak dapat dibuka")'), "Rapor denied");
                assert.equal(await evalJs('document.getElementById("report-content").hidden'), true);
            });
        }
    } finally {
        if (cdp) {`],
    ['["/${page}", "/${redirect}"].includes(location.pathname)', '["/${page.split("?")[0]}", "/${redirect.split("?")[0]}"].includes(location.pathname)']
]);

const modules = [path.join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const result = spawnSync(process.execPath, [path.join(scratch, "verify.cjs")], {
    cwd: root, stdio: "inherit", env: { ...process.env, NODE_PATH: modules }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
