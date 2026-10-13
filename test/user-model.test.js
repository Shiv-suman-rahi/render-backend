const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');

test('userId uses a unique non-sparse index compatible with existing deployments', () => {
  const userIdIndex = User.schema.indexes().find(([keys]) => keys.userId === 1);

  assert.ok(userIdIndex);
  assert.equal(userIdIndex[1].unique, true);
  assert.equal(userIdIndex[1].sparse, undefined);
});

test('avatar field accepts resized image data and remains size-limited', () => {
  assert.equal(User.schema.path('avatarUrl').options.maxlength, 240 * 1024);
});
