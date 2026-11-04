import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mode = process.argv[2] ?? 'check';
const reviewDate = new Date().toISOString().slice(0, 10);
const root = process.cwd();
const hash = value => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const inventoryPath = 'docs/dependencies/inventory.json';
const allowed = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'BSL-1.0', 'Python-2.0']);
const licenseName = name => /^(licen[cs]e|copying|notice|third[-_ ]?party)([._ -]|$)/i.test(name);
function validateLicense(expression, identity) {
  if (typeof expression !== 'string') throw new Error(`Unknown license: ${identity}`);
  const branches = expression.replace(/[()]/g, '').split(/\s+OR\s+/);
  const branch = branches.find(b => b.split(/\s+AND\s+/).every(id => allowed.has(id.trim())));
  if (!branch) throw new Error(`Unapproved license ${expression}: ${identity}`);
  return branch.trim();
}
function inspectFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).filter(x => x.isFile());
  const files = entries.filter(x => licenseName(x.name)).map(x => ({ name: x.name, content: readFileSync(join(directory, x.name), 'utf8') }));
  if (!files.length) for (const entry of entries.filter(x => /^readme/i.test(x.name))) {
    const content = readFileSync(join(directory, entry.name), 'utf8');
    if (/permission is hereby granted|redistribution and use in source/i.test(content)) files.push({ name: entry.name, content });
  }
  return files;
}
function supplement(manifest, files) {
  if (files.length) return files;
  if (manifest.name.startsWith('@rollup/')) {
    const parent = JSON.parse(readFileSync('node_modules/rollup/package.json', 'utf8'));
    if (parent.version === manifest.version) return inspectFiles('node_modules/rollup').map(f => ({ name: 'shared-release:rollup@' + parent.version + '/' + f.name, content: f.content }));
  }
  if (manifest.name.startsWith('@napi-rs/lzma-') && existsSync('node_modules/@napi-rs/lzma/package.json')) {
    const parent = JSON.parse(readFileSync('node_modules/@napi-rs/lzma/package.json', 'utf8'));
    if (parent.version === manifest.version) return inspectFiles('node_modules/@napi-rs/lzma').map(f => ({ name: 'shared-release:@napi-rs/lzma@' + parent.version + '/' + f.name, content: f.content }));
  }
  const index = JSON.parse(readFileSync('docs/dependencies/upstream-licenses/index.json', 'utf8'));
  const entry = index.records.find(p => p.name === manifest.name && p.version === manifest.version && p.license === manifest.license);
  if (!entry) return files;
  const content = readFileSync(entry.file, 'utf8');
  if (hash(content) !== entry.sha256) throw new Error('Changed upstream license evidence: ' + manifest.name);
  return [{ name: 'upstream:' + entry.source, content }];
}
async function artifactFiles(info, name) {
  if (!info.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error(`Unapproved artifact origin: ${name}`);
  const response = await fetch(info.resolved, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Cannot inspect ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = info.integrity?.split(' ').find(v => v.startsWith('sha512-') || v.startsWith('sha1-'));
  if (!integrity) throw new Error(`No artifact integrity: ${name}`);
  const split = integrity.indexOf('-');
  if (createHash(integrity.slice(0, split)).update(bytes).digest('base64') !== integrity.slice(split + 1)) throw new Error(`Integrity mismatch: ${name}`);
  const archive = join(tmpdir(), `nexrun-license-${hash(info.resolved)}.tgz`); writeFileSync(archive, bytes);
  const names = execFileSync('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024 }).toString().split('\n');
  const files = names.filter(p => /^package\/[^/]+$/.test(p) && licenseName(p.slice(8))).map(p => ({ name: p.slice(8), content: execFileSync('tar', ['-xOzf', archive, p], { maxBuffer: 16 * 1024 * 1024 }).toString() }));
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { maxBuffer: 4 * 1024 * 1024 }).toString());
  return { manifest, files };
}
function fingerprints(files) { return files.map(f => ({ path: f.name, sha256: hash(f.content) })).sort((a, b) => a.path.localeCompare(b.path)); }
const entries = Object.entries(lock.packages).filter(([p, x]) => p.includes('node_modules/') && !x.link);
const previous = existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : null;
const checked = [];
let notices = '# NexRun third-party notices\n\nGenerated from the exact locked artifacts. Preserve this file with distributed bundles.\n\n';
const failures = [];
async function inspect([path, info]) {
  const installed = existsSync(join(root, path, 'package.json'));
  const name = path.split('node_modules/').at(-1);
  let manifest, files;
  if (installed) { manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')); files = inspectFiles(path); }
  else if (mode === 'review') { ({ manifest, files } = await artifactFiles(info, name)); }
  else {
    const approved = previous?.packages.find(p => p.path === path);
    if (!approved || approved.version !== info.version || approved.integrity !== info.integrity || !approved.evidence.length) throw new Error(`Unreviewed locked artifact ${path}@${info.version}`);
    checked.push(approved); return;
  }
  if (manifest.version !== info.version) throw new Error(`Installed version differs from lock: ${path}`);
  const selectedLicense = validateLicense(manifest.license, `${name}@${info.version}`);

  files = supplement(manifest, files);
  if (!files.length) throw new Error(`No applicable upstream evidence: ${name}@${info.version}`);
  const evidence = fingerprints(files);
  const record = { path, name: manifest.name ?? name, version: info.version, declaredLicense: manifest.license, selectedLicense, source: info.resolved, integrity: info.integrity, evidence, usage: 'Application, build or test dependency; see lockfile dev/optional flags', reviewedAt: mode === 'review' ? reviewDate : previous?.packages.find(p => p.path === path)?.reviewedAt ?? reviewDate };
  if (mode !== 'review') {
    const approved = previous?.packages.find(p => p.path === path);
    if (!approved || JSON.stringify({ ...approved, usage: record.usage }) !== JSON.stringify(record)) throw new Error(`Unreviewed or changed dependency evidence: ${name}@${info.version}`);
  }
  for (const f of files) notices += `## ${name}@${info.version} — ${f.name}\n\n${f.content}\n\n`;
  checked.push(record);
}
if (mode !== 'review' && (!previous || previous.lockfileSha256 !== hash(readFileSync('package-lock.json')))) throw new Error('Dependency lock changed. Inspect actual artifacts and run licenses:review before committing the reviewed inventory.');
const queue = [...entries];
await Promise.all(Array.from({ length: mode === 'review' ? 5 : 1 }, async () => {
  while (queue.length) { const entry = queue.shift(); try { await inspect(entry); } catch (e) { failures.push(e.message); } }
}));
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else {
  checked.sort((a, b) => a.path.localeCompare(b.path));
  if (mode === 'review') {
    mkdirSync('docs/dependencies', { recursive: true });
    const shadcn = JSON.parse(readFileSync('docs/dependencies/shadcn-sources.json', 'utf8'));
    writeFileSync(inventoryPath, JSON.stringify({ schemaVersion: 1, reviewedAt: reviewDate, lockfileSha256: hash(readFileSync('package-lock.json')), packages: checked }, null, 2) + '\n');
    notices += '\n## shadcn/ui copied components\n\n' + readFileSync('vendor/shadcn/LICENSE', 'utf8');
    for (const r of shadcn.components) notices += `\n${r.path}\nSource: ${r.source}\nChanges: ${r.modifications}\n`;
    writeFileSync('THIRD_PARTY_NOTICES.txt', notices);
    const unique = [...new Map(checked.map(p => [`${p.name}@${p.version}`, p])).values()];
    writeFileSync('docs/dependencies/sbom.cdx.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: 'nexrun', version: '0.1.0', licenses: [{ license: { id: 'Apache-2.0' } }] } }, components: unique.map(p => ({ type: 'library', name: p.name, version: p.version, 'bom-ref': `${p.name}@${p.version}`, licenses: [{ expression: p.declaredLicense }], externalReferences: [{ type: 'distribution', url: p.source }] })) }, null, 2) + '\n');
    console.log(`Recorded ${checked.length} locked artifacts and their actual license/notice evidence. Review inventory and notices before committing.`);
  } else {
    const shadcn = JSON.parse(readFileSync('docs/dependencies/shadcn-sources.json', 'utf8'));
    for (const entry of shadcn.components) if (hash(readFileSync(entry.path)) !== entry.installedSha256) throw new Error(`Changed copied source: ${entry.path}; review and update its evidence.`);
    if (!existsSync('THIRD_PARTY_NOTICES.txt') || !existsSync('docs/dependencies/sbom.cdx.json')) throw new Error('Missing release license artifacts');
    console.log(`License gate passed for ${checked.length} exact locked artifacts and reviewed shadcn sources.`);
  }
}
