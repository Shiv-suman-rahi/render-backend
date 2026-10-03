const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();

const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/db');
const User = require('../src/models/User');
const Room = require('../src/models/Room');

const names = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor'];
const videoIds = ['dQw4w9WgXcQ', 'M7lc1UVf-VE'];
const roomAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomId() {
  return Array.from({ length: 6 }, () => roomAlphabet[Math.floor(Math.random() * roomAlphabet.length)]).join('');
}

async function seed() {
  await connectDB();

  const demoUsers = names.map((username) => ({
    userId: randomUUID(),
    username,
    lastSeen: new Date(),
  }));

  await User.insertMany(demoUsers);

  const roomDocuments = [
    {
      roomId: makeRoomId(),
      hostId: demoUsers[0].userId,
      videoId: videoIds[0],
      playState: 'PAUSED',
      currentTime: 42,
      participants: [
        { userId: demoUsers[0].userId, username: demoUsers[0].username, role: 'host' },
        { userId: demoUsers[1].userId, username: demoUsers[1].username, role: 'moderator' },
        { userId: demoUsers[2].userId, username: demoUsers[2].username, role: 'participant' },
      ],
    },
    {
      roomId: makeRoomId(),
      hostId: demoUsers[3].userId,
      videoId: videoIds[1],
      playState: 'PLAYING',
      currentTime: 128,
      participants: [
        { userId: demoUsers[3].userId, username: demoUsers[3].username, role: 'host' },
        { userId: demoUsers[4].userId, username: demoUsers[4].username, role: 'moderator' },
        { userId: demoUsers[5].userId, username: demoUsers[5].username, role: 'participant' },
      ],
    },
  ];

  const createdRooms = await Room.create(roomDocuments);

  console.log(`Created ${demoUsers.length} demo users and ${createdRooms.length} demo rooms.`);
  for (const room of createdRooms) {
    console.log(`Room ${room.roomId}: ${room.participants.map(({ username, role }) => `${username} (${role})`).join(', ')}`);
  }
}

seed()
  .catch((error) => {
    console.error('Failed to seed demo data:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  });
