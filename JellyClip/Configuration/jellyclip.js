/*
 * JellyClip - in-player clip UI for Jellyfin web.
 *
 * Loaded via the JellyClip plugin's `web/ConfigurationPage?name=jellyclip.js`
 * resource, which the server plugin injects into the web client's index.html.
 *
 * Shows a small toolbar over the video while it plays and lets the user mark a
 * start and end time, then downloads the cut clip from the server.
 *
 * The bar is mounted on document.body (not inside the player dialog) with a
 * very high z-index so Jellyfin's full-screen OSD layer cannot swallow its
 * clicks. It auto-hides after a few seconds of mouse inactivity and reappears
 * on mouse movement, mirroring the built-in OSD behaviour.
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
    var IDLE_HIDE_MS = 3000;

    var state = {
        start: null,
        end: null
    };

    var idleTimer = null;
    var hiddenByUser = false;

    function getContainer() {
        return document.querySelector(".videoPlayerContainer");
    }

    function getApiClient() {
        return window.ApiClient || null;
    }

    function getBar() {
        return document.getElementById(UI_ID);
    }

    function hideBar() {
        var el = getBar();
        if (el) {
            el.classList.add("jellyclip-hidden");
        }
    }

    function showBar() {
        if (hiddenByUser) {
            return;
        }
        var el = getBar();
        if (el) {
            el.classList.remove("jellyclip-hidden");
        }
    }

    function armIdleHide() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(hideBar, IDLE_HIDE_MS);
    }

    function onMouseMove() {
        showBar();
        armIdleHide();
    }

    function onVideoPause() {
        // Keep the bar visible while paused so it can be used.
        showBar();
        clearTimeout(idleTimer);
    }

    function onVideoPlay() {
        armIdleHide();
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

        if (state.start === null && state.end === null) {
            el.textContent = "No range selected";
            return;
        }

        var pieces = [];
        if (state.start !== null) {
            pieces.push("from " + formatTime(state.start));
        }
        if (state.end !== null) {
            pieces.push("to " + formatTime(state.end));
        }
        el.textContent = pieces.join(" ") + (state.start !== null && state.end !== null
            ? " (" + formatDuration(state.end - state.start) + ")"
            : "");
    }

    function syncUi(root) {
        updateRangeText(root);
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

        var url = api.getUrl("Sessions", { ActiveWithinSeconds: 120, api_key: token });
        return fetch(url, {
            method: "GET",
            credentials: "include",
            headers: {
                "X-Emby-Token": token
            }
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

    function triggerDownload(downloadUrl) {
        // Hidden iframe: the attachment response downloads without navigating
        // the app page (location.assign can navigate in some browsers).
        var iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.style.width = "0";
        iframe.style.height = "0";
        iframe.src = downloadUrl;
        document.body.appendChild(iframe);
        setTimeout(function () {
            if (iframe.parentNode) {
                iframe.parentNode.removeChild(iframe);
            }
        }, 60000);
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

            var createUrl = api.getUrl("JellyClip/" + itemId, {
                startSeconds: state.start,
                endSeconds: state.end,
                api_key: token
            });

            setStatus(root, "Generating clip\u2026 this can take a while.");

            // Create the clip with a lightweight POST (no body streamed). Failures
            // are visible; on success we download via a native top-level navigation,
            // which every browser auto-downloads (no blob / activation quirks).
            return fetch(createUrl, {
                method: "POST",
                credentials: "include",
                headers: {
                    "X-Emby-Token": token
                }
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

                var downloadUrl = api.getUrl("JellyClip/clips/" + encodeURIComponent(data.filename), {
                    api_key: token
                });

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

                triggerDownload(downloadUrl);
            });
        }).catch(function (err) {
            setStatus(root, "Clip failed: " + (err && err.message ? err.message : err), true);
        });
    }

    function buildControls(video) {
        var root = document.createElement("div");
        root.id = UI_ID;
        root.className = UI_ID;

        var header = document.createElement("div");
        header.className = "jellyclip-header";
        var label = document.createElement("span");
        label.className = "jellyclip-label";
        label.textContent = "Clip";
        var close = document.createElement("button");
        close.type = "button";
        close.className = "jellyclip-close";
        close.textContent = "\u00d7";
        close.title = "Hide clip toolbar for this playback";
        close.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            hiddenByUser = true;
            hideBar();
        });
        header.appendChild(label);
        header.appendChild(close);
        root.appendChild(header);

        var start = document.createElement("button");
        start.type = "button";
        start.className = "jellyclip-start";
        start.textContent = "Set start";
        start.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            state.start = video.currentTime;
            setStatus(root, "");
            syncUi(root);
        });

        var end = document.createElement("button");
        end.type = "button";
        end.className = "jellyclip-end";
        end.textContent = "Set end";
        end.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            state.end = video.currentTime;
            setStatus(root, "");
            syncUi(root);
        });

        var range = document.createElement("span");
        range.className = "jellyclip-range";

        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "jellyclip-clear";
        clear.textContent = "Clear";
        clear.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            clearSelection(root);
        });

        var download = document.createElement("button");
        download.type = "button";
        download.className = "jellyclip-download";
        download.textContent = "Download clip";
        download.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            downloadClip(root, video);
        });

        var status = document.createElement("span");
        status.className = "jellyclip-status";

        root.appendChild(start);
        root.appendChild(end);
        root.appendChild(range);
        root.appendChild(clear);
        root.appendChild(download);
        root.appendChild(status);

        syncUi(root);
        return root;
    }

    function mountIfNeeded() {
        var container = getContainer();
        var bar = getBar();

        if (!container) {
            // Playback ended; tear down the bar and reset user-hide for next time.
            hiddenByUser = false;
            if (bar) {
                document.body.removeChild(bar);
                clearTimeout(idleTimer);
            }
            return;
        }

        if (bar && bar.__container === container) {
            // Already mounted for this player dialog; nothing to do.
            return;
        }

        // A bar from a previous (now closed) player dialog.
        if (bar) {
            document.body.removeChild(bar);
            clearTimeout(idleTimer);
        }

        var video = container.querySelector("video");
        if (!video) {
            return;
        }

        hiddenByUser = false;
        bar = buildControls(video);
        bar.__container = container;
        document.body.appendChild(bar);

        video.addEventListener("pause", onVideoPause);
        video.addEventListener("play", onVideoPlay);

        // Appear immediately at playback start, then hide on inactivity.
        showBar();
        armIdleHide();
    }

    // -------------------------------------------------------------- startup
    window.addEventListener("mousemove", onMouseMove);

    mountIfNeeded();

    // Jellyfin recreates the player dialog for each playback session, so keep
    // watching the document tree and re-attach the bar when a fresh dialog appears.
    var observer = new MutationObserver(mountIfNeeded);
    observer.observe(document.body, { childList: true, subtree: true });
})();
