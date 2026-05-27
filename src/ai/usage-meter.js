'use strict';

/**
 * Tiny zero-dependency cloud usage meter.
 * Purpose: make free-tier/provider fallback safer for normal users.
 * It does not bypass provider limits. It only stops ReplyWise from calling
 * cloud providers after the user's own daily cap is reached.
 */

const fs = require('fs');
const path = require('path');

function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

function usageFile() {
  return path.resolve(process.env.AI_USAGE_FILE || path.join(dataDir(), 'ai-usage.json'));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readUsage() {
  const file = usageFile();
  try {
    if (!fs.existsSync(file)) return { days: {} };
    return JSON.parse(fs.readFileSync(file, 'utf8')) || { days: {} };
  } catch {
    return { days: {} };
  }
}

function writeUsage(usage) {
  const file = usageFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(usage, null, 2));
}

function getToday(usage = readUsage()) {
  const key = todayKey();
  usage.days = usage.days || {};
  usage.days[key] = usage.days[key] || { totalCloudCalls: 0, providers: {}, failures: 0 };
  return usage.days[key];
}

function maxCloudCallsPerDay() {
  return Number(process.env.MAX_CLOUD_CALLS_PER_DAY || 80);
}

function canUseCloud(provider) {
  if (String(provider || '').toLowerCase() === 'local') return { allowed: true };
  const usage = readUsage();
  const day = getToday(usage);
  const max = maxCloudCallsPerDay();
  if (max <= 0) return { allowed: false, reason: 'cloud disabled by MAX_CLOUD_CALLS_PER_DAY=0', used: day.totalCloudCalls, max };
  if (day.totalCloudCalls >= max) {
    return { allowed: false, reason: `daily cloud cap reached (${day.totalCloudCalls}/${max})`, used: day.totalCloudCalls, max };
  }
  return { allowed: true, used: day.totalCloudCalls, max };
}

function recordCloudCall(provider, status = 'ok') {
  if (String(provider || '').toLowerCase() === 'local') return getUsageSummary();
  const usage = readUsage();
  const day = getToday(usage);
  day.totalCloudCalls += 1;
  day.providers[provider] = day.providers[provider] || { calls: 0, failures: 0 };
  day.providers[provider].calls += 1;
  if (status !== 'ok') {
    day.failures += 1;
    day.providers[provider].failures += 1;
  }
  writeUsage(usage);
  return getUsageSummary();
}

function getUsageSummary() {
  const usage = readUsage();
  const day = getToday(usage);
  return {
    date: todayKey(),
    totalCloudCalls: day.totalCloudCalls || 0,
    maxCloudCallsPerDay: maxCloudCallsPerDay(),
    providers: day.providers || {},
    failures: day.failures || 0,
  };
}

module.exports = { canUseCloud, recordCloudCall, getUsageSummary, readUsage };
