const { ROLE_TYPES } = require('./roomManager');

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function canControlPlayback(participant) {
  return Boolean(
    participant &&
      (normalizeRole(participant.role) === ROLE_TYPES.HOST || normalizeRole(participant.role) === ROLE_TYPES.MODERATOR),
  );
}

function canManageParticipants(participant) {
  return Boolean(participant && normalizeRole(participant.role) === ROLE_TYPES.HOST);
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
