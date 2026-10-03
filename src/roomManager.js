const crypto = require('crypto');

const ROLE_TYPES = Object.freeze({
  HOST: 'host',
  MODERATOR: 'moderator',
  PARTICIPANT: 'participant',
});

function normalizeRole(role) {
  const nextRole = String(role || '').trim().toLowerCase();
  if (nextRole === ROLE_TYPES.HOST || nextRole === ROLE_TYPES.MODERATOR || nextRole === ROLE_TYPES.PARTICIPANT) {
    return nextRole;
  }
  return ROLE_TYPES.PARTICIPANT;
}

class Participant {
  constructor(userId, username, socketId, role = ROLE_TYPES.PARTICIPANT) {
    this.userId = userId;
    this.username = username;
    this.socketId = socketId;
    this.role = normalizeRole(role);
    this.connectedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      userId: this.userId,
      username: this.username,
      role: this.role,
      socketId: this.socketId,
      connectedAt: this.connectedAt,
      online: Boolean(this.socketId),
    };
  }
}

class Room {
  constructor(roomId, hostId) {
    this.roomId = roomId;
    this.hostId = hostId;
    this.videoId = 'fb4rgYbi84c';
    this.currentTime = 0;
    this.playState = 'PAUSED';
    this.participants = new Map();
    this.createdAt = new Date().toISOString();
  }

  addParticipant(participant) {
    this.participants.set(participant.userId, participant);
  }

  getParticipant(userId) {
    return this.participants.get(userId) || null;
  }

  getParticipantBySocketId(socketId) {
    for (const participant of this.participants.values()) {
      if (participant.socketId === socketId) {
        return participant;
      }
    }
    return null;
  }

  removeParticipant(userId) {
    const participant = this.participants.get(userId);
    if (!participant) {
      return null;
    }

    this.participants.delete(userId);

    if (this.participants.size === 0) {
      return participant;
    }

    if (this.hostId === userId) {
      const [nextHost] = this.participants.values();
      if (nextHost) {
        this.hostId = nextHost.userId;
        nextHost.role = ROLE_TYPES.HOST;
      }
    }

    return participant;
  }

  assignRole(userId, role) {
    const participant = this.getParticipant(userId);
    if (!participant) {
      return null;
    }

    const nextRole = normalizeRole(role);
    if (nextRole === ROLE_TYPES.HOST) {
      return null;
    }

    participant.role = nextRole;
    return participant;
  }

  toJSON() {
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      videoId: this.videoId,
      currentTime: this.currentTime,
      playState: this.playState,
      participants: Array.from(this.participants.values()).map((participant) => participant.toJSON()),
      createdAt: this.createdAt,
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.roomsCollection = null;
    this.pendingWrites = new Map();
  }

  async initialize(roomsCollection) {
    this.roomsCollection = roomsCollection;
    const documents = await roomsCollection.find({}).toArray();

    for (const document of documents) {
      const room = new Room(document.roomId, document.hostId);
      room.videoId = document.videoId;
      room.currentTime = document.currentTime;
      room.playState = document.playState;
      room.createdAt = document.createdAt;

      for (const savedParticipant of document.participants || []) {
        const participant = new Participant(
          savedParticipant.userId,
          savedParticipant.username,
          null,
          savedParticipant.role,
        );
        participant.connectedAt = savedParticipant.connectedAt;
        room.addParticipant(participant);
      }

      if (room.participants.size > 0) {
        this.rooms.set(room.roomId, room);
      } else {
        await roomsCollection.deleteOne({ roomId: room.roomId });
      }
    }
  }

  persistRoom(roomId, { throwOnError = false } = {}) {
    if (!this.roomsCollection) {
      return Promise.resolve();
    }

    const previousWrite = this.pendingWrites.get(roomId) || Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        const room = this.getRoom(roomId);
        if (!room) {
          await this.roomsCollection.deleteOne({ roomId });
          return;
        }

        const document = room.toJSON();
        document.participants = document.participants.map((participant) => ({
          userId: participant.userId,
          username: participant.username,
          role: participant.role,
          connectedAt: participant.connectedAt,
        }));
        await this.roomsCollection.replaceOne({ roomId }, document, { upsert: true });
      })
      .catch((error) => {
        console.error(`Failed to persist room ${roomId}:`, error);
        if (throwOnError) {
          throw error;
        }
      });

    this.pendingWrites.set(roomId, nextWrite);
    const clearPendingWrite = () => {
      if (this.pendingWrites.get(roomId) === nextWrite) {
        this.pendingWrites.delete(roomId);
      }
    };
    nextWrite.then(clearPendingWrite, clearPendingWrite);

    return nextWrite;
  }

  async flushPendingWrites() {
    await Promise.all([...this.pendingWrites.values()]);
  }

  createUserId() {
    return crypto.randomUUID();
  }

  generateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  createRoom({ username, socketId, userId }) {
    let roomId = this.generateRoomCode();
    while (this.rooms.has(roomId)) {
      roomId = this.generateRoomCode();
    }

    const hostId = userId || this.createUserId();
    const host = new Participant(hostId, username, socketId, ROLE_TYPES.HOST);
    const room = new Room(roomId, hostId);
    room.addParticipant(host);
    this.rooms.set(roomId, room);
    this.persistRoom(roomId);

    return {
      room,
      participant: host,
    };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  addParticipant(roomId, username, socketId) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error('Room not found');
    }

    const userId = this.createUserId();
    const participant = new Participant(userId, username, socketId, ROLE_TYPES.PARTICIPANT);
    room.addParticipant(participant);
    this.persistRoom(roomId);
    return participant;
  }

  removeParticipant(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const participant = room.removeParticipant(userId);
    if (room.participants.size === 0) {
      this.rooms.delete(roomId);
    }
    this.persistRoom(roomId);

    return participant;
  }

  async closeRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    this.rooms.delete(roomId);
    await this.persistRoom(roomId);
    return room;
  }

  getParticipant(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    return room.getParticipant(userId);
  }

  markParticipantOffline(roomId, userId, socketId) {
    const participant = this.getParticipant(roomId, userId);
    if (!participant || participant.socketId !== socketId) {
      return null;
    }

    participant.socketId = null;
    this.persistRoom(roomId);
    return participant;
  }

  getParticipantBySocketId(roomId, socketId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    return room.getParticipantBySocketId(socketId);
  }

  assignRole(roomId, userId, role) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const participant = room.getParticipant(userId);
    if (!participant) {
      return null;
    }

    if (role === ROLE_TYPES.HOST && room.hostId !== userId) {
      const previousHost = room.getParticipant(room.hostId);
      if (previousHost) {
        previousHost.role = ROLE_TYPES.PARTICIPANT;
      }
      participant.role = ROLE_TYPES.HOST;
      room.hostId = userId;
      this.persistRoom(roomId);
      return participant;
    }

    participant.role = role;
    this.persistRoom(roomId);
    return participant;
  }

  updateVideo(roomId, videoId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    room.videoId = videoId;
    room.currentTime = 0;
    room.playState = 'PAUSED';
    this.persistRoom(roomId);
    return room;
  }

  updatePlayback(roomId, { currentTime, playState }) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
      room.currentTime = currentTime;
    }

    if (playState === 'PLAYING' || playState === 'PAUSED') {
      room.playState = playState;
    }

    this.persistRoom(roomId);
    return room;
  }
}

module.exports = {
  RoomManager,
  ROLE_TYPES,
  Room,
  Participant,
};
