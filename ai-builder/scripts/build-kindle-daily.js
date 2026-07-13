#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const builderRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(builderRoot, '..');
const sourcePath = path.join(builderRoot, 'kindle-digest.json');
const dataDir = path.join(projectRoot, 'data');
const archiveDir = path.join(dataDir, 'archive');
const dailyPath = path.join(dataDir, 'daily.json');
const indexPath = path.join(dataDir, 'dailies-index.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeItem(item, sectionIndex, itemIndex) {
  const field = `sections[${sectionIndex}].items[${itemIndex}]`;
  const sourceUrl = requireText(item.sourceUrl, `${field}.sourceUrl`);
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`${field}.sourceUrl must be an http(s) URL`);
  }

  return {
    title: requireText(item.title, `${field}.title`),
    summary: requireText(item.summary, `${field}.summary`),
    sourceUrl,
    sourceName: requireText(item.sourceName, `${field}.sourceName`),
    permalink: item.permalink || sourceUrl,
    attribution: item.attribution || {
      source: 'Follow Builders',
      canonical: sourceUrl
    }
  };
}

function buildDaily(source) {
  const date = requireText(source.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must use YYYY-MM-DD format');
  }
  if (!Array.isArray(source.sections) || !source.sections.length) {
    throw new Error('sections must contain at least one section');
  }

  const sections = source.sections.map((section, sectionIndex) => {
    if (!Array.isArray(section.items) || !section.items.length) {
      throw new Error(`sections[${sectionIndex}].items must not be empty`);
    }
    return {
      label: requireText(section.label, `sections[${sectionIndex}].label`),
      items: section.items.map((item, itemIndex) => normalizeItem(item, sectionIndex, itemIndex))
    };
  });

  return {
    date,
    generatedAt: source.generatedAt || new Date().toISOString(),
    attribution: source.attribution || {
      source: 'Follow Builders',
      canonical: 'https://github.com/zarazhangrui/follow-builders'
    },
    sections,
    flashes: Array.isArray(source.flashes) ? source.flashes : []
  };
}

function updateIndex(daily) {
  let index = { count: 0, items: [] };
  if (fs.existsSync(indexPath)) {
    index = readJson(indexPath);
  }

  const firstItem = daily.sections[0].items[0];
  const entry = {
    date: daily.date,
    attribution: daily.attribution,
    generatedAt: daily.generatedAt,
    leadTitle: firstItem.title,
    leadParagraph: firstItem.summary
  };
  const items = [entry]
    .concat((Array.isArray(index.items) ? index.items : []).filter((item) => item.date !== daily.date))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);

  fs.writeFileSync(indexPath, `${JSON.stringify({ count: items.length, items }, null, 2)}\n`, 'utf8');
}

const daily = buildDaily(readJson(sourcePath));
fs.mkdirSync(archiveDir, { recursive: true });
const output = `${JSON.stringify(daily, null, 2)}\n`;
fs.writeFileSync(dailyPath, output, 'utf8');
fs.writeFileSync(path.join(archiveDir, `${daily.date}.json`), output, 'utf8');
updateIndex(daily);

console.log(`Built ${daily.date}: ${daily.sections.reduce((sum, section) => sum + section.items.length, 0)} items`);
