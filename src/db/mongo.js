const { MongoClient } = require('mongodb');
const config = require('../config/env');

let client;
let db;

async function connectMongo() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  db = client.db(config.mongo.dbName);
  return db;
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB not connected. Call connectMongo() during startup first.');
  }
  return db;
}

async function closeMongo() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}

async function checkConnection() {
  await getDb().command({ ping: 1 });
}

module.exports = { connectMongo, getDb, closeMongo, checkConnection };
