const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const { RoomManager, ROLE_TYPES } = require('./roomManager');
const { canControlPlayback, canManageParticipants } = require('./permissions');
const { connectToMongo, closeMongoConnection } = require('./database');
const User = require('./models/User');
const AuthSession = require('./models/AuthSession');
const Profile = require('./models/Profile');
const {
  clearSessionCookie,
  createSession,
  hashPassword,
  resolveSession,
  resolveSocketSession,
  serializeUser,
  validateCsrf,
  verifyPassword,
} = require('./auth');

const app = express();
const server = http.createServer(app);

const clientUrls = new Set(
  (process.env.CLIENT_URL || '')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean),
);
if (process.env.NODE_ENV !== 'production') {
  clientUrls.add('http://localhost:5173');
}
const port = Number(process.env.PORT || 3000);
const rateLimitBuckets = new Map();

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || clientUrls.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '256kb' }));

const roomManager = new RoomManager();
const pendingRejoinRequests = new Map();
let isShuttingDown = false;
let io;

app.set('trust proxy', 1);

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

function rateLimit({ limit, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets) {
      if (bucket.expiresAt <= now) rateLimitBuckets.delete(key);
    }

    const key = `${req.ip}:${req.path}`;
    const bucket = rateLimitBuckets.get(key);
    if (bucket && bucket.count >= limit) {
      res.set('Retry-After', String(Math.ceil((bucket.expiresAt - now) / 1000)));
      return res.status(429).json({ message: 'Too many attempts. Please try again later.' });
    }

    if (!bucket || bucket.expiresAt <= now) {
      rateLimitBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    } else {
      bucket.count += 1;
    }
    return next();
  };
}

async function requireAuth(req, res, next) {
  try {
    const auth = await resolveSession(req.headers.cookie);
    if (!auth) return res.status(401).json({ message: 'Please sign in to continue.' });
    req.authSession = auth.session;
    req.user = auth.user;
    return next();
  } catch (error) {
    console.error('Failed to resolve authenticated session:', error);
    return res.status(500).json({ message: 'Unable to verify your session.' });
  }
}

function requireTrustedOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin || !clientUrls.has(origin)) {
    return res.status(403).json({ message: 'Request origin is not allowed.' });
  }
  return next();
}

function requireCsrf(req, res, next) {
  if (!validateCsrf(req.authSession, req.get('x-csrf-token'))) {
    return res.status(403).json({ message: 'Your session could not be verified. Refresh and try again.' });
  }
  return next();
}

app.post('/api/auth/register', rateLimit({ limit: 3, windowMs: 15 * 60 * 1000 }), requireTrustedOrigin, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (username.length < 2 || username.length > 30) {
    return res.status(400).json({ message: 'Username must be between 2 and 30 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ message: 'Enter a valid email address.' });
  }
  if (password.length < 10 || password.length > 128) {
    return res.status(400).json({ message: 'Password must be between 10 and 128 characters.' });
  }

  try {
    if (await User.exists({ email })) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const user = await User.create({ username, email, passwordHash, avatarUrl: '' });
    await syncProfile(user);
    const { csrfToken } = await createSession(user, res);
    return res.status(201).json({ user: serializeUser(user), csrfToken });
  } catch (error) {
    if (error.code === 11000 && (error.keyPattern?.email || error.keyValue?.email)) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: 'Please check your account details and try again.' });
    }
    console.error('Failed to register account:', error);
    return res.status(500).json({ message: 'Unable to create your account right now.' });
  }
});

app.post('/api/auth/login', rateLimit({ limit: 8, windowMs: 15 * 60 * 1000 }), requireTrustedOrigin, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 128) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  try {
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !await verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    await syncProfile(user);
    const { csrfToken } = await createSession(user, res);
    return res.json({ user: serializeUser(user), csrfToken });
  } catch (error) {
    console.error('Failed to log in:', error);
    return res.status(500).json({ message: 'Unable to sign in right now.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  syncProfile(req.user)
    .then(() => res.json({ user: serializeUser(req.user), csrfToken: req.authSession.csrfToken }))
    .catch((error) => {
      console.error('Failed to sync user profile:', error);
      res.status(500).json({ message: 'Unable to load your profile right now.' });
    });
});

app.post('/api/auth/logout', requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  try {
    const sessionId = String(req.authSession._id);
    await AuthSession.deleteOne({ _id: req.authSession._id });
    clearSessionCookie(res);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.authSessionId === sessionId) socket.disconnect(true);
    }
    return res.json({ message: 'Signed out successfully.' });
  } catch (error) {
    console.error('Failed to log out:', error);
    return res.status(500).json({ message: 'Unable to sign out right now.' });
  }
});

