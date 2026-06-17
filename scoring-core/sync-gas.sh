#!/bin/zsh
# 採点コアを GAS 配布ファイル (gas/CheqScoring.gs) へ同期する
set -eu
cd "$(dirname "$0")"
{
  echo "// =================================================================="
  echo "// 自動生成: scoring-core/src/cheqScoring.js が正本。直接編集しないこと。"
  echo "// 更新方法: scoring-core でテストを通した後、このファイルへコピーする。"
  echo "//   cd scoring-core && pnpm test && ./sync-gas.sh"
  echo "// =================================================================="
  cat src/cheqScoring.js
} > ../gas/CheqScoring.gs
echo "synced -> gas/CheqScoring.gs"
