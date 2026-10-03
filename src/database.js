const { MongoClient } = require('mongodb');

let mongoClient;

async function connectToMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required to start the backend.');
  }

  mongoClient = new MongoClient(uri);
  await mongoClient.connect();

  const database = mongoClient.db(process.env.MONGODB_DB || 'watch_party');
  await database.command({ ping: 1 });
  console.log(`Connected to MongoDB database "${database.databaseName}".`);

  return database.collection('rooms');
}

async function closeMongoConnection() {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
  }
}

module.exports = { connectToMongo, closeMongoConnection };