// 负载监测（长链与发布性能测试共用）：每 5 s 采样一次整机 CPU、可用内存与占用最高的前 5 个外部进程。
// “外部”不含本脚本（node）及其子进程、本轮 Oris 测试实例进程树。只读查询性能计数器，不结束、不调整任何进程。
// 判定：外部进程合计 CPU 超过阈值（默认 10%）并持续 ≥ 10 s（连续两个 5 s 采样）→ 该时间段数据作废，需要重测。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 与 gui-lib 相同，经 `powershell -Command` 传入（不写脚本文件、不改执行策略）；参数通过环境变量传递。
const SCRIPT = String.raw`
$NodePid = [int]$env:ORIS_MONITOR_NODE_PID; $PidFile = $env:ORIS_MONITOR_PID_FILE; $Interval = [int]$env:ORIS_MONITOR_INTERVAL
$ErrorActionPreference = 'SilentlyContinue'
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$prev = @{}; $prevStamp = $null; $prevCpu = $null
while ($true) {
  $raw = Get-CimInstance Win32_PerfRawData_PerfProc_Process
  $cpuRaw = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
  $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
  $roots = @($NodePid, $PID)
  if (Test-Path $PidFile) { $roots += @(Get-Content $PidFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
  $children = @{}
  foreach ($p in $raw) { $parent = [int]$p.CreatingProcessID; if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }; [void]$children[$parent].Add([int]$p.IDProcess) }
  $own = New-Object 'System.Collections.Generic.HashSet[int]'
  $stack = New-Object System.Collections.Stack; foreach ($r in $roots) { $stack.Push([int]$r) }
  while ($stack.Count) { $n = $stack.Pop(); if ($own.Add($n) -and $children.ContainsKey($n)) { foreach ($c in $children[$n]) { if ($c -ne $n) { $stack.Push($c) } } } }
  $stamp = [int64]($raw | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1).Timestamp_Sys100NS
  $rows = @()
  if ($prevStamp) {
    $elapsed = [double]($stamp - $prevStamp)
    foreach ($p in $raw) {
      if ($p.Name -eq '_Total' -or $p.Name -eq 'Idle' -or [int]$p.IDProcess -eq 0) { continue }
      $key = "$($p.IDProcess):$($p.Name)"
      $now = [int64]$p.PercentProcessorTime
      if ($prev.ContainsKey($key) -and $elapsed -gt 0) {
        $pct = 100.0 * ($now - $prev[$key]) / $elapsed / $cores
        if ($pct -gt 0.05) { $rows += [pscustomobject]@{ pid = [int]$p.IDProcess; name = $p.Name; cpu = [math]::Round($pct, 2); own = $own.Contains([int]$p.IDProcess) } }
      }
    }
  }
  $cpu = $null
  if ($prevCpu) {
    $dt = [double]([int64]$cpuRaw.Timestamp_Sys100NS - $prevCpu.stamp)
    if ($dt -gt 0) { $cpu = [math]::Round(100.0 * (1 - ([int64]$cpuRaw.PercentProcessorTime - $prevCpu.idle) / $dt), 2) }
  }
  $prev = @{}; foreach ($p in $raw) { $prev["$($p.IDProcess):$($p.Name)"] = [int64]$p.PercentProcessorTime }
  $prevStamp = $stamp; $prevCpu = @{ stamp = [int64]$cpuRaw.Timestamp_Sys100NS; idle = [int64]$cpuRaw.PercentProcessorTime }
  if ($cpu -ne $null) {
    $external = @($rows | Where-Object { -not $_.own })
    $ownRows = @($rows | Where-Object { $_.own })
    $sum = 0.0; foreach ($r in $external) { $sum += $r.cpu }
    $ownSum = 0.0; foreach ($r in $ownRows) { $ownSum += $r.cpu }
    $json = [pscustomobject]@{ at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); cpu = $cpu; freeMiB = [math]::Round($free / 1024, 0); externalCpu = [math]::Round($sum, 2); ownCpu = [math]::Round($ownSum, 2); top = @($external | Sort-Object cpu -Descending | Select-Object -First 5 pid, name, cpu) } | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json); [Console]::Out.Flush()
  }
  Start-Sleep -Seconds $Interval
}
`;

