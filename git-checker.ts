// git-checker.ts
// Gitリポジトリの更新を確認し、必要に応じてpullするモジュール

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);
const REPO_PATH = process.cwd(); // 現在のディレクトリ（必要に応じて変更）
const LOG_FILE = path.join(REPO_PATH, "git-auto-update.log");

// 最後の更新確認時刻（APIアクセスごとに更新しすぎないようにする）
let lastCheckTime = 0;
const CHECK_INTERVAL_MIN = 5 * 60 * 1000; // 最低5分間隔で確認

// ログ関数
function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  console.log(logMessage.trim());
  fs.appendFileSync(LOG_FILE, logMessage);
}

// Gitコマンド実行関数
async function execGitCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, { cwd: REPO_PATH });
    return stdout.trim();
  } catch (error) {
    log(
      `Gitコマンドエラー: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

// Gitリポジトリの更新を確認して必要ならpull
export async function checkAndUpdateRepo(): Promise<boolean> {
  // 前回のチェックから一定時間経過していない場合はスキップ
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MIN) {
    return false;
  }
  lastCheckTime = now;

  log("リモートの更新を確認しています...");

  // まず、リモートの最新情報を取得
  const remoteUpdate = await execGitCommand("git remote update");
  if (remoteUpdate === null) {
    log("リモート更新の取得に失敗しました。次回のアクセスで再試行します。");
    return false;
  }

  // 現在のHEADのハッシュを取得
  const localHash = await execGitCommand("git rev-parse HEAD");

  // リモートのoriginブランチの最新ハッシュを取得
  const localBranch = await execGitCommand("git rev-parse --abbrev-ref HEAD");
  if (!localBranch) {
    log("ローカルブランチの取得に失敗しました。次回のアクセスで再試行します。");
    return false;
  }

  const remoteBranch = `origin/${localBranch}`;
  const remoteHash = await execGitCommand(`git rev-parse ${remoteBranch}`);

  if (!localHash || !remoteHash) {
    log("ハッシュの取得に失敗しました。次回のアクセスで再試行します。");
    return false;
  }

  // ハッシュを比較
  if (localHash !== remoteHash) {
    log("リモートに更新があります。プル操作を開始します...");

    // 変更が見つかったらpull
    const pullResult = await execGitCommand("git pull");

    if (pullResult) {
      log(`プル成功: ${pullResult}`);
      return true; // 更新があった
    } else {
      log("プル操作に失敗しました");
      return false;
    }
  } else {
    log("リモートに更新はありません");
    return false;
  }
}
