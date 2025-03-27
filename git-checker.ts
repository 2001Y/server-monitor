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

// 日本時間（JST）のタイムスタンプを取得する関数
function getJSTTimestamp(): string {
  const now = new Date();
  // JSTはUTC+9時間
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  // JST時間をISO形式で表示（Z（UTC表記）を削除しJSTを追加）
  return jstDate.toISOString().replace("Z", "+09:00");
}

// ログ関数
function log(message: string): void {
  const timestamp = getJSTTimestamp();
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

// ブランチが分岐している場合のみ、強制的に最新状態に更新する
// この関数は、ローカルに未コミットの変更がないことが確認された後のみ呼び出される
async function forceUpdateDivergentBranch(): Promise<boolean> {
  try {
    // リモートから最新情報を取得し、強制的に上書き
    const result = await execAsync(
      "git fetch && git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)",
      {
        cwd: REPO_PATH,
      }
    );
    log(`ブランチ強制更新成功: ${result.stdout.trim()}`);
    return true;
  } catch (error) {
    log(
      `ブランチ強制更新失敗: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
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

    // ワーキングツリーの状態を確認（ローカルの変更があるか）
    const statusResult = await execGitCommand("git status --porcelain");
    const hasLocalChanges = statusResult && statusResult.length > 0;

    if (hasLocalChanges) {
      log(`ローカルに変更があります: ${statusResult}`);
      log("ローカルの変更を保護するため、自動更新を中止します。");
      log("手動でローカルの変更を処理した後、更新を再試行してください。");
      return false; // ローカルの変更がある場合は何もせずに終了
    }

    // 変更が見つかったらまずpullを試みる（通常の方法）
    const pullResult = await execGitCommand("git pull");

    if (pullResult) {
      log(`プル成功: ${pullResult}`);
      return true; // 更新があった
    } else {
      log(
        "通常のプル操作に失敗しました。ブランチの分岐が原因の可能性があります。"
      );

      // pullの失敗理由を確認
      const statusOutput = await execGitCommand("git status -b --porcelain=v2");

      if (statusOutput && statusOutput.includes("diverged")) {
        log("ブランチが分岐しています。マージ戦略を設定して再試行します。");

        // pull戦略を設定
        await execGitCommand("git config pull.rebase false");

        // 再度pullを試行
        const secondPullResult = await execGitCommand("git pull");

        if (secondPullResult) {
          log(`設定変更後のプル成功: ${secondPullResult}`);
          return true;
        } else {
          log(
            "ブランチ分岐の解決に失敗しました。最終手段としてブランチリセットを試みます。"
          );

          // 最後の手段としてブランチリセット（ローカルの未コミット変更がないことは確認済み）
          return await forceUpdateDivergentBranch();
        }
      } else {
        log("不明な理由でプルに失敗しました。手動での対応が必要です。");
        return false;
      }
    }
  } else {
    log("リモートに更新はありません");
    return false;
  }
}
