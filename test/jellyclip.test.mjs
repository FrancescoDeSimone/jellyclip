// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../JellyClip/Configuration/jellyclip.js');

test('extractItemId pulls the uuid out of a poster url', () => {
    const video = {
        poster: 'https://host/emby/Items/123e4567-e89b-12d3-a456-426614174000/Images/Backdrop/0?tag=x&api_key=y',
        currentSrc: '',
        src: ''
    };
    assert.equal(helpers.extractItemId(video), '123e4567-e89b-12d3-a456-426614174000');
});

test('extractItemId falls back to currentSrc for direct play urls', () => {
    const video = {
        poster: '',
        currentSrc: '/emby/Videos/B3aE45f7-01aa-4d23-b456-426614174999/stream?Static=true',
        src: ''
    };
    assert.equal(helpers.extractItemId(video), 'B3aE45f7-01aa-4d23-b456-426614174999');
});

test('extractItemId ignores the route: it names the page, not the playback', () => {
    // Playing from a card, the next-up bar or a playlist leaves the previous
    // item's route in place - that id used to clip the previous episode - so a
    // blob-only page has no item id at all.
    const video = { poster: '', currentSrc: '', src: 'blob:https://host/xxxx' };
    assert.equal(helpers.extractItemId(video), null);
});

test('extractItemId handles 32-char bare hex ids (Jellyfin 10.11 format)', () => {
    const video = {
        poster: 'http://host/Items/83d96aec36c433796b4f1db34533b578/Images/Backdrop/0?tag=x',
        currentSrc: '',
        src: 'blob:http://host/xxxx'
    };
    assert.equal(helpers.extractItemId(video), '83d96aec36c433796b4f1db34533b578');

    // direct play url form
    const video2 = { poster: '', currentSrc: 'http://127.0.0.1:8096/Videos/83d96aec36c433796b4f1db34533b578/stream.mp4?Static=true', src: '' };
    assert.equal(helpers.extractItemId(video2), '83d96aec36c433796b4f1db34533b578');
});

test('extractItemId reads the backdrop, never the route that is on screen', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=b518adfda59c0186013ef6e310fafcc4&serverId=50d832fa6b4549eea4306f6fffd61179', search: '' } },
        configurable: true
    });
    // An episode inherits its series backdrop; the server walks past the parent.
    const video = {
        poster: 'http://host/Items/4b51e5beeed543e5303b32ee0d772a6d/Images/Backdrop/0?tag=x',
        currentSrc: 'blob:http://host/ffff',
        src: 'blob:http://host/ffff'
    };
    assert.equal(helpers.extractItemId(video), '4b51e5beeed543e5303b32ee0d772a6d');
    Reflect.deleteProperty(globalThis, 'window');
});

test('extractItemId returns null when nothing matches', () => {
    const video = { poster: '../resources/placeholder.png', currentSrc: '', src: 'blob:https://host/xxxx' };
    assert.equal(helpers.extractItemId(video), null);
    assert.equal(helpers.extractItemId(null), null);
});

test('itemIdFromStreamUrl reads the item id out of playback requests', () => {
    assert.equal(
        helpers.itemIdFromStreamUrl('http://host/Videos/83d96aec36c433796b4f1db34533b578/master.m3u8?PlaySessionId=x'),
        '83d96aec36c433796b4f1db34533b578');
    assert.equal(
        helpers.itemIdFromStreamUrl('http://host/Videos/B3aE45f7-01aa-4d23-b456-426614174999/stream.mkv?Static=true'),
        'B3aE45f7-01aa-4d23-b456-426614174999');
    assert.equal(helpers.itemIdFromStreamUrl('blob:https://host/xxxx'), null);
    assert.equal(helpers.itemIdFromStreamUrl('http://host/Users/83d96aec36c433796b4f1db34533b578/Items'), null);
    assert.equal(helpers.itemIdFromStreamUrl(''), null);
    assert.equal(helpers.itemIdFromStreamUrl(undefined), null);
});

test('extractItemId prefers the tracked stream of this page over the backdrop', () => {
    // HLS playback: element src is a blob, so only the tracked request knows.
    const video = {
        poster: 'http://host/Items/4b51e5beeed543e5303b32ee0d772a6d/Images/Backdrop/0',
        currentSrc: 'blob:https://host/xxxx',
        src: 'blob:https://host/xxxx'
    };
    assert.equal(helpers.extractItemId(video, 'b518adfda59c0186013ef6e310fafcc4'), 'b518adfda59c0186013ef6e310fafcc4');
});

