import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connect, mockConfig, mockHttp, resultText } from './helpers.js';

process.env.SPOTIFY_RETRY_BASE_MS = '0';

const P22 = 'P'.repeat(22);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function tempFile(t, name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function upload(t, http, args) {
  mockConfig(t);
  mockHttp(t, http);
  const client = await connect(t, { pin: '2026-07-28' });
  return client.callTool({ name: 'uploadPlaylistCover', arguments: args });
}

test('uploadPlaylistCover sends a local JPEG as base64', async (t) => {
  const file = tempFile(t, 'cover.jpg', jpeg);
  const result = await upload(
    t,
    [
      {
        url: `playlists/${P22}/images`,
        method: 'PUT',
        contentType: 'image/jpeg',
        rawBody: jpeg.toString('base64'),
        status: 202,
      },
    ],
    { playlistId: P22, image: file },
  );
  assert.match(resultText(result), /cover/i);
});

test('uploadPlaylistCover downloads an image URL first', async (t) => {
  t.mock.method(dns.promises, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
  const result = await upload(
    t,
    [
      {
        url: 'https://images.example.com/cover.jpg',
        authorization: null,
        bytes: jpeg,
      },
      {
        url: `playlists/${P22}/images`,
        method: 'PUT',
        rawBody: jpeg.toString('base64'),
        status: 202,
      },
    ],
    { playlistId: P22, image: 'https://images.example.com/cover.jpg' },
  );
  assert.match(resultText(result), /cover/i);
});

for (const [label, url, address] of [
  ['localhost', 'http://localhost:8080/cover.jpg', '127.0.0.1'],
  ['a private network host', 'https://nas.lan/cover.jpg', '192.168.1.10'],
  ['a link-local address', 'http://169.254.169.254/latest', '169.254.169.254'],
  ['an IPv6 loopback', 'http://[::1]/cover.jpg', '::1'],
]) {
  test(`uploadPlaylistCover refuses to fetch from ${label}`, async (t) => {
    t.mock.method(dns.promises, 'lookup', async () => [
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    const result = await upload(t, [], { playlistId: P22, image: url });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /public/);
  });
}

test('uploadPlaylistCover only reads local files with a .jpg/.jpeg extension', async (t) => {
  const file = tempFile(t, 'secret.txt', jpeg);
  const result = await upload(t, [], { playlistId: P22, image: file });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\.jpg/);
});

test('uploadPlaylistCover rejects non-JPEG files without calling Spotify', async (t) => {
  const file = tempFile(t, 'cover.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await upload(t, [], { playlistId: P22, image: file });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /JPEG/);
});

test('uploadPlaylistCover rejects images over the 256 KB base64 limit', async (t) => {
  const big = Buffer.concat([jpeg, Buffer.alloc(200 * 1024)]);
  const file = tempFile(t, 'big.jpg', big);
  const result = await upload(t, [], { playlistId: P22, image: file });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /256 KB/);
});

test('uploadPlaylistCover explains a missing ugc-image-upload scope', async (t) => {
  const file = tempFile(t, 'cover.jpg', jpeg);
  const result = await upload(
    t,
    [
      {
        url: `playlists/${P22}/images`,
        method: 'PUT',
        status: 401,
        response: { error: { status: 401, message: 'Missing scope' } },
      },
    ],
    { playlistId: P22, image: file },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /npm run auth/);
});
