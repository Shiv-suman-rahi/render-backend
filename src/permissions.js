const { ROLE_TYPES } = require('./roomManager');

function canControlPlayback(participant) {
  return Boolean(
    participant &&
      (participant.role === ROLE_TYPES.HOST || participant.role === ROLE_TYPES.MODERATOR),
  );
}

function canManageParticipants(participant) {
  return Boolean(participant && participant.role === ROLE_TYPES.HOST);
}

function isHost(room, userId) {
  return Boolean(room && room.hostId === userId);
}

module.exports = {
  canControlPlayback,
  canManageParticipants,
  isHost,
  ROLE_TYPES,
};
