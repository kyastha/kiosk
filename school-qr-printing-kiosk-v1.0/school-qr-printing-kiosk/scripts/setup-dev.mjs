import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const secret = () => randomBytes(32).toString('base64url');
const values = {
  PUBLIC_ORIGIN: 'http://localhost:3000',
  SCHOOL_NAME: '"School Printing Service"',
  APP_SECRET: secret(),
  AGENT_TOKEN: secret(),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: secret(),
};
try {
  await writeFile('.env', Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log('Created .env with local credentials. Open it privately to read ADMIN_PASSWORD.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists.');
}
