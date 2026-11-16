import { MongoClient, Db, Collection } from 'mongodb';
import { env } from '../config/env.js';

export interface ProfileDocument {
  _id?: any;
  userId: string;
  username: string;
  name: string | null;
  dateOfBirth: Date | null;
  bio: string | null;
  profilePicUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(url: string = env.MONGO_URL): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) {
    return { client, db };
  }

  client = new MongoClient(url, {
    maxPoolSize: 20,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  db = client.db();

  await initMongoIndexes(db);

  return { client, db };
}

export async function initMongoIndexes(database: Db): Promise<void> {
  const profiles = database.collection<ProfileDocument>('profiles');

  await profiles.createIndex({ userId: 1 }, { unique: true, name: 'idx_profiles_userId_unique' });
  await profiles.createIndex({ username: 1 }, { unique: true, name: 'idx_profiles_username_unique' });
  // TODO: Add text index on name for user search when search module is implemented
}

export function getDb(): Db {
  if (!db) {
    throw new Error('MongoDB not initialized. Call connectMongo() first.');
  }
  return db;
}

export function getProfilesCollection(): Collection<ProfileDocument> {
  return getDb().collection<ProfileDocument>('profiles');
}

export async function isMongoHealthy(): Promise<boolean> {
  try {
    if (!db) return false;
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
