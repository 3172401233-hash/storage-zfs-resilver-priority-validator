'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRound } = require('../src/scheduler');

function baseInput(overrides) {
  const input = {
    pool: { name: 'tank', totalBandwidthMBps: 400, minWriteBandwidthMBps: 80 },
    vdevs: [
      { id: 'vdev-0', faultDomain: 'fd-a', state: 'degraded' },
      { id: 'vdev-1', faultDomain: 'fd-b', state: 'online' },
    ],
    resilvers: [
      {
        vdevId: 'vdev-0',
        totalRegions: 8,
        completedRegions: [0, 1, 2, 3],
        regionSizeMB: 64,
        maxRateMBps: 200,
      },
    ],
    scrub: {
      active: false,
      vdevId: 'vdev-1',
      totalRegions: 8,
      completedRegions: [],
      regionSizeMB: 64,
      maxRateMBps: 150,
    },
    io: { writeDemandMBps: 60, latencyMs: 8 },
    hotness: { 'vdev-0': { 4: 0.9, 5: 0.1, 6: 0.7, 7: 0.3 } },
  };
  return Object.assign(input, overrides);
}

test('vdev 故障: 降级 vdev 触发 resilver，已完成区域不重复扫描', () => {
  const plan = planRound(baseInput());
  const resilver = plan.tasks.find((task) => task.type === 'resilver');
  assert.ok(resilver, '应调度 resilver 任务');
  assert.equal(resilver.vdevId, 'vdev-0');
  for (const region of resilver.regions) {
    assert.ok(![0, 1, 2, 3].includes(region), `已完成区域 ${region} 不应重复扫描`);
  }
  assert.equal(resilver.regions[0], 4, '最热区域优先恢复');
  const vulnerable = plan.vulnerableRanges.find((range) => range.vdevId === 'vdev-0');
  assert.equal(vulnerable.remainingRegions, 4);
  assert.deepEqual(
    vulnerable.ranges.map((range) => range.region).sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
});

test('vdev 故障: 同一故障域不能并发过多恢复任务', () => {
  const input = baseInput({
    vdevs: [
      { id: 'vdev-0', faultDomain: 'fd-a', state: 'degraded' },
      { id: 'vdev-1', faultDomain: 'fd-a', state: 'degraded' },
    ],
    resilvers: [
      { vdevId: 'vdev-0', totalRegions: 8, completedRegions: [], regionSizeMB: 64, maxRateMBps: 200 },
      { vdevId: 'vdev-1', totalRegions: 8, completedRegions: [], regionSizeMB: 64, maxRateMBps: 200 },
    ],
  });
  const plan = planRound(input);
  const active = plan.tasks.filter((task) => task.type === 'resilver');
  const deferred = plan.tasks.filter((task) => task.type === 'deferred-resilver');
  assert.equal(active.length, 1, '同一故障域每轮只允许 1 个恢复任务');
  assert.equal(deferred.length, 1);
  assert.match(deferred[0].reason, /并发恢复任务已达上限/);
});

test('并发 scrub: scrub 不能压制 resilver，只拿剩余带宽', () => {
  const input = baseInput({
    scrub: { active: true, vdevId: 'vdev-1', totalRegions: 8, completedRegions: [0, 1], regionSizeMB: 64, maxRateMBps: 150 },
  });
  const plan = planRound(input);
  const resilver = plan.tasks.find((task) => task.type === 'resilver');
  const scrub = plan.tasks.find((task) => task.type === 'scrub');
  assert.equal(resilver.bandwidthMBps, 200, 'resilver 应拿满请求速率');
  assert.equal(scrub.bandwidthMBps, 400 - 80 - 200, 'scrub 只拿剩余预算');
  assert.ok(
    plan.tasks.indexOf(resilver) < plan.tasks.indexOf(scrub),
    'resilver 排在 scrub 之前',
  );
  for (const region of scrub.regions) {
    assert.ok(![0, 1].includes(region), 'scrub 已完成区域不重复扫描');
  }
});

test('并发 scrub: resilver 吃满预算时 scrub 本轮暂停', () => {
  const input = baseInput({
    pool: { name: 'tank', totalBandwidthMBps: 300, minWriteBandwidthMBps: 80 },
    resilvers: [
      { vdevId: 'vdev-0', totalRegions: 8, completedRegions: [], regionSizeMB: 64, maxRateMBps: 220 },
    ],
    scrub: { active: true, vdevId: 'vdev-1', totalRegions: 8, completedRegions: [], regionSizeMB: 64, maxRateMBps: 150 },
  });
  const plan = planRound(input);
  const scrub = plan.tasks.find((task) => task.type === 'scrub');
  assert.equal(scrub.bandwidthMBps, 0);
  assert.match(scrub.reason, /resilver 优先/);
});

test('带宽不足: 普通写入保留最低带宽并发出警告', () => {
  const input = baseInput({
    pool: { name: 'tank', totalBandwidthMBps: 90, minWriteBandwidthMBps: 80 },
    scrub: { active: true, vdevId: 'vdev-1', totalRegions: 8, completedRegions: [], regionSizeMB: 64, maxRateMBps: 150 },
  });
  const plan = planRound(input);
  const write = plan.tasks.find((task) => task.type === 'normal-write');
  assert.equal(write.bandwidthMBps, 80, '普通写入必须拿到最低保障带宽');
  const resilver = plan.tasks.find((task) => task.type === 'resilver');
  assert.equal(resilver.bandwidthMBps, 10);
  assert.ok(plan.warnings.some((warning) => warning.includes('带宽不足')));
  const scrub = plan.tasks.find((task) => task.type === 'scrub');
  assert.equal(scrub.bandwidthMBps, 0, '带宽不足时 scrub 暂停');
});

test('带宽不足: 总带宽低于写入最低保障时警告且不出现负预算', () => {
  const input = baseInput({
    pool: { name: 'tank', totalBandwidthMBps: 50, minWriteBandwidthMBps: 80 },
  });
  const plan = planRound(input);
  assert.equal(plan.bandwidthMBps.backgroundBudget, 0);
  assert.ok(plan.warnings.some((warning) => warning.includes('低于普通写入最低保障')));
  const resilver = plan.tasks.find((task) => task.type === 'resilver');
  assert.equal(resilver.bandwidthMBps, 0);
});
