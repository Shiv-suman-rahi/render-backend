const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../src/roomManager');

test('room participants expose and persist their profile avatar', async () => {
  const manager = new RoomManager();
  const { room } = manager.createRoom({
    username: 'Taylor',
    userId: 'user-1',
    socketId: null,
    avatarUrl: 'preset:fox',
  });

  assert.equal(room.toJSON().participants[0].avatarUrl, 'preset:fox');

  const persisted = [];
  const collection = {
    find: () => ({ toArray: async () => [] }),
    replaceOne: async (_filter, document) => persisted.push(document),
  };
  await manager.initialize(collection);
  await manager.persistRoom(room.roomId, { throwOnError: true });

  assert.equal(persisted[0].participants[0].avatarUrl, 'preset:fox');
});
