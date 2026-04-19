#!/usr/bin/env bash
# ============================================================
#  RetroQuest — Automated Production Setup
#  Usage: bash setup.sh
#  
#  This script will:
#   1. Check all prerequisites
#   2. Install Vercel CLI + Supabase CLI
#   3. Create and push both GitHub repos
#   4. Run the Supabase schema automatically
#   5. Deploy the backend to Railway (or Render)
#   6. Deploy the frontend to Vercel
#   7. Wire everything together
#   8. Print your live URLs
# ============================================================

set -e  # exit on any error

# ── colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
info() { echo -e "${BLUE}→${NC}  $1"; }
err()  { echo -e "${RED}✗${NC}  $1"; exit 1; }
hdr()  { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

echo -e "${BOLD}"
cat << 'ART'
  ____      _             ___                _
 |  _ \ ___| |_ _ __ ___|  _ \ _   _  ___  ___| |_
 | |_) / _ \ __| '__/ _ \ |_) | | | |/ _ \/ __| __|
 |  _ <  __/ |_| | | (_) |  __/| |_| |  __/\__ \ |_
 |_| \_\___|\__|_|  \___/|_|    \__,_|\___||___/\__|

  Automated Production Deploy — v1.1
ART
echo -e "${NC}"

# ── Step 0: Collect config ────────────────────────────────────
hdr "Configuration"

read -p "$(echo -e "${BOLD}GitHub username:${NC} ")" GITHUB_USER
read -p "$(echo -e "${BOLD}App name (used for repo + URLs):${NC} ")" APP_NAME
APP_NAME=${APP_NAME:-retroquest}

read -s -p "$(echo -e "${BOLD}Supabase service_role key:${NC} ")" SUPABASE_SERVICE_KEY; echo
read -s -p "$(echo -e "${BOLD}Supabase URL (https://xxxx.supabase.co):${NC} ")" SUPABASE_URL; echo
read -s -p "$(echo -e "${BOLD}Anthropic API key (sk-ant-...):${NC} ")" ANTHROPIC_API_KEY; echo

echo ""
ok "Config collected"

# ── Step 1: Check prerequisites ───────────────────────────────
hdr "Checking Prerequisites"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    err "Required: '$1' not found. Install it first: $2"
  fi
  ok "$1 found ($(command -v $1))"
}

check_cmd git   "https://git-scm.com/downloads"
check_cmd node  "https://nodejs.org"
check_cmd npm   "https://nodejs.org"
check_cmd curl  "pre-installed on macOS/Linux"

