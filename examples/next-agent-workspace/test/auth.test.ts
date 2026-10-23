import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  SESSION_COOKIE,
  developmentCookieToken,
  isLoopbackHost,
  isSignedIn,
  sessionToken,
} from '../lib/auth.ts';

const environment = process.env as Record<string, string | undefined>;
const originalNodeEnv = environment.NODE_ENV;

const requestWith = (cookie?: string): Request =>
  new Request('http://localhost/api/files/', cookie === undefined ? {} : { headers: { cookie } });

afterEach(() => {
  delete environment.AGENT_WORKSPACE_TOKEN;
  environment.NODE_ENV = originalNodeEnv;
});

describe('isSignedIn', () => {
  it('refuses a request with no cookie', () => {
    assert.equal(isSignedIn(requestWith()), false);
  });

  it('refuses a request with no cookie when AGENT_WORKSPACE_TOKEN is blank', () => {
    environment.AGENT_WORKSPACE_TOKEN = '  ';
    assert.equal(isSignedIn(requestWith()), false);
    assert.equal(isSignedIn(requestWith(`${SESSION_COOKIE}=`)), false);
  });

  it('refuses a wrong token and accepts the right one', () => {
    environment.AGENT_WORKSPACE_TOKEN = 'correct-token';
    assert.equal(isSignedIn(requestWith(`${SESSION_COOKIE}=wrong-token`)), false);
    assert.equal(isSignedIn(requestWith(`${SESSION_COOKIE}=correct-token`)), true);
  });

  it('accepts a token whose cookie value was URL-encoded', () => {
    environment.AGENT_WORKSPACE_TOKEN = 'a+b;c%d';
    assert.equal(isSignedIn(requestWith(`${SESSION_COOKIE}=${encodeURIComponent('a+b;c%d')}`)), true);
  });

  it('refuses a cookie that is not valid URL encoding', () => {
    environment.AGENT_WORKSPACE_TOKEN = 'correct-token';
    assert.equal(isSignedIn(requestWith(`${SESSION_COOKIE}=%E0%A4%A`)), false);
  });
});

describe('developmentCookieToken', () => {
  it('hands out the per-process token in development', () => {
    environment.NODE_ENV = 'development';
    assert.equal(developmentCookieToken(), sessionToken());
  });

  it('hands out nothing in production', () => {
    environment.NODE_ENV = 'production';
    assert.equal(developmentCookieToken(), undefined);
  });

  it('never hands out a configured AGENT_WORKSPACE_TOKEN', () => {
    environment.NODE_ENV = 'development';
    environment.AGENT_WORKSPACE_TOKEN = 'a-real-secret';
    assert.equal(developmentCookieToken(), undefined);
  });
});

describe('isLoopbackHost', () => {
  it('accepts localhost, 127.0.0.1 and [::1] with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1:4310',
      '[::1]',
      '[::1]:3000',
      'LOCALHOST',
    ]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it('refuses a foreign, look-alike or missing Host so no development cookie is handed out', () => {
    for (const host of [
      'evil.example',
      'evil.example:3000',
      '192.168.1.20:3000',
      'localhost.evil.example',
      '[::2]',
      null,
    ]) {
      assert.equal(isLoopbackHost(host), false, String(host));
    }
  });
});
