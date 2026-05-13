#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { inflateRawSync, deflateRawSync } from 'zlib';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--input') args.input = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--ops') args.ops = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.input) throw new Error('Missing required --input');
  if (!args.ops) throw new Error('Missing required --ops');
  if (!args.dryRun && !args.output) throw new Error('Missing required --output (source file will never be overwritten)');
  return args;
}

function readZip(buf) {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const files = new Map();
  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP: bad CD entry');
    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);
    files.set(name, { compression, compressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...files.keys()],
    extract(name) {
      const entry = files.get(name);
      if (!entry) return null;
      const lhOffset = entry.localHeaderOffset;
      if (buf.readUInt32LE(lhOffset) !== 0x04034b50) throw new Error('Invalid ZIP: bad local header');
      const lhNameLen = buf.readUInt16LE(lhOffset + 26);
      const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
      const dataOffset = lhOffset + 30 + lhNameLen + lhExtraLen;
      const rawData = buf.subarray(dataOffset, dataOffset + entry.compressedSize);
      if (entry.compression === 0) return rawData;
      if (entry.compression === 8) return inflateRawSync(rawData);
      throw new Error(`Unsupported compression method: ${entry.compression}`);
    }
  };
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const entries = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.concat([local, nameBytes, compressed]);
    entries.push(entry);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBytes]));
    offset += entry.length;
  }
  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralDir, eocd]);
}

function collectTopics(node, arr = []) {
  arr.push(node);
  for (const type of Object.keys(node.children || {})) {
    for (const child of node.children[type] || []) collectTopics(child, arr);
  }
  return arr;
}

function findTopicById(sheets, id) {
  for (const sheet of sheets) {
    const all = collectTopics(sheet.rootTopic, []);
    const found = all.find(t => t.id === id);
    if (found) return found;
  }
  return null;
}

function findTopicByPath(sheets, path) {
  const matches = [];
  function walk(node, depth) {
    if ((node.title || '') !== path[depth]) return;
    if (depth === path.length - 1) { matches.push(node); return; }
    for (const type of Object.keys(node.children || {})) {
      for (const child of node.children[type] || []) walk(child, depth + 1);
    }
  }
  for (const sheet of sheets) walk(sheet.rootTopic, 0);
  return matches;
}

function generateTopicId(existing) {
  while (true) {
    const id = randomUUID().replace(/-/g, '').slice(0, 26);
    if (!existing.has(id)) return id;
  }
}

function buildNewTopic(input, existingIds) {
  if (!input || typeof input !== 'object' || typeof input.title !== 'string') throw new Error('Each appended child must be an object with a string title');
  const id = generateTopicId(existingIds);
  existingIds.add(id);
  const topic = { id, title: input.title };
  if (Array.isArray(input.children) && input.children.length > 0) {
    topic.children = { attached: input.children.map(c => buildNewTopic(c, existingIds)) };
  }
  return topic;
}

function resolveTarget(sheets, target) {
  if (!target || typeof target !== 'object') throw new Error('operation.target must be an object');
  if (target.id) {
    const t = findTopicById(sheets, target.id);
    if (!t) throw new Error(`Target topic not found by id: ${target.id}`);
    return t;
  }
  if (Array.isArray(target.path) && target.path.length > 0 && target.path.every(x => typeof x === 'string')) {
    const matches = findTopicByPath(sheets, target.path);
    if (matches.length === 0) throw new Error(`Target topic not found by path: ${target.path.join(' > ')}`);
    if (matches.length > 1) throw new Error(`Path matches multiple topics (${matches.length}). Please use target.id.`);
    return matches[0];
  }
  throw new Error('operation.target must include id or path');
}

function main() {
  const args = parseArgs(process.argv);
  const zip = readZip(readFileSync(args.input));
  const contentBuf = zip.extract('content.json');
  if (!contentBuf) throw new Error('Only modern XMind files with content.json are supported.');

  let sheets;
  try {
    const parsed = JSON.parse(contentBuf.toString('utf-8').replace(/^\uFEFF/, ''));
    sheets = Array.isArray(parsed) ? parsed : parsed?.sheets;
  } catch {
    throw new Error('Only modern XMind files with content.json are supported.');
  }
  if (!Array.isArray(sheets)) throw new Error('Only modern XMind files with content.json are supported.');

  const ops = JSON.parse(readFileSync(args.ops, 'utf-8'));
  if (!Array.isArray(ops)) throw new Error('operations.json must be an array');

  const existingIds = new Set();
  for (const s of sheets) for (const t of collectTopics(s.rootTopic, [])) if (t.id) existingIds.add(t.id);

  const summary = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') throw new Error('Invalid operation object');
    if (op.op === 'rename') {
      if (typeof op.title !== 'string') throw new Error('rename operation requires string title');
      const topic = resolveTarget(sheets, op.target);
      const before = topic.title || '';
      topic.title = op.title;
      summary.push(`rename: ${topic.id} "${before}" -> "${op.title}"`);
    } else if (op.op === 'append_children') {
      if (!Array.isArray(op.children) || op.children.length === 0) throw new Error('append_children requires non-empty children array');
      const topic = resolveTarget(sheets, op.target);
      if (!topic.children || typeof topic.children !== 'object') topic.children = {};
      if (!Array.isArray(topic.children.attached)) topic.children.attached = [];
      const newTopics = op.children.map(c => buildNewTopic(c, existingIds));
      topic.children.attached.push(...newTopics);
      summary.push(`append_children: ${topic.id} appended ${newTopics.length} child(ren)`);
    } else {
      throw new Error(`Unsupported operation: ${op.op}. Only rename and append_children are supported.`);
    }
  }

  if (args.dryRun) {
    console.log('Dry-run summary:');
    for (const line of summary) console.log(`- ${line}`);
    return;
  }

  const files = zip.names().map(name => ({ name, data: zip.extract(name) }));
  const contentIndex = files.findIndex(f => f.name === 'content.json');
  files[contentIndex].data = Buffer.from(JSON.stringify(Array.isArray(JSON.parse(contentBuf.toString('utf-8').replace(/^\uFEFF/, ''))) ? sheets : { sheets }, null, 2));
  writeFileSync(args.output, buildZip(files));
  console.log('Edit summary:');
  for (const line of summary) console.log(`- ${line}`);
  console.log(`outputPath: ${args.output}`);
}

try { main(); }
catch (e) { console.error(e.message); process.exit(1); }
