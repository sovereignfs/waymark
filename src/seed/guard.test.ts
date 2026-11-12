import { describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../db/config';
import { type SeedTarget, developmentProblems } from './guard';

/** The seed runs only where everything it would touch is on this machine (task 16.1). */
const file: DatabaseConfig = {
  dialect: 'sqlite',
  form: 'file',
  path: '/Users/dev/waymark/waymark.db',
  authPath: '/Users/dev/waymark/waymark_auth.db',
};
const sqld = (host: string): DatabaseConfig => ({
  dialect: 'sqlite',
  form: 'sqld',
  url: `http://${host}:8080`,
  adminUrl: `http://${host}:8081`,
});
const postgres = (host: string): DatabaseConfig => ({
  dialect: 'postgres',
  url: `postgres://user:secret-password@${host}:5432/waymark`,
  poolMax: 10,
});
const target = (over: Partial<SeedTarget> = {}): SeedTarget => ({
  nodeEnv: 'development',
  url: 'http://localhost:3005',
  database: file,
  dataDir: '/Users/dev/waymark/data',
  ...over,
});

describe('a development database', () => {
  it('is a file, or a service on this machine, with an address on this machine', () => {
    expect(developmentProblems(target())).toEqual([]);
    expect(developmentProblems(target({ database: sqld('localhost') }))).toEqual([]);
    expect(developmentProblems(target({ database: sqld('127.0.0.1') }))).toEqual([]);
    expect(developmentProblems(target({ database: postgres('localhost') }))).toEqual([]);
    expect(developmentProblems(target({ database: postgres('db.localhost') }))).toEqual([]);
    expect(developmentProblems(target({ database: postgres('host.docker.internal') }))).toEqual([]);
    expect(developmentProblems(target({ url: undefined, nodeEnv: undefined }))).toEqual([]);
  });

  it('is not one in production, or on another host, or with a public address, or in /data', () => {
    expect(developmentProblems(target({ nodeEnv: 'production' })).join()).toContain('production');
    expect(developmentProblems(target({ database: sqld('sqld.internal.example') })).length).toBe(2);
    expect(developmentProblems(target({ database: postgres('db.example.com') })).join()).toContain(
      'WAYMARK_POSTGRES_URL',
    );
    expect(developmentProblems(target({ url: 'https://waymark.example.com' })).join()).toContain(
      'WAYMARK_URL',
    );
    expect(developmentProblems(target({ dataDir: '/data' })).join()).toContain('WAYMARK_DATA_DIR');
    expect(
      developmentProblems(target({ database: { ...file, path: '/data/waymark.db' } })).join(),
    ).toContain('/data');
  });

  it('says what is wrong without saying the database’s address or its password', () => {
    const said = developmentProblems(
      target({ database: postgres('db.example.com'), url: 'https://waymark.example.com' }),
    ).join('\n');
    expect(said).not.toContain('secret-password');
    expect(said).not.toContain('db.example.com');
    expect(said).not.toContain('waymark.example.com');
  });
});