export function startLoadMonitor({ intervalSec = 5, threshold = 10, log = () => {} } = {}) {
  const dir = path.join(tmpdir(), "oris-load-monitor");
  mkdirSync(dir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const pidFile = path.join(dir, `pids-${stamp}.txt`);
  writeFileSync(pidFile, "");
  const env = { ...process.env, ORIS_MONITOR_NODE_PID: String(process.pid), ORIS_MONITOR_PID_FILE: pidFile, ORIS_MONITOR_INTERVAL: String(intervalSec) };
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env });
  const samples = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      try {
        const sample = JSON.parse(line);
        if (!Array.isArray(sample.top)) sample.top = sample.top ? [sample.top] : [];
        samples.push(sample);
        if (sample.externalCpu > threshold) log(`负载：外部进程合计 ${sample.externalCpu}%（${sample.top.map((p) => `${p.name}:${p.cpu}`).join(", ")}）`);
      } catch { /* 忽略不完整的行 */ }
    }
  });
  const pids = new Set();
  const writePids = () => writeFileSync(pidFile, [...pids].join("\n"));
  return {
    samples,
    /** 登记本轮 Oris 测试实例（其子进程随进程树一起排除）。 */
    addOwnPid(pid) { pids.add(pid); writePids(); },
    removeOwnPid(pid) { pids.delete(pid); writePids(); },
    /** [from, to] 期间（毫秒时间戳）是否受外部负载干扰：连续两个采样超过阈值。 */
    disturbance(from, to) {
      const within = samples.filter((s) => s.at >= from && s.at <= to + intervalSec * 1000);
      for (let i = 1; i < within.length; i++) {
        if (within[i - 1].externalCpu > threshold && within[i].externalCpu > threshold) return { disturbed: true, samples: within };
      }
      return { disturbed: false, samples: within };
    },
    summary(from = 0, to = Infinity) {
      const within = samples.filter((s) => s.at >= from && s.at <= to);
      const ext = within.map((s) => s.externalCpu).sort((a, b) => a - b);
      const cpu = within.map((s) => s.cpu).sort((a, b) => a - b);
      const pick = (list, p) => list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] : null;
      const offenders = new Map();
      for (const s of within) for (const p of s.top) { const e = offenders.get(p.name) ?? { name: p.name, maxCpu: 0, samples: 0 }; e.maxCpu = Math.max(e.maxCpu, p.cpu); e.samples++; offenders.set(p.name, e); }
      return {
        samples: within.length, intervalSec, threshold,
        machineCpu: { p50: pick(cpu, 0.5), p95: pick(cpu, 0.95), max: cpu.at(-1) ?? null },
        externalCpu: { p50: pick(ext, 0.5), p95: pick(ext, 0.95), max: ext.at(-1) ?? null },
        overThreshold: within.filter((s) => s.externalCpu > threshold).length,
        topExternal: [...offenders.values()].sort((a, b) => b.maxCpu - a.maxCpu).slice(0, 8),
        minFreeMiB: within.length ? Math.min(...within.map((s) => s.freeMiB)) : null
      };
    },
    stop() { try { child.kill(); } catch { /* 已退出 */ } try { rmSync(pidFile, { force: true }); } catch { /* 忽略 */ } }
  };
}

/**
 * 在负载监测下运行一个测量段；受干扰时重测，最多重测 `retries` 次。
 * 返回 { result, attempts: [{ from, to, disturbed }], verdict: "ok" | "disturbed" }。
 */
export async function measuredSegment(monitor, name, run, { retries = 2, log = () => {}, settleMs = 6000 } = {}) {
  const attempts = [];
  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const from = Date.now();
    result = await run(attempt);
    const to = Date.now();
    // 等下一次采样覆盖到段末尾。
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const { disturbed, samples } = monitor.disturbance(from, to);
    attempts.push({ attempt, from, to, disturbed, maxExternalCpu: samples.length ? Math.max(...samples.map((s) => s.externalCpu)) : null, samples: samples.length });
    if (!disturbed) return { result, attempts, verdict: "ok" };
    log(`${name}：第 ${attempt + 1} 次测量受外部负载干扰${attempt < retries ? "，重测" : "，已达重测上限"}`);
  }
  return { result, attempts, verdict: "disturbed" };
}
