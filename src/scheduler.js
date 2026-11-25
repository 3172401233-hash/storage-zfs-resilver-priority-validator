'use strict';

const DEFAULTS = {
  roundSeconds: 10,
  maxRecoveryPerFaultDomain: 1,
  minResilverBandwidthMBps: 20,
};

function toRegionSet(regions) {
  return new Set(regions || []);
}

function remainingRegions(totalRegions, completedRegions) {
  const done = toRegionSet(completedRegions);
  const remaining = [];
  for (let region = 0; region < totalRegions; region += 1) {
    if (!done.has(region)) remaining.push(region);
  }
  return remaining;
}

function heatOf(hotness, vdevId, region) {
  const table = hotness && hotness[vdevId];
  if (!table) return 0;
  const value = table[region];
  return typeof value === 'number' ? value : 0;
}

function regionsPerRound(bandwidthMBps, regionSizeMB, roundSeconds) {
  if (regionSizeMB <= 0) return 0;
  return Math.floor((bandwidthMBps * roundSeconds) / regionSizeMB);
}

function pickHottestFirst(regions, hotness, vdevId, count) {
  const sorted = [...regions].sort((a, b) => {
    const delta = heatOf(hotness, vdevId, b) - heatOf(hotness, vdevId, a);
    return delta !== 0 ? delta : a - b;
  });
  return sorted.slice(0, Math.max(0, count));
}

/**
 * 计算单轮后台任务预算。
 *
 * input: {
 *   pool: { name, totalBandwidthMBps, minWriteBandwidthMBps },
 *   vdevs: [{ id, faultDomain, state }],
 *   resilvers: [{ vdevId, totalRegions, completedRegions, regionSizeMB, maxRateMBps }],
 *   scrub: { active, vdevId, totalRegions, completedRegions, regionSizeMB, maxRateMBps },
 *   io: { writeDemandMBps, latencyMs },
 *   hotness: { [vdevId]: { [region]: heat } },
 *   limits: { maxRecoveryPerFaultDomain, minResilverBandwidthMBps, roundSeconds }
 * }
 */