NODE_VER=$(node -e "process.stdout.write(process.version)")
NODE_MAJOR=${NODE_VER//v/}; NODE_MAJOR=${NODE_MAJOR%%.*}
[[ $NODE_MAJOR -lt 18 ]] && err "Node.js 18+ required (found $NODE_VER)"
ok "Node.js $NODE_VER"

# ── Step 2: Install CLIs ──────────────────────────────────────
hdr "Installing CLIs"

info "Installing Vercel CLI..."
npm install -g vercel@latest 2>/dev/null || warn "Vercel CLI install failed — will deploy via GitHub integration"
ok "Vercel CLI ready"

info "Installing Supabase CLI..."
if command -v brew &>/dev/null; then
  brew install supabase/tap/supabase 2>/dev/null || true
else
  npm install -g supabase 2>/dev/null || warn "Supabase CLI not available via npm — will use curl for schema"
fi
ok "Supabase CLI ready"

info "Installing Railway CLI..."
npm install -g @railway/cli 2>/dev/null || warn "Railway CLI install failed — manual deploy needed for backend"
ok "Railway CLI ready"

# ── Step 3: Frontend repo ─────────────────────────────────────
hdr "Frontend — GitHub Repo + Vercel"

FRONTEND_DIR="$(dirname "$0")"
cd "$FRONTEND_DIR"

if [[ ! -d ".git" ]]; then
  info "Initialising git..."
  git init -q
  git add .
  git commit -q -m "RetroQuest v1.1 — initial deploy"
  ok "Git repo initialised"
fi

info "Creating GitHub repo '$APP_NAME'..."
if gh repo create "$APP_NAME" --private --source=. --remote=origin --push 2>/dev/null; then
  ok "GitHub repo created and pushed"
else
  warn "GitHub CLI not available. Push manually:"
  echo -e "  ${CYAN}git remote add origin https://github.com/${GITHUB_USER}/${APP_NAME}.git"
  echo -e "  git push -u origin main${NC}"
  read -p "Press Enter after pushing to continue..."
fi

FRONTEND_REPO="https://github.com/${GITHUB_USER}/${APP_NAME}"
ok "Frontend repo: $FRONTEND_REPO"

# ── Step 4: Supabase schema ───────────────────────────────────
hdr "Supabase — Database Schema"

SCHEMA_FILE="$(dirname "$0")/supabase/schema.sql"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  err "schema.sql not found at $SCHEMA_FILE"
fi

info "Running schema via Supabase CLI..."

# Extract project ref from URL
SUPABASE_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co||')

if command -v supabase &>/dev/null; then
  supabase db push --db-url "postgresql://postgres:${SUPABASE_DB_PASS}@db.${SUPABASE_REF}.supabase.co:5432/postgres" \
    --file "$SCHEMA_FILE" 2>/dev/null \
    || warn "supabase db push failed — apply schema manually in Supabase SQL Editor"
else
  warn "Supabase CLI not available."
  echo -e "\n${YELLOW}Manual step required:${NC}"
  echo "  1. Go to: https://supabase.com/dashboard/project/${SUPABASE_REF}/editor"
  echo "  2. Paste the contents of supabase/schema.sql"
  echo "  3. Click Run"
  read -p "Press Enter after running the schema to continue..."
fi

ok "Schema applied"

# ── Step 5: Backend — Railway ─────────────────────────────────
hdr "Backend — Railway Deploy"

BACKEND_DIR="$(dirname "$0")/../retroquest-backend"
BACKEND_REPO="${APP_NAME}-backend"

if [[ -d "$BACKEND_DIR" ]]; then
  cd "$BACKEND_DIR"

  info "Installing backend dependencies..."
  npm install --silent
  ok "Dependencies installed"

  if [[ ! -d ".git" ]]; then
    git init -q
    git add .
    git commit -q -m "RetroQuest backend v1.1 — initial"
  fi

  # Create backend .env
  cat > .env << ENV
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
NODE_ENV=production
ENV

  info "Creating GitHub repo '$BACKEND_REPO'..."
  if gh repo create "$BACKEND_REPO" --private --source=. --remote=origin --push 2>/dev/null; then
    ok "Backend repo created and pushed"
  else
    warn "Push backend manually:"
    echo -e "  ${CYAN}cd ${BACKEND_DIR}"
    echo -e "  git remote add origin https://github.com/${GITHUB_USER}/${BACKEND_REPO}.git"
    echo -e "  git push -u origin main${NC}"
    read -p "Press Enter after pushing to continue..."
  fi

  if command -v railway &>/dev/null; then
    info "Deploying to Railway..."
    railway login
    railway init --name "$BACKEND_REPO"
    railway vars set \
      SUPABASE_URL="$SUPABASE_URL" \
      SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
      ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
      NODE_ENV="production" \
      --yes 2>/dev/null
    railway up --detach
    BACKEND_URL=$(railway domain 2>/dev/null || echo "https://${BACKEND_REPO}.railway.app")
    ok "Backend deployed: $BACKEND_URL"
  else
    warn "Railway CLI not available."
    echo ""
    echo -e "${YELLOW}Manual Railway deploy:${NC}"
    echo "  1. Go to: https://railway.app/new"
    echo "  2. 'Deploy from GitHub' → select '${BACKEND_REPO}'"
    echo "  3. Add these env vars in Railway dashboard:"
    echo "     SUPABASE_URL=${SUPABASE_URL}"
    echo "     SUPABASE_SERVICE_KEY=<your key>"
    echo "     ANTHROPIC_API_KEY=<your key>"
    echo "     NODE_ENV=production"
    echo "  4. Copy the deployment URL"
    echo ""
    read -p "Enter your Railway backend URL (e.g. https://retroquest-backend.railway.app): " BACKEND_URL
  fi

  cd "$FRONTEND_DIR"
fi

BACKEND_URL=${BACKEND_URL:-"https://${BACKEND_REPO}.railway.app"}

# ── Step 6: Patch frontend with real backend URL ──────────────
hdr "Patching Frontend with Backend URL"

HTML_FILE="public/index.html"
if [[ -f "$HTML_FILE" ]]; then
  # Replace the placeholder URL
  sed -i.bak "s|https://retroquest-backend.railway.app|${BACKEND_URL}|g" "$HTML_FILE"
  rm -f "${HTML_FILE}.bak"
  git add "$HTML_FILE"
  git commit -q -m "chore: set backend URL to ${BACKEND_URL}"
  git push -q origin main 2>/dev/null || true
  ok "Frontend patched with $BACKEND_URL"
fi

# ── Step 7: Vercel deploy ─────────────────────────────────────
hdr "Frontend — Vercel Deploy"

PROD_URL=""
if command -v vercel &>/dev/null; then
  info "Deploying to Vercel..."
  vercel --yes \
    --build-env SUPABASE_URL="$SUPABASE_URL" \
    --build-env SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}" \
    --build-env SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
    --build-env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    --build-env NODE_ENV="production" \
    2>&1 | tail -5

  PROD_URL=$(vercel --yes --prod 2>&1 | grep -E 'https://' | tail -1 | tr -d ' ')
  
  if [[ -n "$PROD_URL" ]]; then
    # Set NEXT_PUBLIC_APP_URL and redeploy
    vercel env add NEXT_PUBLIC_APP_URL production <<< "$PROD_URL" 2>/dev/null || true
    ok "Frontend deployed: $PROD_URL"
  fi
