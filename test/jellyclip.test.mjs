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

test('extractItemId uses the hash route when the video is a blob source', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=abc12345-1111-2222-3333-444455556666', search: '' } },
        configurable: true
    });
    const video = { poster: '', currentSrc: '', src: 'blob:https://host/xxxx' };
    assert.equal(helpers.extractItemId(video), 'abc12345-1111-2222-3333-444455556666');
    Reflect.deleteProperty(globalThis, 'window');
});

test('extractItemId handles 32-char bare hex ids (Jellyfin 10.11 format)', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=83d96aec36c433796b4f1db34533b578&serverId=x', search: '' } },
        configurable: true
    });
    const video = { poster: '', currentSrc: '', src: 'blob:http://host/xxxx' };
    assert.equal(helpers.extractItemId(video), '83d96aec36c433796b4f1db34533b578');
    Reflect.deleteProperty(globalThis, 'window');

    // direct play url form
    const video2 = { poster: '', currentSrc: 'http://127.0.0.1:8096/Videos/83d96aec36c433796b4f1db34533b578/stream.mp4?Static=true', src: '' };
    assert.equal(helpers.extractItemId(video2), '83d96aec36c433796b4f1db34533b578');
});

test('extractItemId prefers the route id over a parent-series backdrop poster', () => {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { hash: '#/details?id=b518adfda59c0186013ef6e310fafcc4&serverId=50d832fa6b4549eea4306f6fffd61179', search: '' } },
        configurable: true
    });
    // Poster points at the series (not the episode) — must NOT be picked.
    const video = {
        poster: 'http://host/Items/af5d100a1111b2222c3333d4444e5555f/Images/Backdrop/0?tag=x',
        currentSrc: 'blob:http://host/ffff',
        src: 'blob:http://host/ffff'
    };
    assert.equal(helpers.extractItemId(video), 'b518adfda59c0186013ef6e310fafcc4');
    Reflect.deleteProperty(globalThis, 'window');
});

test('extractItemId returns null when nothing matches', () => {
    const video = { poster: '../resources/placeholder.png', currentSrc: '', src: 'blob:https://host/xxxx' };
    assert.equal(helpers.extractItemId(video), null);
    assert.equal(helpers.extractItemId(null), null);
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
