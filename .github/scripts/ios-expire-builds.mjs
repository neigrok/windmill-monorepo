import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'works.windmill.app';
const RESOURCE_ID = /^[A-Za-z0-9-]{1,100}$/;

export function validateInputs(maxBuild, confirmation) {
  if (!['1', '2', '3', '4', '5'].includes(maxBuild)) {
    throw new Error('max_build must be an integer from 1 to 5; builds 6 and later are protected.');
  }
  if (confirmation !== `EXPIRE ${BUNDLE_ID} builds 1-${maxBuild}`) {
    throw new Error(`confirm must be exactly: EXPIRE ${BUNDLE_ID} builds 1-${maxBuild}`);
  }
  return Number(maxBuild);
}

export function createToken({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (typeof keyId !== 'string' || !keyId || /[^A-Za-z0-9]/.test(keyId) ||
      typeof issuerId !== 'string' || !issuerId || /[^A-Za-z0-9-]/.test(issuerId)) {
    throw new Error('ASC_KEY_ID and ASC_ISSUER_ID are required and must be valid identifiers.');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('JWT issuance time must be a nonnegative integer.');
  }
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new Error('The App Store Connect key is not a valid private key.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The App Store Connect key must be an EC P-256 private key.');
  }
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = { iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' };
  const payload = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' });
  return `${payload}.${signature.toString('base64url')}`;
}

function apiUrl(pathOrUrl) {
  let url;
  try {
    if (typeof pathOrUrl !== 'string') throw new Error();
    url = new URL(pathOrUrl, API_ORIGIN);
  } catch {
    throw new Error('Invalid App Store Connect URL.');
  }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash ||
      !/^\/v1\/(apps|builds)(\/[A-Za-z0-9-]+)?$/.test(url.pathname)) {
    throw new Error('Refusing an unexpected App Store Connect origin or path.');
  }
  return url;
}