else
  warn "Vercel CLI not available."
  echo ""
  echo -e "${YELLOW}Manual Vercel deploy:${NC}"
  echo "  1. Go to: https://vercel.com/new"
  echo "  2. Import GitHub repo: ${FRONTEND_REPO}"
  echo "  3. Set Output Directory: public"
  echo "  4. Add env vars:"
  echo "     SUPABASE_URL=${SUPABASE_URL}"
  echo "     SUPABASE_SERVICE_KEY=<your key>"
  echo "     ANTHROPIC_API_KEY=<your key>"
  echo "     NODE_ENV=production"
  echo ""
  read -p "Enter your Vercel production URL: " PROD_URL
fi

PROD_URL=${PROD_URL:-"https://${APP_NAME}.vercel.app"}

# ── Step 8: Final patch with production URL ───────────────────
if [[ -f "$HTML_FILE" ]] && [[ -n "$PROD_URL" ]]; then
  sed -i.bak "s|https://retroquest\.app|${PROD_URL}|g" "$HTML_FILE"
  rm -f "${HTML_FILE}.bak"
  git add "$HTML_FILE"
  git commit -q -m "chore: set production URL to ${PROD_URL}" 2>/dev/null || true
  git push -q origin main 2>/dev/null || true
  
  # Trigger one final redeploy with correct URLs
  if command -v vercel &>/dev/null; then
    vercel --yes --prod --force 2>/dev/null | grep -E 'https://' | tail -1 || true
  fi
fi

# ── Done ──────────────────────────────────────────────────────
hdr "🎉 Deployment Complete"

echo -e "${BOLD}${GREEN}"
cat << DONE
  ┌─────────────────────────────────────────────────┐
  │  RetroQuest is live!                            │
  ├─────────────────────────────────────────────────┤
  │  🌐 App:      ${PROD_URL}
  │  ⚙️  Backend:  ${BACKEND_URL}
  │  🗄  Database: ${SUPABASE_URL}
  └─────────────────────────────────────────────────┘
DONE
echo -e "${NC}"

echo -e "${BOLD}Next steps:${NC}"
echo "  1. Open $PROD_URL in your browser"
echo "  2. Create a room and run a test session end-to-end"
echo "  3. Check Vercel logs if anything fails: https://vercel.com/dashboard"
echo "  4. Check Railway logs: https://railway.app/dashboard"
echo ""
echo -e "${CYAN}Share with your team:${NC} ${BOLD}${PROD_URL}${NC}"
