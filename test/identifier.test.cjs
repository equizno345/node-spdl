const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

// Test the internal entity classes without expanding the package's public API.
const filename = path.resolve(__dirname, '../src/lib/entity.ts');
const compiled = new Module(filename, module);
compiled._compile(buildSync({entryPoints:[filename], bundle:true, platform:'node', format:'cjs', write:false}).outputFiles[0].text, filename);
const {TrackEntity, EpisodeEntity} = compiled.exports;
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

test('track and episode identifiers represent fixed-width 128-bit numbers', () => {
  const ids = ['45AepEzwUs3GjhNxhh49ip', '0DJJEcuXlbNx2bRKe1CCCL', '003vvx7Niy0yvhvHt4a68B', '0000000000000000000001', '0000000000000000000000'];
  for (const id of ids) {
    const expected = [...id].reduce((value, digit) => value * 62n + BigInt(alphabet.indexOf(digit)), 0n).toString(16).padStart(32, '0');
    for (const [kind, Entity] of [['track', TrackEntity], ['episode', EpisodeEntity]]) {
      assert.equal(new Entity(`spotify:${kind}:${id}`).toHex(), expected);
    }
  }
});

test('identifier conversion rejects malformed and overflowing values', () => {
  for (const Entity of [TrackEntity, EpisodeEntity]) {
    const kind = Entity === TrackEntity ? 'track' : 'episode';
    for (const id of ['short', 'z'.repeat(22), '1'.repeat(23)]) {
      assert.throws(() => new Entity(`spotify:${kind}:${id}`).toHex(), /identifier/);
    }
  }
});
