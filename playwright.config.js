import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:3137';
process.env.KIOSK_BROWSER_ADMIN_PASSWORD ||= randomBytes(24).toString('hex');
const chromium = { browserName: 'chromium', channel: process.env.KIOSK_PLAYWRIGHT_CHANNEL };

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser.spec.js', 'kiosk.spec.js'],
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { baseURL: origin, trace: 'retain-on-failure' },
  globalSetup: './tests/browser-server.mjs',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chromium } },
    { name: 'android', use: { ...devices['Pixel 7'], ...chromium } },
    { name: 'iphone-layout', use: { ...devices['iPhone 14'], ...chromium } },
    ...(process.env.KIOSK_TEST_WEBKIT === '1'
      ? [{ name: 'iphone-webkit', use: { ...devices['iPhone 14'], browserName: 'webkit' } }]
      : []),
  ],
});