export async function requestApi(method, pathOrUrl, body, token, fetchImpl = fetch) {
  const url = apiUrl(pathOrUrl);
  if ((method !== 'GET' && method !== 'PATCH') ||
      (method === 'PATCH' && !/^\/v1\/builds\/[A-Za-z0-9-]+$/.test(url.pathname))) {
    throw new Error('Refusing an unexpected App Store Connect operation.');
  }
  if (typeof token !== 'string' || !token) throw new Error('An App Store Connect JWT is required.');
  let response;
  try {
    response = await fetchImpl(url.href, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`App Store Connect ${method} ${url.pathname} failed or timed out.`);
  }
  if (!response.ok) {
    throw new Error(`App Store Connect ${method} ${url.pathname} returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`App Store Connect ${method} ${url.pathname} returned invalid or incomplete JSON.`);
  }
}

async function listPages(request, path) {
  const pathname = apiUrl(path).pathname;
  const visited = new Set();
  const data = [];
  const included = [];
  let expectedTotal;
  let next = path;
  while (next !== null) {
    const url = apiUrl(next);
    if (url.pathname !== pathname || visited.has(url.href)) {
      throw new Error('App Store Connect pagination changed its path or repeated a page.');
    }
    visited.add(url.href);
    const page = await request('GET', next);
    const total = page?.meta?.paging?.total;
    if (!Array.isArray(page?.data) || !Number.isSafeInteger(total) || total < 0 ||
        (expectedTotal !== undefined && total !== expectedTotal) ||
        (page.included !== undefined && !Array.isArray(page.included))) {
      throw new Error('Invalid or changing App Store Connect inventory page.');
    }
    expectedTotal = total;
    data.push(...page.data);
    included.push(...(page.included ?? []));
    next = page.links?.next ?? null;
    if ((next !== null && (typeof next !== 'string' || !next || !page.data.length || data.length >= total)) ||
        data.length > total || (next === null && data.length !== total)) {
      throw new Error('App Store Connect pagination is incomplete or inconsistent.');
    }
  }
  return { data, included };
}

function validResource(resource, type) {
  return resource?.type === type && typeof resource.id === 'string' &&
    resource.id.trim() === resource.id && RESOURCE_ID.test(resource.id);
}

function validApp(app, id = app?.id) {
  return validResource(app, 'apps') && app.id === id && app.attributes?.bundleId === BUNDLE_ID;
}

async function inventory(request, appId) {
  const query = new URLSearchParams({
    'filter[app]': appId,
    include: 'app,preReleaseVersion',
    'fields[builds]': 'version,expired,app,preReleaseVersion',
    'fields[apps]': 'bundleId',
    'fields[preReleaseVersions]': 'version,platform',
    limit: '200',
  });
  const { data, included } = await listPages(request, `/v1/builds?${query}`);
  const releases = new Map();
  for (const resource of included) {
    if (resource?.type === 'apps') {
      if (!validApp(resource, appId)) throw new Error('Included app does not match the authorized app.');
      continue;
    }
    const version = resource?.attributes?.version;
    const platform = resource?.attributes?.platform;
    if (!validResource(resource, 'preReleaseVersions') || platform !== 'IOS' ||
        typeof version !== 'string' || !version.length || version.length > 100 ||
        version.trim() !== version || /[\u0000-\u001f\u007f]/.test(version)) {
      throw new Error('A build has invalid marketing-version or iOS-platform metadata.');
    }
    const previous = releases.get(resource.id);
    if (previous && (previous.version !== version || previous.platform !== platform)) {
      throw new Error('Conflicting pre-release version metadata.');
    }
    releases.set(resource.id, { version, platform });
  }

  const ids = new Set();
  const versionBuilds = new Set();
  const builds = data.map(build => {
    const number = build?.attributes?.version;
    const buildNumber = typeof number === 'string' ? Number(number) : NaN;
    const expired = build?.attributes?.expired;
    const app = build?.relationships?.app?.data;
    const release = build?.relationships?.preReleaseVersion?.data;
    if (!validResource(build, 'builds') || ids.has(build.id) ||
        !Number.isSafeInteger(buildNumber) || buildNumber < 1 || String(buildNumber) !== number ||
        typeof expired !== 'boolean' || !validResource(app, 'apps') || app.id !== appId ||
        !validResource(release, 'preReleaseVersions') || !releases.has(release.id)) {
      throw new Error('A build has an invalid identity, number, expiration flag, or app/version association.');
    }
    const { version, platform } = releases.get(release.id);
    const pair = JSON.stringify([version, number]);
    if (versionBuilds.has(pair)) throw new Error('Duplicate marketing-version/build-number pair.');
    ids.add(build.id);
    versionBuilds.add(pair);
    return { id: build.id, version, buildNumber, expired, releaseId: release.id, platform };
  });
  return builds.sort((a, b) => a.buildNumber - b.buildNumber || a.version.localeCompare(b.version));
}

function printTable(log, title, builds, limit) {
  log(title);
  log('id\tversion\tbuild\texpired\taction');
  for (const build of builds) {
    const action = build.buildNumber > limit ? 'keep' : build.expired ? 'already expired' : 'expire';
    log(`${build.id}\t${build.version}\t${build.buildNumber}\t${build.expired}\t${action}`);
  }
  if (!builds.length) log('(no builds)');
}

export async function expireBuilds({ maxBuild, confirmation, request, log = console.log }) {
  const limit = validateInputs(maxBuild, confirmation);
  const query = new URLSearchParams({ 'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'bundleId', limit: '200' });
  const apps = await listPages(request, `/v1/apps?${query}`);
  if (apps.data.length !== 1 || !validApp(apps.data[0])) {
    throw new Error('Expected exactly one app with bundle ID works.windmill.app.');
  }
  const appId = apps.data[0].id;
  const before = await inventory(request, appId);
  printTable(log, 'Before expiration', before, limit);
  if (!before.length) throw new Error('The authorized app has no builds; refusing an unexpected empty inventory.');
  if (before.some(build => build.buildNumber > limit && build.expired)) {
    throw new Error('A protected build is already expired; refusing to change any builds.');
  }
  const planned = before.filter(build => build.buildNumber <= limit && !build.expired);
  log(`Preflight passed: ${planned.length} build(s) selected for expiration.`);

  let patchFailed = false;
  for (const build of planned) {
    try {
      const response = await request('PATCH', `/v1/builds/${build.id}`, {
        data: { type: 'builds', id: build.id, attributes: { expired: true } },
      });
      if (!validResource(response?.data, 'builds') || response.data.id !== build.id ||
          response.data.attributes?.expired !== true) {
        throw new Error('Invalid expiration response.');
      }
      log(`Expired build ${build.buildNumber} (${build.id}).`);
    } catch {
      patchFailed = true;
      log(`PATCH failed for build ${build.buildNumber} (${build.id}); stopping writes and checking the final inventory.`);
      break;
    }
  }

  let after;
  try {
    after = await inventory(request, appId);
    printTable(log, 'After expiration', after, limit);
  } catch {
    throw new Error('Final inventory could not be verified; inspect App Store Connect before any further action.');
  }
  const finalById = new Map(after.map(build => [build.id, build]));
  if (before.length !== after.length || before.some(build => {
    const final = finalById.get(build.id);
    return !final || final.version !== build.version || final.buildNumber !== build.buildNumber ||
      final.releaseId !== build.releaseId || final.platform !== build.platform;
  })) {
    throw new Error('Postflight failed: the build inventory or immutable metadata changed during expiration.');
  }
  if (before.some(build => finalById.get(build.id).expired !== (build.expired || build.buildNumber <= limit))) {
    throw new Error('Postflight failed: expiration flags do not match the approved plan; see the final inventory.');
  }
  if (patchFailed) throw new Error('Expiration stopped after a PATCH failure; the final inventory shows the observed outcome.');
  log(`Verified ${planned.length} expiration(s); all builds above ${limit} remain unexpired.`);
  return after;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateInputs(process.env.MAX_BUILD, process.env.CONFIRM);
    if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required.');
    const privateKey = await readFile(join(process.env.RUNNER_TEMP, 'AuthKey.p8'), 'utf8');
    const token = createToken({ keyId: process.env.ASC_KEY_ID, issuerId: process.env.ASC_ISSUER_ID, privateKey });
    console.log(`::add-mask::${token}`);
    await expireBuilds({
      maxBuild: process.env.MAX_BUILD,
      confirmation: process.env.CONFIRM,
      request: (method, path, body) => requestApi(method, path, body, token),
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
