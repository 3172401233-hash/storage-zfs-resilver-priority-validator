'use strict';

const { planRound } = require('./scheduler');

const scenario = {
  pool: { name: 'tank', totalBandwidthMBps: 400, minWriteBandwidthMBps: 80 },
  vdevs: [
    { id: 'vdev-0', faultDomain: 'fd-a', state: 'degraded' },
    { id: 'vdev-1', faultDomain: 'fd-a', state: 'degraded' },
    { id: 'vdev-2', faultDomain: 'fd-b', state: 'online' },
  ],
  resilvers: [
    {
      vdevId: 'vdev-0',
      totalRegions: 16,
      completedRegions: [0, 1, 2, 3, 4],
      regionSizeMB: 64,
      maxRateMBps: 200,
    },
    {
      vdevId: 'vdev-1',
      totalRegions: 16,
      completedRegions: [0, 1],
      regionSizeMB: 64,
      maxRateMBps: 200,
    },
  ],
  scrub: {
    active: true,
    vdevId: 'vdev-2',
    totalRegions: 16,
    completedRegions: [0, 1, 2],
    regionSizeMB: 64,
    maxRateMBps: 150,
  },
  io: { writeDemandMBps: 60, latencyMs: 8 },
  hotness: {
    'vdev-0': { 5: 0.95, 6: 0.8, 9: 0.4, 12: 0.1 },
    'vdev-1': { 3: 0.7, 8: 0.2 },
  },
};

const plan = planRound(scenario);

console.log(`池: ${plan.pool} (模拟)  轮次时长: ${plan.roundSeconds}s`);
console.log('带宽分配 (MB/s):', JSON.stringify(plan.bandwidthMBps));
console.log('\n后台任务顺序:');
for (const [index, task] of plan.tasks.entries()) {
  const detail = task.regions ? ` regions=[${task.regions.join(',')}]` : '';
  const reason = task.reason ? ` (${task.reason})` : '';
  console.log(
    `  ${index + 1}. ${task.type} vdev=${task.vdevId || '-'} ` +
      `bw=${task.bandwidthMBps} MB/s${detail}${reason}`,
  );
}
console.log('\n仍脆弱的数据范围:');
for (const vulnerable of plan.vulnerableRanges) {
  console.log(
    `  ${vdevLabel(vulnerable)} 剩余 ${vulnerable.remainingRegions}/${vulnerable.totalRegions} 区域`,
  );
  for (const range of vulnerable.ranges) {
    console.log(
      `    region ${range.region} offset=${range.offsetMB}MB size=${range.sizeMB}MB heat=${range.heat}`,
    );
  }
}
if (plan.warnings.length > 0) {
  console.log('\n警告:');
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);
}

function vdevLabel(vulnerable) {
  return `${vulnerable.vdevId} (${vulnerable.faultDomain})`;
}
