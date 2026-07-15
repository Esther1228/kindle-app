#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, '..', 'kindle-digest.json');
const modelEndpoint = 'https://models.github.ai/inference/chat/completions';
const modelName = process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1-mini';
const githubToken = process.env.GITHUB_TOKEN;

const feedUrls = {
  x: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
  podcasts: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
  blogs: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json'
};

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function cleanText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'kindle-ai-builders-digest/1.0' }
  });
  if (!response.ok) {
    throw new Error(`Feed request failed (${response.status}): ${url}`);
  }
  return response.json();
}

function collectTweets(feed, now) {
  const cutoff = now.getTime() - 36 * 60 * 60 * 1000;
  const primary = [];
  const secondary = [];

  for (const builder of feed?.x || []) {
    const tweets = (builder.tweets || [])
      .filter((tweet) => new Date(tweet.createdAt).getTime() >= cutoff)
      .filter((tweet) => cleanText(tweet.text, 2000).length >= 40)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const substantive = tweets.filter((tweet) => !cleanText(tweet.text, 2000).startsWith('@'));
    const chosen = substantive.length ? substantive : tweets;
    if (!chosen.length) continue;

    primary.push({ builder, tweet: chosen[0] });
    if (chosen[1]) secondary.push({ builder, tweet: chosen[1] });
  }

  return primary.concat(secondary).slice(0, 18).map(({ builder, tweet }, index) => ({
    id: `x-${index + 1}`,
    type: 'x',
    sourceName: `X · ${builder.name} (@${builder.handle})`,
    url: tweet.url,
    publishedAt: tweet.createdAt,
    content: cleanText(tweet.text, 1400)
  }));
}

function collectPodcasts(feed) {
  return (feed?.podcasts || [])
    .filter((episode) => episode.url && episode.transcript)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 1)
    .map((episode, index) => ({
      id: `podcast-${index + 1}`,
      type: 'podcast',
      sourceName: `播客 · ${episode.name}`,
      url: episode.url,
      publishedAt: episode.publishedAt,
      title: cleanText(episode.title, 240),
      content: cleanText(episode.transcript, 12000)
    }));
}

function collectBlogs(feed, now) {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return (feed?.blogs || [])
    .filter((post) => post.url && new Date(post.publishedAt || post.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publishedAt || b.date) - new Date(a.publishedAt || a.date))
    .slice(0, 8)
    .map((post, index) => ({
      id: `blog-${index + 1}`,
      type: 'blog',
      sourceName: `博客 · ${post.name || post.source || 'AI Builder'}`,
      url: post.url,
      publishedAt: post.publishedAt || post.date,
      title: cleanText(post.title, 240),
      content: cleanText(post.description || post.summary || post.content, 2400)
    }));
}

function parseModelJson(content) {
  const text = String(content || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(text);
}

function normalizeDigest(modelOutput, records, date, generatedAt) {
  const sourceById = new Map(records.map((record) => [record.id, record]));
  const usedSources = new Set();
  const sections = [];

  for (const section of modelOutput.sections || []) {
    const items = [];
    for (const item of section.items || []) {
      const source = sourceById.get(item.sourceId);
      if (!source || usedSources.has(source.id)) continue;
      const title = cleanText(item.title, 120);
      const summary = cleanText(item.summary, 900);
      if (!title || !summary) continue;
      usedSources.add(source.id);
      items.push({
        title,
        summary,
        sourceUrl: source.url,
        sourceName: source.sourceName
      });
    }
    if (items.length) {
      sections.push({
        label: cleanText(section.label, 30) || 'AI Builders',
        items: items.slice(0, 6)
      });
    }
  }

  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  if (itemCount < 3) {
    throw new Error(`Model returned too few valid items: ${itemCount}`);
  }

  return {
    date,
    generatedAt,
    attribution: {
      source: 'Follow Builders',
      canonical: 'https://github.com/zarazhangrui/follow-builders'
    },
    sections,
    flashes: []
  };
}

async function callModel(records, date) {
  if (!githubToken) throw new Error('GITHUB_TOKEN is required');

  const systemPrompt = [
    '你是严谨的 AI Builders 中文日报编辑。',
    '只使用用户提供的来源，不补充外部事实，不虚构数字、产品名或链接。',
    '筛选真正有信息量的产品、模型、工程、研究和创业观点，忽略寒暄与纯推广。',
    '标题简洁具体；摘要应说明发生了什么、为什么重要，每项 80 至 220 个中文字符。',
    '输出 JSON，不要输出 Markdown。'
  ].join('');

  const userPrompt = JSON.stringify({
    task: '生成 Kindle AI Builders 日报',
    date,
    outputSchema: {
      sections: [{
        label: '栏目名，例如 Builder 观点、产品与模型、深度播客',
        items: [{ sourceId: '必须原样使用来源 id', title: '中文标题', summary: '中文摘要' }]
      }]
    },
    rules: [
      '输出 2 至 4 个非空栏目，总计 5 至 12 项',
      '同一 sourceId 只能出现一次',
      '优先今天发布且信息密度高的来源',
      '播客内容放入深度播客栏目'
    ],
    sources: records
  });

  const response = await fetch(modelEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.2,
      max_tokens: 5000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub Models request failed (${response.status}): ${responseText.slice(0, 800)}`);
  }
  const payload = JSON.parse(responseText);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('GitHub Models returned no message content');
  return parseModelJson(content);
}

async function main() {
  const now = new Date();
  const date = shanghaiDate(now);
  const generatedAt = now.toISOString();
  const [xFeed, podcastFeed, blogFeed] = await Promise.all([
    fetchJson(feedUrls.x),
    fetchJson(feedUrls.podcasts),
    fetchJson(feedUrls.blogs)
  ]);

  const records = [
    ...collectTweets(xFeed, now),
    ...collectBlogs(blogFeed, now),
    ...collectPodcasts(podcastFeed)
  ];
  if (records.length < 3) throw new Error(`Not enough fresh feed records: ${records.length}`);

  console.log(`Preparing ${date} from ${records.length} sources with ${modelName}`);
  const modelOutput = await callModel(records, date);
  const digest = normalizeDigest(modelOutput, records, date, generatedAt);
  await fs.writeFile(outputPath, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
  console.log(`Generated ${date}: ${digest.sections.reduce((sum, section) => sum + section.items.length, 0)} items`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
