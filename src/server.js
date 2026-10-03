const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const { RoomManager, ROLE_TYPES } = require('./roomManager');
const { canControlPlayback, canManageParticipants, isHost } = require('./permissions');
const { connectToMongo, closeMongoConnection } = require('./database');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);

const clientUrls = (process.env.CLIENT_URL || 'https://vercel-frontend-beta-nine.vercel.app')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const port = Number(process.env.PORT || 3000);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || clientUrls.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const roomManager = new RoomManager();
let isShuttingDown = false;

function emitRoomState(ioInstance, roomId) {
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return;
  }

  ioInstance.to(roomId).emit('sync_state', room.toJSON());
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Watch Party backend is running.' });
});

app.post('/api/rooms', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!username || username.length < 2) {
    return res.status(400).json({ message: 'Username must be at least 2 characters long.' });
  }

  const { room, participant } = roomManager.createRoom({ username, socketId: null });
  try {
    await User.findOneAndUpdate(
      { userId: participant.userId },
      { $set: { username, lastSeen: new Date() } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    await roomManager.persistRoom(room.roomId, { throwOnError: true });

    return res.status(201).json({
      roomId: room.roomId,
      userId: participant.userId,
      room: room.toJSON(),
    });
  } catch (error) {
    console.error('Failed to save newly created room:', error);
    return res.status(500).json({ message: 'The room could not be saved. Please try again.' });
  }
});

