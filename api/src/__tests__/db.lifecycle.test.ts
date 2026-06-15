/**
 * Lifecycle tests for the Mongo connection helpers (connectDb / disconnectDb)
 * and the pingDb health helper, against an in-memory MongoDB.
 *
 * Env must be set BEFORE the first import that reads it, so MONGO_URI points at
 * the in-memory server and LOG_LEVEL quiets the connection chatter.
 */
import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { connectDb, disconnectDb } = await import('../shared/config/db.js');
const { pingDb } = await import('../shared/utils/healthChecks.js');

afterAll(async () => {
  // Ensure we leave nothing connected, then stop the server.
  if (mongoose.connection.readyState !== 0) await disconnectDb();
  await mongod.stop();
});

describe('db lifecycle', () => {
  it('connectDb establishes a live connection that pingDb confirms', async () => {
    await connectDb();
    expect(mongoose.connection.readyState).toBe(1); // 1 = connected
    expect(await pingDb()).toBe(true);
  });

  it('disconnectDb tears the connection down cleanly', async () => {
    await disconnectDb();
    expect(mongoose.connection.readyState).toBe(0); // 0 = disconnected
    expect(await pingDb()).toBe(false);
  });
});
