// index.ts
import dotenv from "dotenv";
dotenv.config();
import os from "os";
import { exec } from "child_process";
import io from "@pm2/io";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { checkAndUpdateRepo } from "./git-checker";

const execAsync = promisify(exec);
const INTERVAL = 60 * 1000; // 1分間隔
const RETENTION = 60 * 60 * 1000; // 1時間保持
const DATA_FILE = path.join(process.cwd(), "server-monitor-data.json"); // データ保存ファイル

// データ型定義
type MetricData = { timestamp: number; value: number };
type StoreType = {
  cpu: MetricData[];
  ram: MetricData[];
  disk: MetricData[];
  diskGrowth: number;
};

// 測定データストア（デフォルト値）
let store: StoreType = {
  cpu: [],
  ram: [],
  disk: [],
  diskGrowth: 0,
};

// ファイルからデータを読み込む
function loadDataFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf8");
      const parsedData = JSON.parse(data) as StoreType;

      // 古いデータをフィルタリング
      const cutoff = Date.now() - RETENTION;
      Object.keys(parsedData).forEach((key) => {
        if (
          key !== "diskGrowth" &&
          Array.isArray(parsedData[key as keyof StoreType])
        ) {
          (parsedData[key as "cpu" | "ram" | "disk"] as MetricData[]) = (
            parsedData[key as "cpu" | "ram" | "disk"] as MetricData[]
          ).filter((m) => m.timestamp >= cutoff);
        }
      });

      store = parsedData;
      console.log("データファイルを読み込みました");
    }
  } catch (error) {
    console.error("データ読み込みエラー:", error);
    // エラー時はデフォルト値を使用（既に設定済み）
  }
}

// ファイルにデータを保存
function saveDataToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store), "utf8");
  } catch (error) {
    console.error("データ保存エラー:", error);
  }
}

// PM2メトリクス
const metrics = {
  cpuMax: io.metric({ name: "CPU最高値" }),
  cpuAvg: io.metric({ name: "CPU平均値" }),
  ramMax: io.metric({ name: "RAM最高値" }),
  ramAvg: io.metric({ name: "RAM平均値" }),
  disk: io.metric({ name: "ディスク瞬間値" }),
  diskGrowth: io.metric({ name: "ディスク増加量" }),
};

// CPU使用率計測用の前回値
let lastCpuInfo = os.cpus().map((cpu) => ({
  idle: cpu.times.idle,
  total: Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
}));

// CPU使用率取得
async function getCpuUsage() {
  const cpuInfo = os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
  }));

  const usages = cpuInfo.map((info, i) => {
    const idleDiff = info.idle - lastCpuInfo[i].idle;
    const totalDiff = info.total - lastCpuInfo[i].total;
    return totalDiff > 0 ? 100 - (idleDiff / totalDiff) * 100 : 0;
  });

  lastCpuInfo = cpuInfo;
  return usages.reduce((sum, usage) => sum + usage, 0) / usages.length;
}

// メモリ使用率取得
const getRamUsage = () =>
  ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;

// ディスク使用率取得
async function getDiskUsage() {
  try {
    const { stdout } = await execAsync("df -k / | tail -1 | awk '{print $5}'");
    return parseInt(stdout.trim().replace("%", ""));
  } catch (error) {
    console.error("ディスク使用率取得エラー:", error);
    return 0;
  }
}

// ディスク合計容量（GB）取得
async function getDiskSizeGB() {
  try {
    // 合計ディスク容量（KB）を取得して GB に変換
    const { stdout } = await execAsync("df -k / | tail -1 | awk '{print $2}'");
    return parseInt(stdout.trim()) / (1024 * 1024); // KB から GB へ変換
  } catch (error) {
    console.error("ディスク容量取得エラー:", error);
    return 0;
  }
}

// データを更新
async function update() {
  try {
    const now = Date.now();
    const [cpu, ram, disk, diskSizeGB] = await Promise.all([
      getCpuUsage(),
      getRamUsage(),
      getDiskUsage(),
      getDiskSizeGB(),
    ]);

    // 測定値を保存
    store.cpu.push({ timestamp: now, value: cpu });
    store.ram.push({ timestamp: now, value: ram });

    // ディスク増加率計算（% から GB に変換）
    if (store.disk.length > 0) {
      const lastDisk = store.disk[store.disk.length - 1];
      const hoursDiff = (now - lastDisk.timestamp) / (1000 * 60 * 60);
      if (hoursDiff > 0) {
        // 百分率の差分を実際のGB値に変換
        const percentDiff = disk - lastDisk.value;
        store.diskGrowth = ((percentDiff / 100) * diskSizeGB) / hoursDiff; // GB/時間単位
      }
    }

    store.disk.push({ timestamp: now, value: disk });

    // 古いデータを削除
    const cutoff = now - RETENTION;
    Object.keys(store).forEach((key) => {
      if (
        key !== "diskGrowth" &&
        Array.isArray(store[key as keyof StoreType])
      ) {
        (store[key as "cpu" | "ram" | "disk"] as MetricData[]) = (
          store[key as "cpu" | "ram" | "disk"] as MetricData[]
        ).filter((m) => m.timestamp >= cutoff);
      }
    });

    // 統計計算
    const cpuValues = store.cpu.map((m) => m.value);
    const cpuMax = cpuValues.length ? Math.max(...cpuValues) : 0;
    const cpuAvg = cpuValues.length
      ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
      : 0;

    const ramValues = store.ram.map((m) => m.value);
    const ramMax = ramValues.length ? Math.max(...ramValues) : 0;
    const ramAvg = ramValues.length
      ? ramValues.reduce((a, b) => a + b, 0) / ramValues.length
      : 0;

    // メトリクス更新（数値のまま）
    metrics.cpuMax.set(roundInt(cpuMax));
    metrics.cpuAvg.set(roundInt(cpuAvg));
    metrics.ramMax.set(roundInt(ramMax));
    metrics.ramAvg.set(roundInt(ramAvg));
    metrics.disk.set(roundInt(disk));
    metrics.diskGrowth.set(roundRawNum(store.diskGrowth));

    // データをファイルに保存（一定間隔で保存）
    saveDataToFile();

    console.debug(
      `更新: CPU=${formatIntWithPercent(cpu)}, RAM=${formatIntWithPercent(
        ram
      )}, Disk=${formatIntWithPercent(disk)}`
    );
  } catch (error) {
    console.error("更新エラー:", error);
  }
}

