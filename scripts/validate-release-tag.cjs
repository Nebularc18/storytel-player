const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');
const appVersion = fs.readFileSync(path.join(__dirname, '../src/version.ts'), 'utf8')
  .match(/export const APP_VERSION = "([^"]+)";/)?.[1];
const tag = process.env.RELEASE_TAG || '';
const numeric = '(0|[1-9][0-9]*)';
const validTag = new RegExp(`^v${numeric}\\.${numeric}\\.${numeric}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$`);
if (!validTag.test(tag) || tag !== `v${version}` || appVersion !== version) {
  console.error('Release tag must match package.json and src/version.ts, such as v1.4.2');
  process.exit(1);
}
console.log(`prerelease=${version.includes('-')}`);
