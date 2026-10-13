const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const userSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      unique: true,
      sparse: true,
      default: () => randomUUID(),
    },
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 30,
    },
    email: {
      type: String,
      required() {
        return Boolean(this.passwordHash);
      },
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    passwordHash: {
      type: String,
      required() {
        return Boolean(this.email);
      },
      select: false,
    },
    avatarUrl: {
      type: String,
      default: '',
      maxlength: 2048,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('User', userSchema);
