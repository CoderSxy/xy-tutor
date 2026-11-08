import { describe,it,expect } from 'vitest';
import { loadConfig } from '../../apps/server/src/config.js';
describe('configuration',()=>{
  it('rejects incomplete production configuration',()=>expect(()=>loadConfig({NODE_ENV:'production'})).toThrow('Invalid configuration'));
  it('rejects invalid ports without exposing credentials',()=>expect(()=>loadConfig({NODE_ENV:'test',PORT:'bad',DATABASE_URL:'secret-value'})).toThrow('Invalid configuration'));
  it('defaults to a loopback development listener',()=>expect(loadConfig({NODE_ENV:'test'}).host).toBe('127.0.0.1'));
});
