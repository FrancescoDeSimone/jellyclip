/*
 * JellyClip - in-player clip UI for Jellyfin web.
 *
 * Loaded via the JellyClip plugin's `web/ConfigurationPage?name=jellyclip.js`
 * resource, which the server plugin injects into the web client's index.html.
 *
 * A scissors icon is injected into the player's top bar (next to the cast /
 * share buttons) and hides together with the rest of the bar. Hovering or
 * tapping it opens the clip panel (set start / set end / download). The panel
 * is mounted on document.body with a very high z-index so Jellyfin's
 * full-screen OSD layer cannot swallow its clicks.
 */
(function () {
    "use strict";

    // ------------------------------------------------------------------ pure
    // Helpers are declared before the Node guard below so the exported closures
    // always see assigned values.

    function extractItemId(video) {
        if (!video) {
            return null;
        }

        var w = (typeof window !== "undefined") ? window : null;
        var hash = w ? (w.location.hash || "") : "";
        var search = w ? (w.location.search || "") : "";

        // 1) Explicit route/view id (details page) — the item being viewed/played.
        var route = hash.match(/[?&](?:id|itemId|videoId)=([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
        if (route) {
            return route[1];
        }

        // 2) Direct stream or HLS URLs carry the item id in /Videos/<id>/.
        var sources = [video.currentSrc || "", video.src || ""];
        for (var i = 0; i < sources.length; i++) {
            var sMatch = sources[i].match(/\/Videos\/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/);
            if (sMatch) {
                return sMatch[1];
            }
        }

        // 3) Last resort: any item id in these, preferring the video element's own
        //    sources over the poster (the poster can be a parent, e.g. a series
        //    backdrop, whose id is not a playable video).
        var candidates = [video.currentSrc || "", video.src || "", video.poster || "", hash, search];
        for (var j = 0; j < candidates.length; j++) {
            var text = candidates[j];
            if (!text) {
                continue;
            }

            var any = text.match(/\b([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);
            if (any) {
                return any[1];
            }
        }

        return null;
    }

    function pad2(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function formatTime(seconds) {
        if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
            return "--:--";
        }

        var totalSeconds = Math.floor(seconds);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var secs = totalSeconds % 60;

        return hours > 0
            ? hours + ":" + pad2(minutes) + ":" + pad2(secs)
            : minutes + ":" + pad2(secs);
    }

    function formatDuration(seconds) {
        if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
            return "--:--";
        }

        var totalSeconds = Math.floor(seconds);
        var minutes = Math.floor(totalSeconds / 60);
        var secs = totalSeconds % 60;
        return minutes + ":" + pad2(secs);
    }

    // Expose only the pure helpers when running under Node (unit tests).
    if (typeof window === "undefined" || typeof document === "undefined") {
        if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
            module.exports = {
                extractItemId: extractItemId,
                formatTime: formatTime,
                formatDuration: formatDuration
            };
        }
        return;
    }

    if (window.__jellyclipLoaded) {
        return;
    }
    window.__jellyclipLoaded = true;

    // ------------------------------------------------------------ DOM state
    var UI_ID = "jellyclip-ui";
    var PANEL_ID = "jellyclip-panel";

    var state = {
        start: null,
        end: null,
        audioStreamIndex: null
    };

    var hideTimer = null;

    function getContainer() {
        // Prefer the container that is actually playing something; a bare
        // first match can be a hidden template.
        var all = document.querySelectorAll(".videoPlayerContainer");
        var i, v;
        for (i = 0; i < all.length; i++) {
            v = all[i].querySelector("video");
            if (v && (v.currentSrc || v.src)) {
                return all[i];
            }
        }
        return all.length > 0 ? all[0] : null;
    }

    function getApiClient() {
        return window.ApiClient || null;
    }

    // Jellyfin 12 removed legacy auth (api_key query param, X-Emby-Token).
    // Authenticate exactly like the bundled web client does.
    function getAuthHeaders(api, token) {
        var tok = token;
        if (!tok && api && typeof api.accessToken === "function") {
            try {
                tok = api.accessToken();
            } catch (e) {
                tok = "";
            }
        }
        var app = "JellyClip";
        var ver = "12.0.0";
        var dev = "browser";
        var devId = "";
        if (api) {
            try {
                if (typeof api.appName === "function") {
                    app = api.appName() || app;
                }
                if (typeof api.appVersion === "function") {
                    ver = api.appVersion() || ver;
                }
                if (typeof api.deviceName === "function") {
                    dev = api.deviceName() || dev;
                }
                if (typeof api.deviceId === "function") {
                    devId = api.deviceId() || devId;
                }
            } catch (e) {
            }
        }
        var value = "MediaBrowser " + "Client=\"" + encodeURIComponent(app) + "\""
            + ", Device=\"" + encodeURIComponent(dev) + "\""
            + ", DeviceId=\"" + encodeURIComponent(devId) + "\""
            + ", Version=\"" + encodeURIComponent(ver) + "\""
            + ", Token=\"" + encodeURIComponent(tok || "") + "\"";
        return {
            "Authorization": value,
            "X-Emby-Authorization": value
        };
    }

    function getBar() {
        return document.getElementById(UI_ID);
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) {
            return false;
        }
        try {
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        } catch (e) {
            return false;
        }
    }

    function getOsdHeader() {
        return document.querySelector(".osdHeader") || document.querySelector("[class*=\"osdHeader\"]");
    }

    function getHeaderRight() {
        // Search scopes in order: the playing video's dialog first
        // (hidden templates and other players must never win), then
        // the whole document. Within a scope, prefer visible slots.
        var scopes = [];
        var container = getContainer();
        if (container) {
            var el = container;
            while (el && el !== document.body) {
                if (el.classList && (el.classList.contains("dialog")
                        || el.getAttribute("role") === "dialog")) {
                    scopes.push(el);
                    break;
                }
                el = el.parentNode;
            }
            scopes.push(container);
        }
        scopes.push(document);
        var i, s, list, el;
        var fallback = null;
        for (s = 0; s < scopes.length; s++) {
            var scope = scopes[s];
            list = scope.querySelectorAll(".headerRight");
            for (i = 0; i < list.length; i++) {
                el = list[i];
                if (isVisible(el)) {
                    return { parent: el, sibling: null };
                }
                if (!fallback) {
                    fallback = { parent: el, sibling: null };
                }
            }
            var anchors = scope.querySelectorAll(
                ".btnVideoOsdSettings,.btnAirPlay,.btnChromecast");
            for (i = 0; i < anchors.length; i++) {
                el = anchors[i];
                if (el.parentNode) {
                    if (isVisible(el)) {
                        return { parent: el.parentNode, sibling: el };
                    }
            if (!fallback) {
                    fallback = { parent: el.parentNode, sibling: el };
                }
            }
        }
        return fallback;
    }
                }
            }
            if (fallback && s === 0) {
                break;
            }
        }
        return fallback;
    }

    function getHeaderRight(container) {
        var scope = container || document;
        var osd = getOsdHeader(container);
        var legacy = osd
            ? osd.querySelector(".headerRight")
            : scope.querySelector(".headerRight");
        if (legacy) {
            return { parent: legacy, sibling: null };
        }
        // Jellyfin 12 redesigned the video OSD (no .headerRight): anchor to
        // a known top-right OSD button in the same player.
        var anchor = scope.querySelector(".btnVideoOsdSettings")
            || scope.querySelector(".btnAirPlay")
            || scope.querySelector(".btnChromecast");
        if (anchor && anchor.parentNode) {
            return { parent: anchor.parentNode, sibling: anchor };
        }
        return null;
    }

    function setStatus(root, text, isError) {
        var el = root.querySelector(".jellyclip-status");
        if (el) {
            el.textContent = text || "";
            el.className = "jellyclip-status" + (isError ? " jellyclip-status-error" : "");
        }
    }

    function clearSelection(root) {
        state.start = null;
        state.end = null;
        syncUi(root);
    }

    function updateRangeText(root) {
        var el = root.querySelector(".jellyclip-range");
        if (!el) {
            return;
        }

        if (state.start !== null && state.end !== null && state.end > state.start) {
            el.textContent = "Duration: " + formatDuration(state.end - state.start);
        } else if (state.start !== null) {
            el.textContent = "Start only: " + formatTime(state.start);
        } else if (state.end !== null) {
            el.textContent = "End only: " + formatTime(state.end);
        } else {
            el.textContent = "";
        }
    }

    // Do not overwrite an input the user is actively editing.
    function setInputValue(input, value) {
        if (!input || document.activeElement === input) {
            return;
        }
        input.value = (value === null || value === undefined) ? "" : value;
    }

    function syncUi(root) {
        updateRangeText(root);
        setInputValue(root.querySelector(".jellyclip-start-input"), state.start);
        setInputValue(root.querySelector(".jellyclip-end-input"), state.end);

        var download = root.querySelector(".jellyclip-download");
        if (download) {
            download.disabled = !(state.start !== null && state.end !== null && state.end > state.start);
        }

        var startBtn = root.querySelector(".jellyclip-start");
        var endBtn = root.querySelector(".jellyclip-end");
        if (startBtn) {
            startBtn.classList.toggle("jellyclip-active", state.start !== null);
        }
        if (endBtn) {
            endBtn.classList.toggle("jellyclip-active", state.end !== null);
        }
    }

    function populateAudioTracks(select, video) {
        if (select.__populated) {
            return;
        }
        select.__populated = true;

        var api = getApiClient();
        if (!api) {
            return;
        }

        var token = api.accessToken ? api.accessToken() : "";
        getPlayingItemId(api, token, video).then(function (itemId) {
            if (!itemId) {
                return null;
            }

            var userId = (typeof api.getCurrentUserId === "function") ? api.getCurrentUserId() : "";
            var url = api.getUrl("Users/" + userId + "/Items/" + itemId, {
                Fields: "MediaStreams"
            });
            return fetch(url, {
                method: "GET",
                credentials: "include",
                headers: getAuthHeaders(api, token)
            });
        }).then(function (response) {
            if (!response || !response.ok) {
                return null;
            }
            return response.json();
        }).then(function (item) {
            if (!item || !Array.isArray(item.MediaStreams)) {
                return;
            }

            var audios = item.MediaStreams.filter(function (s) {
                return s && s.Type === "Audio";
            });
            if (audios.length === 0) {
                return;
            }

            while (select.options.length > 1) {
                select.remove(1);
            }
            audios.forEach(function (s) {
                var option = document.createElement("option");
                option.value = s.Index;
                var name = s.DisplayTitle || s.Language || s.Codec || ("track " + s.Index);
                option.textContent = (s.Codec ? s.Codec + " \u00b7 " : "") + name + (s.Channels ? " \u00b7 " + s.Channels + "ch" : "");
                select.appendChild(option);
            });
        }).catch(function () {
            // Leave the Default option only.
        });
    }

    function getPlayingItemId(api, token, video) {
        // Resolve the authoritative playing item from the server's session list.
        // With multiple concurrent streams the session of THIS device must win,
        // otherwise the clip may come from someone else's playback.
        var deviceId = null;
        try {
            deviceId = (typeof api.deviceId === "function") ? api.deviceId() : null;
        } catch (e) {
            deviceId = null;
        }
        var pageItemId = extractItemId(video);

        var url = api.getUrl("Sessions", { ActiveWithinSeconds: 120 });
        return fetch(url, {
            method: "GET",
            credentials: "include",
            headers: getAuthHeaders(api, token)
        }).then(function (response) {
            if (!response.ok) {
                return null;
            }
            return response.json();
        }).then(function (sessions) {
            if (!Array.isArray(sessions)) {
                return null;
            }

            var playing = sessions.filter(function (s) {
                return s && s.NowPlayingItem && s.NowPlayingItem.Id;
            });
            if (playing.length === 0) {
                return null;
            }

            // 1) The session of this browser/device.
            if (deviceId) {
                for (var i = 0; i < playing.length; i++) {
                    if (playing[i].DeviceId === deviceId) {
                        return playing[i].NowPlayingItem.Id;
                    }
                }
            }

            // 2) A session playing the item this page is currently showing.
            if (pageItemId) {
                for (var j = 0; j < playing.length; j++) {
                    if (playing[j].NowPlayingItem.Id === pageItemId) {
                        return pageItemId;
                    }
                }
            }

            // 3) Last resort: any active playback.
            return playing[0].NowPlayingItem.Id;
        }).catch(function () {
            return null;
        });
    }

    function triggerDownload(downloadUrl, api, token) {
        // Fetch with auth headers (query-string api keys are no longer
        // accepted), then download via a temporary object URL. This keeps
        // the player page in place in every browser.
        fetch(downloadUrl, {
            method: "GET",
            credentials: "include",
            headers: getAuthHeaders(api, token)
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.blob();
        }).then(function (blob) {
            var objectUrl = (window.URL || window.webkitURL).createObjectURL(blob);
            var link = document.createElement("a");
            link.href = objectUrl;
            link.download = downloadUrl.split("/").pop().split("?")[0] || "clip.mp4";
            document.body.appendChild(link);
            link.click();
            setTimeout(function () {
                if (link.parentNode) {
                    link.parentNode.removeChild(link);
                }
                (window.URL || window.webkitURL).revokeObjectURL(objectUrl);
            }, 60000);
        }).catch(function (err) {
            setStatus(
                document.querySelector("#" + PANEL_ID),
                "Download failed: " + (err && err.message ? err.message : err),
                true);
        });
    }

    function downloadClip(root, video) {
        if (state.start === null || state.end === null || state.end <= state.start) {
            setStatus(root, "Select both a start and an end time first.");
            return;
        }

        var api = getApiClient();
        if (!api) {
            setStatus(root, "Jellyfin API client not available.");
            return;
        }

        var token = api.accessToken ? api.accessToken() : "";
        var fallbackItemId = extractItemId(video);

        getPlayingItemId(api, token, video).then(function (sessionItemId) {
            var itemId = sessionItemId || fallbackItemId;
            if (!itemId) {
                setStatus(root, "Could not determine the current item id.", true);
                return null;
            }

            var params = {
                startSeconds: state.start,
                endSeconds: state.end
            };
            if (state.audioStreamIndex !== null && state.audioStreamIndex !== undefined) {
                params.audioStreamIndex = state.audioStreamIndex;
            }
            var createUrl = api.getUrl("JellyClip/" + itemId, params);

            setStatus(root, "Generating clip\u2026 this can take a while.");

            // Create the clip with a lightweight POST (no body streamed). Failures
            // are visible; on success we download via a hidden iframe, which every
            // browser auto-downloads without leaving the player.
            return fetch(createUrl, {
                method: "POST",
                credentials: "include",
                headers: getAuthHeaders(api, token)
            });
        }).then(function (response) {
            if (!response) {
                // Item id could not be determined; the error was already shown.
                return;
            }

            if (!response.ok) {
                return response.text().then(function (body) {
                    throw new Error("HTTP " + response.status + " " + (body || response.statusText || "").trim());
                });
            }

            return response.json().then(function (data) {
                if (!data || !data.filename) {
                    throw new Error("Unexpected server response.");
                }

                var downloadUrl = api.getUrl("JellyClip/clips/" + encodeURIComponent(data.filename));

                setStatus(root, "");
                var statusEl = root.querySelector(".jellyclip-status");
                statusEl.textContent = "Clip ready \u2014 ";
                var retry = document.createElement("a");
                retry.href = "#";
                retry.textContent = "downloading automatically\u2026 (click if it didn't start)";
                retry.className = "jellyclip-retry";
                retry.addEventListener("click", function (event) {
                    event.preventDefault();
                    downloadClip(root, video);
                });
                statusEl.appendChild(retry);

                triggerDownload(downloadUrl, api, token);
            });
        }).catch(function (err) {
            setStatus(root, "Clip failed: " + (err && err.message ? err.message : err), true);
        });
    }

    // ------------------------------------------------------------- panel UX
    function positionPanel(icon, panel) {
        var rect = icon.getBoundingClientRect();
        var width = 240;
        var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        panel.style.left = left + "px";
        panel.style.top = (rect.bottom + 8) + "px";
    }

    function hidePanel(panel, icon) {
        if (icon && icon.__pinned) {
            return;
        }
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            panel.style.display = "none";
        }, 250);
    }

    function showPanel(icon, panel) {
        clearTimeout(hideTimer);
        positionPanel(icon, panel);
        panel.style.display = "flex";
    }

    function buildTimeField(cls, title) {
        var wrap = document.createElement("label");
        wrap.className = "jellyclip-field";
        var input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.className = cls;
        input.placeholder = "seconds";
        input.title = title;
        wrap.appendChild(input);
        return { wrap: wrap, input: input };
    }

    function buildIconAndPanel(video) {
        var icon = document.createElement("button");
        icon.type = "button";
        icon.id = UI_ID;
        // Fully self-styled (see jellyclip.css): never inherit sibling
        // classes, they may carry hidden/selected state on some versions.
        icon.className = "jellyclip-header-icon";
        icon.title = "Clip";
        // Inline SVG: independent of the Material Icons font/ligatures, so it
        // renders identically under any theme.
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z" fill="currentColor"/></svg>';
        icon.__pinned = false;

        var panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.className = "jellyclip-panel";

        var start = document.createElement("button");
        start.type = "button";
        start.className = "jellyclip-start";
        start.textContent = "Set start";
        start.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            state.start = video.currentTime;
            setStatus(panel, "");
            syncUi(panel);
        });

        var end = document.createElement("button");
        end.type = "button";
        end.className = "jellyclip-end";
        end.textContent = "Set end";
        end.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            state.end = video.currentTime;
            setStatus(panel, "");
            syncUi(panel);
        });

        var range = document.createElement("span");
        range.className = "jellyclip-range";

        // Audio track selection (populated asynchronously from the item).
        var audioRow = document.createElement("label");
        audioRow.className = "jellyclip-audio";
        var audioLabel = document.createElement("span");
        audioLabel.className = "jellyclip-audio-label";
        audioLabel.textContent = "Audio";
        var audioSelect = document.createElement("select");
        audioSelect.className = "jellyclip-audio-select";
        audioSelect.title = "Audio track";
        var defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Default";
        audioSelect.appendChild(defaultOption);
        audioSelect.addEventListener("change", function () {
            state.audioStreamIndex = audioSelect.value === "" ? null : Number(audioSelect.value);
        });
        audioRow.appendChild(audioLabel);
        audioRow.appendChild(audioSelect);

        // Editable start/end in seconds (typing or arrow keys adjust them).
        var timeRow = document.createElement("div");
        timeRow.className = "jellyclip-time-row";

        var startField = buildTimeField("jellyclip-start-input", "Clip start (seconds)");
        var endField = buildTimeField("jellyclip-end-input", "Clip end (seconds)");

        function applyTimeFromInputs() {
            var s = parseFloat(startField.input.value);
            var e = parseFloat(endField.input.value);
            state.start = (isNaN(s) || s < 0) ? null : s;
            state.end = (isNaN(e) || e < 0) ? null : e;
            syncUi(panel);
        }
        startField.input.addEventListener("input", applyTimeFromInputs);
        startField.input.addEventListener("change", applyTimeFromInputs);
        endField.input.addEventListener("input", applyTimeFromInputs);
        endField.input.addEventListener("change", applyTimeFromInputs);

        timeRow.appendChild(startField.wrap);
        timeRow.appendChild(endField.wrap);

        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "jellyclip-clear";
        clear.textContent = "Clear";
        clear.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            clearSelection(panel);
        });

        var download = document.createElement("button");
        download.type = "button";
        download.className = "jellyclip-download";
        download.textContent = "Download clip";
        download.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            downloadClip(panel, video);
        });

        var status = document.createElement("span");
        status.className = "jellyclip-status";

        panel.appendChild(audioRow);
        panel.appendChild(timeRow);
        panel.appendChild(range);
        panel.appendChild(start);
        panel.appendChild(end);
        panel.appendChild(clear);
        panel.appendChild(download);
        panel.appendChild(status);

        syncUi(panel);

        icon.addEventListener("mouseenter", function () {
            populateAudioTracks(audioSelect, video);
            showPanel(icon, panel);
        });
        icon.addEventListener("mouseleave", function () {
            hidePanel(panel, icon);
        });
        panel.addEventListener("mouseenter", function () {
            clearTimeout(hideTimer);
            populateAudioTracks(audioSelect, video);
        });
        panel.addEventListener("mouseleave", function () {
            hidePanel(panel, icon);
        });
        icon.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            icon.__pinned = !icon.__pinned;
            if (icon.__pinned) {
                showPanel(icon, panel);
            } else {
                hidePanel(panel, icon);
            }
        });

        return { icon: icon, panel: panel };
    }

    function teardown(bar) {
        if (bar) {
            if (bar.parentNode) {
                bar.parentNode.removeChild(bar);
            }
            if (bar.__panel && bar.__panel.parentNode) {
                bar.__panel.parentNode.removeChild(bar.__panel);
            }
        }
    }

    // The icon lives inside the OSD header, so it hides with the rest of the
    // bar. The body-mounted panel must follow: whenever the header is hidden
    // (mouse idle), close the panel too.
    function syncPanelWithHeader() {
        var bar = getBar();
        if (!bar || !bar.__panel) {
            return;
        }

        var header = null;
        if (bar.parentNode && bar.parentNode.closest) {
            try {
                header = bar.parentNode.closest(".osdHeader");
            } catch (e) {
                header = null;
            }
        }
        if (!header) {
            header = getOsdHeader();
        }
        var hidden = !header || header.classList.contains("osdHeader-hidden");
        if (hidden && bar.__panel.style.display !== "none") {
            bar.__pinned = false;
            bar.__panel.style.display = "none";
        }
    }

    function mountIfNeeded() {
        var dbg = window.__jellyclipDebug || (window.__jellyclipDebug = { attempts: 0, mounted: false, last: "init" });
        dbg.attempts++;
        var container = getContainer();
        if (!container) {
            dbg.last = "no-container";
            teardown(getBar());
            return;
        }
        var slot = getHeaderRight();
        if (!slot) {
            dbg.last = "no-slot";
            teardown(getBar());
            return;
        }
        var bar = getBar();

        if (bar && bar.__container === container) {
            // Already mounted for this player dialog; ensure it is inside the header.
            if (bar.parentNode !== slot.parent) {
                if (slot.sibling) {
                    slot.parent.insertBefore(bar, slot.sibling);
                } else {
                    slot.parent.appendChild(bar);
                }
            }
            dbg.mounted = !!document.getElementById(UI_ID);
            dbg.last = "already-mounted";
            return;
        }

        teardown(bar);

        var video = container.querySelector("video");
        if (!video) {
            dbg.last = "no-video";
            return;
        }

        var built = buildIconAndPanel(video);
        built.icon.__container = container;
        built.icon.__panel = built.panel;
        if (slot.sibling) {
            slot.parent.insertBefore(built.icon, slot.sibling);
        } else {
            slot.parent.appendChild(built.icon);
        }
        document.body.appendChild(built.panel);
        dbg.mounted = true;
        dbg.last = "mounted";
    }

    // -------------------------------------------------------------- startup
    mountIfNeeded();
    setInterval(syncPanelWithHeader, 500);

    // Jellyfin recreates the player dialog and OSD for each playback session, so
    // keep watching the document tree and re-attach the icon when it reappears.
    var observer = new MutationObserver(mountIfNeeded);
    observer.observe(document.body, { childList: true, subtree: true });
})();
