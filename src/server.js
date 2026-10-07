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

const clientUrls = [...new Set([
  ...(process.env.CLIENT_URL || 'https://vercel-frontend-beta-nine.vercel.app')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  'https://vercel-frontend-lkjj.vercel.app',
])];
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
const pendingRejoinRequests = new Map();
let isShuttingDown = false;

function getPendingRejoinRequests(roomId) {
  return Array.from(pendingRejoinRequests.get(roomId)?.values() || [])
    .map(({ userId, username }) => ({ userId, username }));
}

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
      if (roomManager.isRoomClosed(cleanRoomId)) {
        socket.emit('room_closed', {
          roomId: cleanRoomId,
          message: 'This room is closed.',
        });
        return;
      }
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
      const cleanUserId = String(userId);
      if (room.bannedUserIds.has(cleanUserId)) {
        let roomRequests = pendingRejoinRequests.get(cleanRoomId);
        if (!roomRequests) {
          roomRequests = new Map();
          pendingRejoinRequests.set(cleanRoomId, roomRequests);
        }

        const existingRequest = roomRequests.get(cleanUserId);
        if (existingRequest && existingRequest.socketId !== socket.id) {
          socket.emit('error', { message: 'Your request to rejoin is already waiting for the host.' });
          return;
        }

        roomRequests.set(cleanUserId, {
          userId: cleanUserId,
          username: cleanUsername,
          socketId: socket.id,
        });
        socket.data.pendingRejoinRoomId = cleanRoomId;
        socket.data.pendingRejoinUserId = cleanUserId;
        socket.emit('rejoin_pending', {
          message: 'Your request to rejoin has been sent to the host. Please wait for approval.',
        });
        io.to(cleanRoomId).emit('rejoin_request', {
          userId: cleanUserId,
          username: cleanUsername,
        });
        return;
      }

      participant = room.getParticipant(cleanUserId);
      if (participant) {
        if (participant.socketId && participant.socketId !== socket.id) {
          socket.emit('error', { message: 'You are already in this room.' });
          return;
        }
        participant.socketId = socket.id;
      }
    }

    if (!participant) {
      const duplicateName = Array.from(room.participants.values()).find(
        (current) => current.username.trim().toLowerCase() === cleanUsername.toLowerCase(),
      );
      if (duplicateName) {
        socket.emit('error', { message: 'A participant with this name is already in the room.' });
        return;
      }

      participant = room.getParticipantBySocketId(socket.id)
        || roomManager.addParticipant(cleanRoomId, cleanUsername, socket.id, userId ? String(userId) : undefined);
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

    socket.to(cleanRoomId).emit('participants_updated', room.toJSON().participants);
    socket.emit('sync_state', room.toJSON());
    socket.emit('session', {
      userId: participant.userId,
      roomId: cleanRoomId,
      role: participant.role,
    });
    if (room.hostId === participant.userId) {
      socket.emit('rejoin_requests', getPendingRejoinRequests(cleanRoomId));
    }
  });

  socket.on('approve_rejoin', async ({ roomId, userId } = {}) => {
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    const caller = roomManager.getParticipant(cleanRoomId, socket.data.userId);
    if (
      !room
      || socket.data.roomId !== cleanRoomId
      || !caller
      || caller.socketId !== socket.id
      || room.hostId !== caller.userId
    ) {
      socket.emit('error', { message: 'Only the current host can approve rejoin requests.' });
      return;
    }

    const cleanUserId = String(userId || '');
    const roomRequests = pendingRejoinRequests.get(cleanRoomId);
    const request = roomRequests?.get(cleanUserId);
    const requesterSocket = request && io.sockets.sockets.get(request.socketId);
    if (!request || !requesterSocket || !room.bannedUserIds.has(cleanUserId)) {
      roomRequests?.delete(cleanUserId);
      socket.emit('rejoin_request_resolved', { userId: cleanUserId });
      socket.emit('error', { message: 'That rejoin request is no longer available.' });
      return;
    }

    const duplicateName = Array.from(room.participants.values()).find(
      (current) => current.username.trim().toLowerCase() === request.username.toLowerCase(),
    );
    if (duplicateName) {
      socket.emit('error', { message: `${request.username} cannot rejoin because that name is already in use.` });
      return;
    }

    roomRequests.delete(cleanUserId);
    room.bannedUserIds.delete(cleanUserId);
    const participant = roomManager.addParticipant(cleanRoomId, request.username, requesterSocket.id, cleanUserId);
    try {
      await User.findOneAndUpdate(
        { userId: participant.userId },
        { $set: { username: participant.username, lastSeen: new Date() } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
      await roomManager.persistRoom(cleanRoomId, { throwOnError: true });
    } catch (error) {
      console.error(`Failed to persist approved rejoin in room ${cleanRoomId}:`, error);
      roomManager.removeParticipant(cleanRoomId, cleanUserId);
      room.bannedUserIds.add(cleanUserId);
      if (requesterSocket.connected) {
        roomRequests.set(cleanUserId, request);
      }
      try {
        await roomManager.persistRoom(cleanRoomId, { throwOnError: true });
      } catch (rollbackError) {
        console.error(`Failed to restore rejoin ban in room ${cleanRoomId}:`, rollbackError);
      }
      socket.emit('error', { message: 'The rejoin approval could not be saved. Please try again.' });
      return;
    }

    if (roomRequests.size === 0) {
      pendingRejoinRequests.delete(cleanRoomId);
    }

    requesterSocket.data.roomId = cleanRoomId;
    requesterSocket.data.userId = cleanUserId;
    requesterSocket.data.pendingRejoinRoomId = null;
    requesterSocket.data.pendingRejoinUserId = null;
    requesterSocket.join(cleanRoomId);
    requesterSocket.emit('sync_state', room.toJSON());
    requesterSocket.emit('session', {
      userId: participant.userId,
      roomId: cleanRoomId,
      role: participant.role,
    });
    io.to(cleanRoomId).emit('sync_state', room.toJSON());
    io.to(cleanRoomId).emit('rejoin_request_resolved', { userId: cleanUserId });
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

  socket.on('playback_progress', ({ roomId, time }) => {
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room || socket.data.roomId !== cleanRoomId) {
      return;
    }

    const participant = roomManager.getParticipant(room.roomId, socket.data.userId);
    if (!participant || participant.socketId !== socket.id || !canControlPlayback(participant)) {
      return;
    }

    const seconds = Number(time);
    if (Number.isFinite(seconds) && seconds >= 0) {
      roomManager.updatePlaybackProgress(room.roomId, seconds);
    }
  });

  socket.on('chat_send', (payload = {}) => {
    const { roomId, text, type, videoTime } = payload && typeof payload === 'object' ? payload : {};
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    const participant = roomManager.getParticipant(cleanRoomId, socket.data.userId);
    if (
      !room
      || socket.data.roomId !== cleanRoomId
      || !participant
      || participant.socketId !== socket.id
    ) {
      socket.emit('chat_error', { message: 'Join the room before sending a chat message.' });
      return;
    }

    if (!room.chatEnabled) {
      socket.emit('chat_error', { message: 'Chat is currently turned off by the host.' });
      return;
    }

    const cleanText = typeof text === 'string' ? text.trim() : '';
    const cleanType = type === 'reaction' ? 'reaction' : 'message';
    const allowedReactions = ['❤️', '😂', '👏', '😮', '🔥'];
    if (
      !cleanText
      || cleanText.length > 300
      || (cleanType === 'reaction' && !allowedReactions.includes(cleanText))
    ) {
      socket.emit('chat_error', { message: 'Chat messages must be 1–300 characters, and reactions must use a quick-reaction button.' });
      return;
    }

    const numericVideoTime = Number(videoTime);
    io.to(cleanRoomId).emit('chat_message', {
      id: `${Date.now()}-${socket.id}`,
      roomId: cleanRoomId,
      userId: participant.userId,
      username: participant.username,
      role: participant.role,
      text: cleanText,
      type: cleanType,
      videoTime: Number.isFinite(numericVideoTime) ? Math.max(0, Math.floor(numericVideoTime)) : 0,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('set_chat_enabled', (payload = {}) => {
    const { roomId, enabled } = payload && typeof payload === 'object' ? payload : {};
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    const caller = roomManager.getParticipant(cleanRoomId, socket.data.userId);
    if (
      !room
      || socket.data.roomId !== cleanRoomId
      || !caller
      || caller.socketId !== socket.id
      || room.hostId !== caller.userId
      || !canManageParticipants(caller)
    ) {
      socket.emit('error', { message: 'Only the current host can change chat settings.' });
      return;
    }

    if (typeof enabled !== 'boolean') {
      socket.emit('error', { message: 'Chat setting must be enabled or disabled.' });
      return;
    }

    roomManager.updateChatEnabled(cleanRoomId, enabled);
    emitRoomState(io, cleanRoomId);
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

  socket.on('remove_participant', async ({ roomId, userId }) => {
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

    const removed = roomManager.removeParticipant(room.roomId, userId, { ban: true });
    if (!removed) {
      socket.emit('error', { message: 'Unable to remove this participant.' });
      return;
    }

    let removalPersisted = true;
    try {
      await roomManager.persistRoom(room.roomId, { throwOnError: true });
    } catch (error) {
      console.error(`Failed to persist participant removal in room ${room.roomId}:`, error);
      removalPersisted = false;
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
    if (!removalPersisted) {
      socket.emit('error', { message: 'The participant was removed, but the ban could not be saved.' });
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

    let closedRoom;
    try {
      closedRoom = await roomManager.closeRoom(cleanRoomId);
    } catch (error) {
      console.error(`Failed to persist closed room ${cleanRoomId}:`, error);
      socket.emit('error', { message: 'The room could not be closed permanently. Please try again.' });
      return;
    }
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

  socket.on('leave_room', async ({ roomId, promoteToUserId } = {}) => {
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const participant = roomManager.getParticipant(cleanRoomId, socket.data.userId);
    if (
      socket.data.roomId !== cleanRoomId
      || !participant
      || participant.socketId !== socket.id
    ) {
      socket.leave(room.roomId);
      socket.data.roomId = null;
      socket.data.userId = null;
      return;
    }

    if (room.hostId === participant.userId) {
      let moderator = Array.from(room.participants.values()).find(
        (candidate) => (
          candidate.userId !== participant.userId
          && candidate.role === ROLE_TYPES.MODERATOR
          && candidate.socketId
        ),
      );

      if (!moderator && promoteToUserId) {
        const selected = room.getParticipant(String(promoteToUserId));
        if (!selected || selected.userId === participant.userId || !selected.socketId) {
          socket.emit('error', { message: 'Select a valid participant to promote before leaving.' });
          return;
        }

        selected.role = ROLE_TYPES.MODERATOR;
        moderator = selected;
      }

      if (!moderator) {
        let closedRoom;
        try {
          closedRoom = await roomManager.closeRoom(cleanRoomId);
        } catch (error) {
          console.error(`Failed to close room ${cleanRoomId} after host departure:`, error);
          socket.emit('error', { message: 'The room could not be closed. Please try again.' });
          return;
        }

        io.to(cleanRoomId).emit('room_closed', {
          roomId: cleanRoomId,
          hostId: closedRoom.hostId,
          message: 'The host left without appointing a moderator, so this room is now closed.',
        });
        io.in(cleanRoomId).socketsLeave(cleanRoomId);
        socket.data.roomId = null;
        socket.data.userId = null;
        return;
      }
    }

    roomManager.removeParticipant(cleanRoomId, participant.userId);
    try {
      await roomManager.persistRoom(cleanRoomId, { throwOnError: true });
    } catch (error) {
      console.error(`Failed to persist participant leaving room ${cleanRoomId}:`, error);
      socket.emit('error', { message: 'Your room departure could not be saved.' });
    }
    socket.to(cleanRoomId).emit('user_left', {
      userId: participant.userId,
      roomId: cleanRoomId,
      username: participant.username,
    });

    if (roomManager.getRoom(cleanRoomId)) {
      io.to(cleanRoomId).emit('sync_state', roomManager.getRoom(cleanRoomId).toJSON());
    }

    socket.leave(cleanRoomId);
    socket.data.roomId = null;
    socket.data.userId = null;
    socket.emit('room_left', { roomId: cleanRoomId });
  });

  socket.on('disconnect', () => {
    const pendingRoomId = socket.data.pendingRejoinRoomId;
    const pendingUserId = socket.data.pendingRejoinUserId;
    if (pendingRoomId && pendingUserId) {
      const requests = pendingRejoinRequests.get(pendingRoomId);
      if (requests?.get(pendingUserId)?.socketId === socket.id) {
        requests.delete(pendingUserId);
        if (requests.size === 0) {
          pendingRejoinRequests.delete(pendingRoomId);
        }
        io.to(pendingRoomId).emit('rejoin_request_resolved', { userId: pendingUserId });
      }
    }

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