function planRound(input) {
  const limits = { ...DEFAULTS, ...(input.limits || {}) };
  const warnings = [];
  const tasks = [];
  const { pool, io } = input;
  const vdevById = new Map(input.vdevs.map((vdev) => [vdev.id, vdev]));

  const writeReserveMBps = Math.max(pool.minWriteBandwidthMBps, 0);
  const writeAllocatedMBps = Math.min(writeReserveMBps, pool.totalBandwidthMBps);
  if (pool.totalBandwidthMBps < writeReserveMBps) {
    warnings.push(
      `带宽不足: 总带宽 ${pool.totalBandwidthMBps} MB/s 低于普通写入最低保障 ${writeReserveMBps} MB/s`,
    );
  }
  const backgroundBudgetMBps = Math.max(0, pool.totalBandwidthMBps - writeAllocatedMBps);

  const activeResilvers = (input.resilvers || []).filter((resilver) => {
    const vdev = vdevById.get(resilver.vdevId);
    return vdev && vdev.state === 'degraded';
  });

  const domainCount = new Map();
  const admitted = [];
  const deferred = [];
  for (const resilver of activeResilvers) {
    const vdev = vdevById.get(resilver.vdevId);
    const count = domainCount.get(vdev.faultDomain) || 0;
    if (count >= limits.maxRecoveryPerFaultDomain) {
      deferred.push(resilver);
    } else {
      domainCount.set(vdev.faultDomain, count + 1);
      admitted.push(resilver);
    }
  }

  admitted.sort((a, b) => {
    const aRemaining = remainingRegions(a.totalRegions, a.completedRegions);
    const bRemaining = remainingRegions(b.totalRegions, b.completedRegions);
    const aHeat = aRemaining.reduce((sum, r) => sum + heatOf(input.hotness, a.vdevId, r), 0);
    const bHeat = bRemaining.reduce((sum, r) => sum + heatOf(input.hotness, b.vdevId, r), 0);
    return bHeat - aHeat;
  });

  let budgetLeftMBps = backgroundBudgetMBps;
  const resilverAllocations = [];
  for (const resilver of admitted) {
    const remaining = remainingRegions(resilver.totalRegions, resilver.completedRegions);
    if (remaining.length === 0) continue;
    const allocated = Math.max(0, Math.min(resilver.maxRateMBps, budgetLeftMBps));
    resilverAllocations.push({ resilver, remaining, allocatedMBps: allocated });
    budgetLeftMBps -= allocated;
    if (allocated < limits.minResilverBandwidthMBps) {
      warnings.push(
        `带宽不足: vdev ${resilver.vdevId} 的 resilver 仅分到 ${allocated} MB/s，` +
          `低于最低恢复速率 ${limits.minResilverBandwidthMBps} MB/s`,
      );
    }
  }

  for (const { resilver, remaining, allocatedMBps } of resilverAllocations) {
    const count = regionsPerRound(allocatedMBps, resilver.regionSizeMB, limits.roundSeconds);
    const regions = pickHottestFirst(remaining, input.hotness, resilver.vdevId, count);
    tasks.push({
      type: 'resilver',
      vdevId: resilver.vdevId,
      faultDomain: vdevById.get(resilver.vdevId).faultDomain,
      bandwidthMBps: allocatedMBps,
      regions,
    });
  }

  for (const resilver of deferred) {
    const vdev = vdevById.get(resilver.vdevId);
    tasks.push({
      type: 'deferred-resilver',
      vdevId: resilver.vdevId,
      faultDomain: vdev.faultDomain,
      bandwidthMBps: 0,
      regions: [],
      reason: `故障域 ${vdev.faultDomain} 并发恢复任务已达上限 ${limits.maxRecoveryPerFaultDomain}`,
    });
  }

  const scrub = input.scrub;
  if (scrub && scrub.active) {
    const scrubRemaining = remainingRegions(scrub.totalRegions, scrub.completedRegions);
    const allocated = Math.max(0, Math.min(scrub.maxRateMBps, budgetLeftMBps));
    if (scrubRemaining.length === 0) {
      tasks.push({ type: 'scrub', vdevId: scrub.vdevId, bandwidthMBps: 0, regions: [], reason: 'scrub 已完成，不重复扫描' });
    } else if (allocated <= 0) {
      tasks.push({ type: 'scrub', vdevId: scrub.vdevId, bandwidthMBps: 0, regions: [], reason: 'resilver 优先，scrub 本轮暂停' });
    } else {
      const count = regionsPerRound(allocated, scrub.regionSizeMB, limits.roundSeconds);
      tasks.push({
        type: 'scrub',
        vdevId: scrub.vdevId,
        bandwidthMBps: allocated,
        regions: scrubRemaining.slice(0, count),
      });
    }
    budgetLeftMBps -= allocated;
  }

  tasks.push({
    type: 'normal-write',
    bandwidthMBps: writeAllocatedMBps,
    demandMBps: io.writeDemandMBps,
    latencyMs: io.latencyMs,
  });

  const vulnerableRanges = [];
  for (const resilver of activeResilvers) {
    const remaining = remainingRegions(resilver.totalRegions, resilver.completedRegions);
    if (remaining.length === 0) continue;
    const vdev = vdevById.get(resilver.vdevId);
    const ranges = remaining
      .map((region) => ({
        region,
        heat: heatOf(input.hotness, resilver.vdevId, region),
        offsetMB: region * resilver.regionSizeMB,
        sizeMB: resilver.regionSizeMB,
      }))
      .sort((a, b) => (b.heat - a.heat) || (a.region - b.region));
    vulnerableRanges.push({
      vdevId: resilver.vdevId,
      faultDomain: vdev.faultDomain,
      remainingRegions: remaining.length,
      totalRegions: resilver.totalRegions,
      ranges,
    });
  }

  return {
    pool: pool.name,
    roundSeconds: limits.roundSeconds,
    bandwidthMBps: {
      total: pool.totalBandwidthMBps,
      normalWrite: writeAllocatedMBps,
      backgroundBudget: backgroundBudgetMBps,
      unallocated: Math.max(0, budgetLeftMBps),
    },
    tasks,
    vulnerableRanges,
    warnings,
  };
}

module.exports = { planRound, remainingRegions, DEFAULTS };
