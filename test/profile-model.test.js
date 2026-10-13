const test = require('node:test');
const assert = require('node:assert/strict');
const Profile = require('../src/models/Profile');

test('profile documents store account details without avatar image data', () => {
  assert.equal(Profile.schema.path('userId').options.unique, true);
  assert.equal(Profile.schema.path('username').options.required, true);
  assert.equal(Profile.schema.path('email').options.required, true);
  assert.equal(Profile.schema.path('avatarUrl'), undefined);
  assert.equal(Profile.schema.options.timestamps, true);
});
