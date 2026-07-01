#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

echo "📦 CHEQ Deployment Script"
echo "=========================="
echo ""

# Parse arguments
SKIP_WEB=false
SKIP_SCORING_API=false
SKIP_OCR_API=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-web) SKIP_WEB=true; shift ;;
    --skip-scoring-api) SKIP_SCORING_API=true; shift ;;
    --skip-ocr-api) SKIP_OCR_API=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help)
      echo "Usage: ./deploy-all.sh [options]"
      echo ""
      echo "Options:"
      echo "  --skip-web              Skip web (Pages) deployment"
      echo "  --skip-scoring-api      Skip scoring-api (Cloud Run) deployment"
      echo "  --skip-ocr-api          Skip ocr-api (Cloud Run) deployment"
      echo "  --dry-run               Print commands without executing"
      echo "  --help                  Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ "$DRY_RUN" = true ]; then
  echo "🔧 DRY RUN MODE - commands will be printed, not executed"
  echo ""
fi

# Deploy web (Pages + Functions)
if [ "$SKIP_WEB" = false ]; then
  echo "📱 Deploying web (Cloudflare Pages + Functions)..."
  if [ "$DRY_RUN" = true ]; then
    echo "   [DRY] cd web && pnpm run deploy"
  else
    cd "$REPO_ROOT/web"
    pnpm run deploy
    cd "$REPO_ROOT"
  fi
  echo "   ✅ Pages deployment complete"
  echo ""
fi

# Deploy scoring-api (Cloud Run)
if [ "$SKIP_SCORING_API" = false ]; then
  echo "🧮 Deploying scoring-api (Cloud Run)..."
  if [ "$DRY_RUN" = true ]; then
    echo "   [DRY] make -C scoring-api deploy"
  else
    make -C "$REPO_ROOT/scoring-api" deploy
  fi
  echo "   ✅ scoring-api deployment complete"
  echo ""
fi

# Deploy ocr-api (Cloud Run)
if [ "$SKIP_OCR_API" = false ]; then
  echo "🔍 Deploying ocr-api (Cloud Run)..."
  if [ "$DRY_RUN" = true ]; then
    echo "   [DRY] make -C ocr-api deploy"
  else
    make -C "$REPO_ROOT/ocr-api" deploy
  fi
  echo "   ✅ ocr-api deployment complete"
  echo ""
fi

echo "=========================="
echo "✨ All deployments complete!"