app.patch('/api/users/me', requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const updates = {};
  if (Object.hasOwn(req.body || {}, 'username')) {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    if (username.length < 2 || username.length > 30) {
      return res.status(400).json({ message: 'Username must be between 2 and 30 characters.' });
    }
    updates.username = username;
  }
  if (Object.hasOwn(req.body || {}, 'avatarUrl')) {
    const avatarUrl = typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl.trim() : '';
    const isDataUrl = avatarUrl.startsWith('data:');
    const isPresetAvatar = /^preset:(fox|panda|cat|frog|tiger|koala|octopus|unicorn)$/.test(avatarUrl);
    if (avatarUrl && !isPresetAvatar) {
      if (isDataUrl) {
        const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatarUrl);
        if (!match || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) {
          return res.status(400).json({ message: 'Avatar must be a valid JPG, PNG, or WebP image.' });
        }
      } else {
        try {
          if (new URL(avatarUrl).protocol !== 'https:') throw new Error('Unsupported URL scheme.');
        } catch {
          return res.status(400).json({ message: 'Avatar must be a valid HTTPS image URL.' });
        }
      }
    }
    if (isDataUrl && avatarUrl.length > 240 * 1024) {
      return res.status(400).json({ message: 'Avatar image is too large.' });
    }
    if (!isDataUrl && avatarUrl.length > 2048) {
      return res.status(400).json({ message: 'Avatar URL is too long.' });
    }
    updates.avatarUrl = avatarUrl;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: 'Provide a username or profile photo to update.' });
  }

  try {
    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, {
      new: true,
      runValidators: true,
    });
    if (!user) return res.status(401).json({ message: 'Please sign in to continue.' });
    await syncProfile(user);
    if (updates.username || updates.avatarUrl !== undefined) {
      for (const room of roomManager.rooms.values()) {
        const participant = room.getParticipant(String(user._id));
        if (participant) {
          participant.username = user.username;
          if (updates.avatarUrl !== undefined) {
            participant.avatarUrl = user.avatarUrl || '';
          }
          await roomManager.persistRoom(room.roomId, { throwOnError: true });
          emitRoomState(io, room.roomId);
        }
      }
    }
    return res.json({ user: serializeUser(user) });
  } catch (error) {
    console.error('Failed to update user profile:', error);
    return res.status(500).json({ message: 'Unable to update your profile right now.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Watch Party backend is running.' });
});

app.post('/api/rooms', requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const username = req.user.username;
  const userId = String(req.user._id);
  const { room, participant } = roomManager.createRoom({
    username,
    userId,
    socketId: null,
    avatarUrl: req.user.avatarUrl || '',
  });
  try {
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

io = new Server(server, {
  cors: { ...corsOptions, methods: ['GET', 'POST'] },
});

io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    if (!origin || !clientUrls.has(origin)) {
      return next(new Error('Origin is not allowed.'));
    }
    const auth = await resolveSession(socket.handshake.headers.cookie)
      || await resolveSocketSession(socket.handshake.auth?.csrfToken);
    if (!auth) return next(new Error('Authentication required.'));
    socket.data.user = auth.user;
    socket.data.authSessionId = String(auth.session._id);
    socket.data.authExpiresAt = auth.session.expiresAt;
    return next();
  } catch (error) {
    console.error('Failed to authenticate Socket.IO connection:', error);
    return next(new Error('Unable to verify authentication.'));
  }
});

io.on('connection', (socket) => {
  const authExpiryTimer = setTimeout(
    () => socket.disconnect(true),
    Math.max(0, new Date(socket.data.authExpiresAt).getTime() - Date.now()),
  );
  socket.on('join_room', async (payload = {}) => {
    const { roomId } = payload && typeof payload === 'object' ? payload : {};
    const cleanRoomId = String(roomId || '').trim().toUpperCase();
    const cleanUsername = socket.data.user.username;
    const cleanUserId = String(socket.data.user._id);

    if (!cleanRoomId) {
      socket.emit('error', { message: 'Please enter a valid room code.' });
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

    {
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
        const existingSocket = participant.socketId
          ? io.sockets.sockets.get(participant.socketId)
          : null;
        if (existingSocket && participant.socketId !== socket.id) {
          socket.emit('error', { message: 'This profile is already connected to the room.' });
          return;
        }
        participant.socketId = socket.id;
      }
    }

    if (!participant) {
      participant = room.getParticipantBySocketId(socket.id)
        || roomManager.addParticipant(
          cleanRoomId,
          cleanUsername,
          socket.id,
          cleanUserId,
          socket.data.user.avatarUrl || '',
        );
    }

    if (participant.username !== cleanUsername) {
      participant.username = cleanUsername;
    }
    participant.avatarUrl = socket.data.user.avatarUrl || '';

    try {
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
    const participant = roomManager.addParticipant(
      cleanRoomId,
      request.username,
      requesterSocket.id,
      cleanUserId,
      requesterSocket.data.user.avatarUrl || '',
    );
    try {
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
    if (
      !participant
      || participant.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canControlPlayback(participant)
    ) {
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
    if (
      !participant
      || participant.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canControlPlayback(participant)
    ) {
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
    if (
      !participant
      || participant.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canControlPlayback(participant)
    ) {
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
      avatarUrl: participant.avatarUrl,
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
    if (
      !participant
      || participant.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canControlPlayback(participant)
    ) {
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
    if (
      !caller
      || caller.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canManageParticipants(caller)
    ) {
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
    if (
      !caller
      || caller.socketId !== socket.id
      || socket.data.roomId !== room.roomId
      || !canManageParticipants(caller)
    ) {
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
    clearTimeout(authExpiryTimer);
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
  if (process.env.NODE_ENV === 'production' && clientUrls.size === 0) {
    throw new Error('CLIENT_URL must contain the deployed frontend origin in production.');
  }
  const roomsCollection = await connectToMongo();
  await Promise.all([User.init(), AuthSession.init(), Profile.init()]);
  await backfillProfiles();
  await roomManager.initialize(roomsCollection);
  console.log(`Loaded ${roomManager.rooms.size} saved room(s).`);

  server.listen(port, () => {
    console.log(`Watch party server running on port ${port}`);
  });
}

async function syncProfile(user) {
  return Profile.findOneAndUpdate(
    { userId: user._id },
    { $set: { username: user.username, email: user.email } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

async function backfillProfiles() {
  let writes = [];
  for await (const user of User.find().select('_id username email').lean().cursor()) {
    writes.push({
      updateOne: {
        filter: { userId: user._id },
        update: { $set: { username: user.username, email: user.email } },
        upsert: true,
      },
    });
    if (writes.length === 500) {
      await Profile.bulkWrite(writes, { ordered: false });
      writes = [];
    }
  }
  if (writes.length > 0) {
    await Profile.bulkWrite(writes, { ordered: false });
  }
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