const io = new Server(server, {
  cors: { ...corsOptions, methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomId, username, userId }) => {
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const cleanUsername = String(username || '').trim();

    if (!cleanRoomId || !cleanUsername) {
      socket.emit('error', { message: 'Please enter a valid room code and username.' });
      return;
    }

    const room = roomManager.getRoom(cleanRoomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found. Please check the code and try again.' });
      return;
    }

    const existingParticipant = roomManager.getParticipantBySocketId(cleanRoomId, socket.id);
    if (existingParticipant) {
      socket.emit('error', { message: 'You are already in this room.' });
      return;
    }

    let participant = null;

    if (userId) {
      participant = room.getParticipant(String(userId));
      if (participant) {
        participant.socketId = socket.id;
      }
    }

    if (!participant) {
      participant = room.getParticipantBySocketId(socket.id) || roomManager.addParticipant(cleanRoomId, cleanUsername, socket.id);
    }

    if (participant.username !== cleanUsername) {
      participant.username = cleanUsername;
    }

    try {
      await User.findOneAndUpdate(
        { userId: participant.userId },
        { $set: { username: cleanUsername, lastSeen: new Date() } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
      await roomManager.persistRoom(cleanRoomId, { throwOnError: true });
    } catch (error) {
      console.error(`Failed to save participant joining room ${cleanRoomId}:`, error);
      socket.emit('error', { message: 'Could not save your room session. Please try again.' });
      return;
    }

    socket.join(cleanRoomId);
    socket.data.roomId = cleanRoomId;
    socket.data.userId = participant.userId;

    io.to(cleanRoomId).emit('sync_state', room.toJSON());
    socket.emit('session', {
      userId: participant.userId,
      roomId: cleanRoomId,
      role: participant.role,
    });
  });

  socket.on('play', ({ roomId }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant || !canControlPlayback(participant)) {
      socket.emit('error', { message: 'You do not have permission to control playback.' });
      return;
    }

    roomManager.updatePlayback(room.roomId, { playState: 'PLAYING' });
    io.to(room.roomId).emit('sync_state', room.toJSON());
  });

  socket.on('pause', ({ roomId }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant || !canControlPlayback(participant)) {
      socket.emit('error', { message: 'You do not have permission to pause playback.' });
      return;
    }

    roomManager.updatePlayback(room.roomId, { playState: 'PAUSED' });
    io.to(room.roomId).emit('sync_state', room.toJSON());
  });

  socket.on('seek', ({ roomId, time }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant || !canControlPlayback(participant)) {
      socket.emit('error', { message: 'You do not have permission to seek.' });
      return;
    }

    const seconds = Number(time);
    if (!Number.isFinite(seconds)) {
      socket.emit('error', { message: 'Seek time must be a number.' });
      return;
    }

    roomManager.updatePlayback(room.roomId, { currentTime: Math.max(0, seconds) });
    io.to(room.roomId).emit('sync_state', room.toJSON());
  });

  socket.on('change_video', ({ roomId, videoId }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant || !canControlPlayback(participant)) {
      socket.emit('error', { message: 'You do not have permission to change the video.' });
      return;
    }

    const youtubeId = String(videoId || '').trim();
    if (!youtubeId) {
      socket.emit('error', { message: 'Please enter a valid YouTube URL.' });
      return;
    }

    roomManager.updateVideo(room.roomId, youtubeId);
    io.to(room.roomId).emit('sync_state', room.toJSON());
    socket.to(room.roomId).emit('video_changed', { videoId: youtubeId });
  });

  socket.on('assign_role', ({ roomId, userId, role }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const caller = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!caller || !canManageParticipants(caller)) {
      socket.emit('error', { message: 'Only the host can manage roles.' });
      return;
    }

    if (!Object.values(ROLE_TYPES).includes(role)) {
      socket.emit('error', { message: 'Invalid role selected.' });
      return;
    }

    const target = roomManager.getParticipant(room.roomId, userId);
    if (!target) {
      socket.emit('error', { message: 'Participant not found.' });
      return;
    }

    const updated = roomManager.assignRole(room.roomId, userId, role);
    if (!updated) {
      socket.emit('error', { message: 'Unable to assign the requested role.' });
      return;
    }

    io.to(room.roomId).emit('sync_state', room.toJSON());
    io.to(room.roomId).emit('role_assigned', {
      userId: updated.userId,
      role: updated.role,
      roomId: room.roomId,
    });
  });

  socket.on('remove_participant', ({ roomId, userId }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const caller = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!caller || !canManageParticipants(caller)) {
      socket.emit('error', { message: 'Only the host can remove participants.' });
      return;
    }

    const target = roomManager.getParticipant(room.roomId, userId);
    if (!target) {
      socket.emit('error', { message: 'Participant not found.' });
      return;
    }

    if (userId === room.hostId) {
      socket.emit('error', { message: 'The host cannot be removed.' });
      return;
    }

    const removed = roomManager.removeParticipant(room.roomId, userId);
    if (!removed) {
      socket.emit('error', { message: 'Unable to remove this participant.' });
      return;
    }

    if (roomManager.getRoom(room.roomId)) {
      io.to(room.roomId).emit('sync_state', roomManager.getRoom(room.roomId).toJSON());
    }

    io.to(room.roomId).emit('participant_removed', {
      userId: removed.userId,
      roomId: room.roomId,
      username: removed.username,
    });

    const removedSocket = io.sockets.sockets.get(removed.socketId);
    if (removedSocket) {
      removedSocket.emit('removed_from_room', {
        message: 'You were removed from the room by the host.',
      });
      removedSocket.leave(room.roomId);
      removedSocket.data.roomId = null;
      removedSocket.data.userId = null;
    }
  });

  socket.on('close_room', async ({ roomId }) => {
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const caller = roomManager.getParticipant(cleanRoomId, socket.data.userId);
    if (
      socket.data.roomId !== cleanRoomId
      || !caller
      || caller.socketId !== socket.id
      || room.hostId !== caller.userId
      || !canManageParticipants(caller)
    ) {
      socket.emit('error', { message: 'Only the current host can close this room.' });
      return;
    }

    const closedRoom = await roomManager.closeRoom(cleanRoomId);
    if (!closedRoom) {
      socket.emit('error', { message: 'Unable to close this room.' });
      return;
    }

    io.to(cleanRoomId).emit('room_closed', {
      roomId: cleanRoomId,
      hostId: closedRoom.hostId,
      message: 'The host closed this watch party.',
    });
    io.in(cleanRoomId).socketsLeave(cleanRoomId);
  });

  socket.on('leave_room', ({ roomId }) => {
    const room = roomManager.getRoom(String(roomId || '').trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant) {
      socket.leave(room.roomId);
      socket.data.roomId = null;
      socket.data.userId = null;
      return;
    }

    roomManager.removeParticipant(room.roomId, socket.data.userId);
    socket.to(room.roomId).emit('user_left', {
      userId: participant.userId,
      roomId: room.roomId,
      username: participant.username,
    });

    if (roomManager.getRoom(room.roomId)) {
      io.to(room.roomId).emit('sync_state', roomManager.getRoom(room.roomId).toJSON());
    }

    socket.leave(room.roomId);
    socket.data.roomId = null;
    socket.data.userId = null;
  });

  socket.on('disconnect', () => {
    if (isShuttingDown) {
      return;
    }

    const roomId = socket.data.roomId;
    const userId = socket.data.userId;
    if (!roomId || !userId) {
      return;
    }

    const room = roomManager.getRoom(roomId);
    if (!room) {
      return;
    }

    const participant = roomManager.markParticipantOffline(roomId, userId, socket.id);
    if (!participant) {
      return;
    }

    socket.to(roomId).emit('user_offline', {
      userId: participant.userId,
      roomId,
      username: participant.username,
    });

    io.to(roomId).emit('sync_state', roomManager.getRoom(roomId).toJSON());
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing server or change the PORT value in the backend .env file.`);
    process.exit(1);
  }

  console.error('Failed to start Watch Party server:', error);
  process.exit(1);
});

async function startServer() {
  const roomsCollection = await connectToMongo();
  await roomManager.initialize(roomsCollection);
  console.log(`Loaded ${roomManager.rooms.size} saved room(s).`);

  server.listen(port, () => {
    console.log(`Watch party server running on port ${port}`);
  });
}

async function shutdown() {
  isShuttingDown = true;
  io.close(async () => {
    await roomManager.flushPendingWrites();
    await closeMongoConnection();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer().catch(async (error) => {
  console.error('Failed to connect to MongoDB or start the server:', error);
  await closeMongoConnection();
  process.exit(1);
});
