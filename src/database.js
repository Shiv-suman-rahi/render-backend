const mongoose = require('mongoose');
const { connectDB } = require('./config/db');
require('./models/User');
require('./models/Room');

async function connectToMongo() {
  await connectDB();
  return mongoose.connection.db.collection('rooms');
}

async function closeMongoConnection() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
}

module.exports = { connectToMongo, closeMongoConnection };