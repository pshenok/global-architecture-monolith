/**
 * The API's local HTTPS certificate in .certs/ (git-ignored): mkcert when installed
 * (trusted by browsers), otherwise a self-signed ECDSA certificate via openssl (clients
 * must trust .certs/dev-cert.pem or skip verification).
 *
 * An existing certificate is kept unless it expires within 30 days; works with OpenSSL 3+
 * and the LibreSSL that ships with macOS.
 * Everything it writes is readable by this user only (.certs/ 0700, files 0600): LibreSSL
 * would otherwise write private keys, the CA's included, world-readable.
 *   pnpm certs [--force]
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const dir = join(ROOT, '.certs');
const force = process.argv.includes('--force');
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;
// Inherited by openssl and mkcert, so no key is ever world-readable, not even briefly.
process.umask(0o077);
mkdirSync(dir, { recursive: true });
chmodSync(dir, 0o700);
/** Tightens keys written before this script set its umask (e.g. by LibreSSL). */
const ownerOnly = (...files: string[]) => {
  for (const file of files) if (existsSync(file)) chmodSync(file, 0o600);
};
/**
 * Removes files about to be regenerated: openssl and mkcert rewrite an existing file in
 * place and keep its old mode, so only a new file gets the 077 umask.
 */
const replacing = (...files: string[]) => {
  for (const file of files) rmSync(file, { force: true });
};

const has = (command: string) => {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'inherit' });

// A named-curve P-256 parameter file: `-newkey ec -pkeyopt ec_paramgen_curve:...` makes
// LibreSSL write explicit curve parameters, which Node's OpenSSL refuses.
const work = mkdtempSync(join(tmpdir(), 'gam-certs-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const curveParams = join(work, 'p256.pem');
openssl('ecparam', '-name', 'prime256v1', '-out', curveParams);
const newKey = ['-newkey', `ec:${curveParams}`, '-nodes', '-sha256'];

const expiresSoon = (file: string) =>
  Date.parse(new X509Certificate(readFileSync(file)).validTo) - Date.now() < RENEW_BEFORE_MS;

function httpsCertificate(): void {
  const cert = join(dir, 'dev-cert.pem');
  const key = join(dir, 'dev-key.pem');
  if (existsSync(cert) && existsSync(key) && !force) {
    ownerOnly(key);
    if (!expiresSoon(cert)) {
      console.log(`certificate exists: ${cert} (use --force to regenerate)`);
      return;
    }
    console.log(`${cert} expires within 30 days: regenerating it`);
  }
  replacing(cert, key);
  if (has('mkcert')) {
    execFileSync(
      'mkcert',
      ['-cert-file', cert, '-key-file', key, 'localhost', '127.0.0.1', '::1'],
      {
        stdio: 'inherit',
      },
    );
  } else {
    openssl(
      'req',
      '-x509',
      ...newKey,
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '397',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '-addext',
      'extendedKeyUsage=serverAuth',
    );
    console.log('self-signed certificate created (install mkcert for a browser-trusted one)');
  }
  console.log(`cert: ${cert}\nkey:  ${key}`);
}

httpsCertificate();
