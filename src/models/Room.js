const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['host', 'moderator', 'participant'],
      default: 'participant',
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const roomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    hostId: {
      type: String,
      required: true,
    },
    videoId: {
      type: String,
      default: null,
    },
    playState: {
      type: String,
      enum: ['PLAYING', 'PAUSED'],
      default: 'PAUSED',
    },
    currentTime: {
      type: Number,
      default: 0,
      min: 0,
    },
    participants: [participantSchema],
  },
  {
    timestamps: true,
  },
);

roomSchema.index({ 'participants.userId': 1 });

module.exports = mongoose.model('Room', roomSchema);