test('extractItemId prefers the element source over a stale tracked stream', () => {
    const video = {
        poster: '',
        currentSrc: 'http://host/Videos/83d96aec36c433796b4f1db34533b578/stream.mkv?Static=true',
        src: ''
    };
    assert.equal(
        helpers.extractItemId(video, 'b518adfda59c0186013ef6e310fafcc4'),
        '83d96aec36c433796b4f1db34533b578');
});

test('extractItemId returns null when only the route names an item', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=83d96aec36c433796b4f1db34533b578', search: '' } },
        configurable: true
    });
    const video = { poster: '', currentSrc: 'blob:https://host/xxxx', src: 'blob:https://host/xxxx' };
    assert.equal(helpers.extractItemId(video, null), null);
    Reflect.deleteProperty(globalThis, 'window');
});

test('formatTime renders minutes, seconds and hours', () => {
    assert.equal(helpers.formatTime(0), '0:00');
    assert.equal(helpers.formatTime(5), '0:05');
    assert.equal(helpers.formatTime(65), '1:05');
    assert.equal(helpers.formatTime(3661), '1:01:01');
    assert.equal(helpers.formatTime(-1), '--:--');
    assert.equal(helpers.formatTime(NaN), '--:--');
});

test('formatDuration renders clip length', () => {
    assert.equal(helpers.formatDuration(12.9), '0:12');
    assert.equal(helpers.formatDuration(92), '1:32');
    assert.equal(helpers.formatDuration(3720), '62:00');
});

test('itemIdCandidates orders the page signals and drops duplicates', () => {
    const video = {
        poster: 'http://host/Items/93457ff2-9adb-77d9-3a37-2803feffc2a4/Images/Backdrop/0?tag=x',
        currentSrc: 'http://host/Videos/83d96aec36c433796b4f1db34533b578/stream.mkv?Static=true',
        src: ''
    };
    assert.deepEqual(helpers.itemIdCandidates(video, 'b518adfda59c0186013ef6e310fafcc4'), [
        '83d96aec36c433796b4f1db34533b578',
        'b518adfda59c0186013ef6e310fafcc4',
        '93457ff2-9adb-77d9-3a37-2803feffc2a4'
    ]);
});

test('itemIdCandidates keeps one series id when an episode carries no stream id', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=4b51e5beeed543e5303b32ee0d772a6d', search: '' } },
        configurable: true
    });
    // Transcoded episode started from its series page: the element plays a
    // blob, nothing was tracked, and the backdrop names the series - the
    // server, which only clips videos, has to walk past this id. The route
    // names the same series here, and would have been a trap had it named the
    // previously watched episode.
    const video = {
        poster: 'http://host/Items/4b51e5beeed543e5303b32ee0d772a6d/Images/Backdrop/0?tag=x',
        currentSrc: 'blob:https://host/xxxx',
        src: 'blob:https://host/xxxx'
    };
    assert.deepEqual(helpers.itemIdCandidates(video, null), ['4b51e5beeed543e5303b32ee0d772a6d']);
    Reflect.deleteProperty(globalThis, 'window');
});

test('isCurrentSession accepts a session reporting this video position', () => {
    assert.equal(helpers.isCurrentSession({ PlayState: { PositionTicks: 6130000000 } }, { currentTime: 613.4 }), true);
    // The web client reports progress every few seconds, so lag is expected.
    assert.equal(helpers.isCurrentSession({ PlayState: { PositionTicks: 6000000000 } }, { currentTime: 613.4 }), true);
});

test('isCurrentSession rejects the session of another tab', () => {
    assert.equal(helpers.isCurrentSession({ PlayState: { PositionTicks: 1000000000 } }, { currentTime: 613.4 }), false);
    assert.equal(helpers.isCurrentSession({ PlayState: {} }, { currentTime: 613.4 }), false);
    assert.equal(helpers.isCurrentSession(null, { currentTime: 613.4 }), false);
    assert.equal(helpers.isCurrentSession({ PlayState: { PositionTicks: 6130000000 } }, null), false);
});