// 小数点1桁に丸める（数値を返す）
const roundRawNum = (n: number): number => Math.round(n * 10) / 10;

// 整数に丸める（数値を返す）
const roundInt = (n: number): number => Math.round(n);

// 整数に丸めて%を付加（文字列を返す）
const formatIntWithPercent = (n: number): string => `${roundInt(n)}%`;

// GB単位表示用フォーマット（文字列を返す）
const formatGrowthGB = (n: number): string => {
  let prefix;
  if (Math.abs(n) < 0.05) {
    // 絶対値が小さい場合は±0として扱う
    return "±0 GB";
  } else if (n > 0) {
    prefix = "+ "; // 正の値には「+ 」を付加（スペースあり）
  } else {
    prefix = "- "; // 負の値には「- 」を付加（スペースあり）
    n = Math.abs(n); // 負の値の場合は絶対値にする
  }
  return `${prefix}${roundRawNum(n)} GB`;
};

// 統計を計算
function getStats() {
  // CPU統計
  const cpuValues = store.cpu.map((m) => m.value);
  const cpuMax = cpuValues.length ? Math.max(...cpuValues) : 0;
  const cpuAvg = cpuValues.length
    ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length
    : 0;
  const cpuLatestTimestamp = store.cpu.length
    ? store.cpu[store.cpu.length - 1].timestamp
    : 0;

  // RAM統計
  const ramValues = store.ram.map((m) => m.value);
  const ramMax = ramValues.length ? Math.max(...ramValues) : 0;
  const ramAvg = ramValues.length
    ? ramValues.reduce((a, b) => a + b, 0) / ramValues.length
    : 0;
  const ramLatestTimestamp = store.ram.length
    ? store.ram[store.ram.length - 1].timestamp
    : 0;

  // ディスク統計
  const diskValues = store.disk.map((m) => m.value);
  const diskCurrent = diskValues.length ? diskValues[diskValues.length - 1] : 0;
  const diskLatestTimestamp = store.disk.length
    ? store.disk[store.disk.length - 1].timestamp
    : 0;

  return {
    cpu: {
      max: formatIntWithPercent(cpuMax),
      avg: formatIntWithPercent(cpuAvg),
      count: store.cpu.length,
      timestamp: cpuLatestTimestamp,
    },
    ram: {
      max: formatIntWithPercent(ramMax),
      avg: formatIntWithPercent(ramAvg),
      count: store.ram.length,
      timestamp: ramLatestTimestamp,
    },
    disk: {
      current: formatIntWithPercent(diskCurrent),
      growth: formatGrowthGB(store.diskGrowth),
      count: store.disk.length,
      timestamp: diskLatestTimestamp,
    },
  };
}

// 定期更新開始
loadDataFromFile(); // 起動時にデータを読み込む
const interval = setInterval(update, INTERVAL);
update(); // 初回実行

// APIサーバー設定
Bun.serve({
  port: 8731,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/server-monitor") {
      // APIアクセス時にGitリポジトリの更新を確認
      const updated = await checkAndUpdateRepo();

      // 更新があった場合、データを再収集して最新情報を返す
      if (updated) {
        await update();
      }

      return new Response(JSON.stringify(getStats()), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// プロセス終了時のクリーンアップ
process.on("SIGINT", () => {
  saveDataToFile(); // 終了時にデータを保存
  clearInterval(interval);
  process.exit(0);
});

process.on("SIGTERM", () => {
  saveDataToFile(); // 終了時にデータを保存
  clearInterval(interval);
  process.exit(0);
});

console.log(`サーバーモニタリングサーバー起動: http://localhost:8731`);

/*
 * /server-monitor エンドポイントのレスポンス例:
 *
 * {
 *   "cpu": {
 *     "max": "79%",         // 測定期間内の最大CPU使用率 (%)
 *     "avg": "22%",         // 測定期間内の平均CPU使用率 (%)
 *     "count": 60,          // 記録されているCPU使用率データの件数
 *     "timestamp": 1678901234567 // CPU最新データのタイムスタンプ (ミリ秒)
 *   },
 *   "ram": {
 *     "max": "75%",         // 測定期間内の最大メモリ使用率 (%)
 *     "avg": "62%",         // 測定期間内の平均メモリ使用率 (%)
 *     "count": 60,          // 記録されているメモリ使用率データの件数
 *     "timestamp": 1678901234567 // RAM最新データのタイムスタンプ (ミリ秒)
 *   },
 *   "disk": {
 *     "current": "44%",     // 現在のディスク使用率 (%)
 *     "growth": "+ 0.2 GB", // 1時間あたりのディスク使用量増加 (GB)
 *     "count": 60,          // 記録されているディスク使用率データの件数
 *     "timestamp": 1678901234567 // ディスク最新データのタイムスタンプ (ミリ秒)
 *   }
 * }
 */
